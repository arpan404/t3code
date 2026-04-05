import { Duration, Effect, Exit, ManagedRuntime, Option, Scope, Stream } from "effect";
import { WS_METHODS } from "@ace/contracts";

import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsClientConnectionIdentity,
  type WsRpcProtocolClient,
} from "./rpc/protocol";
import { reportBackgroundError } from "./lib/async";
import { RpcClient } from "effect/unstable/rpc";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

export interface WsTransportConnectionState {
  readonly kind: "disconnected" | "reconnected";
  readonly error?: string;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const WS_CLIENT_SESSION_STORAGE_KEY = "ace.wsClientSessionId";

function createConnectionId(): string {
  return globalThis.crypto.randomUUID();
}

function resolveClientSessionId(): string {
  const storage = globalThis.window?.sessionStorage;
  const existing = storage?.getItem(WS_CLIENT_SESSION_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }
  const created = createConnectionId();
  storage?.setItem(WS_CLIENT_SESSION_STORAGE_KEY, created);
  return created;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private readonly identity: WsClientConnectionIdentity;
  private readonly connectionStateListeners = new Set<
    (state: WsTransportConnectionState) => void
  >();
  private disposed = false;
  private hasConnected = false;
  private disconnected = false;

  constructor(url?: string) {
    this.identity = {
      clientSessionId: resolveClientSessionId(),
      connectionId: createConnectionId(),
    };
    this.runtime = ManagedRuntime.make(createWsRpcProtocolLayer(url, this.identity));
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  getConnectionIdentity(): WsClientConnectionIdentity {
    return { ...this.identity };
  }

  onConnectionStateChange(listener: (state: WsTransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private emitConnectionState(state: WsTransportConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // Swallow listener errors so transport teardown remains deterministic.
      }
    }
  }

  private noteConnected(): void {
    if (!this.hasConnected) {
      this.hasConnected = true;
      this.disconnected = false;
      return;
    }
    if (!this.disconnected) {
      return;
    }
    this.disconnected = false;
    this.emitConnectionState({ kind: "reconnected" });
  }

  private noteDisconnected(error: unknown): void {
    if (!this.hasConnected || this.disconnected || this.disposed) {
      return;
    }
    this.disconnected = true;
    this.emitConnectionState({
      kind: "disconnected",
      error: formatErrorMessage(error),
    });
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const client = await this.clientPromise;
    return await this.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const client = await this.clientPromise;
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const retryDelayMs = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Effect.sync(() => {
            this.noteConnected();
          }).pipe(
            Effect.andThen(
              Stream.runForEach(connect(client), (value) =>
                Effect.sync(() => {
                  if (!active) {
                    return;
                  }
                  try {
                    listener(value);
                  } catch {
                    // Swallow listener errors so the stream stays live.
                  }
                }),
              ),
            ),
            Effect.tap(() =>
              active && !this.disposed
                ? Effect.sync(() => {
                    this.noteDisconnected(new Error("Subscription ended"));
                  })
                : Effect.void,
            ),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          this.noteDisconnected(error);
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formatErrorMessage(error),
            });
          }).pipe(Effect.andThen(Effect.sleep(retryDelayMs)));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const clientPromise = Reflect.get(this, "clientPromise") as
      | Promise<WsRpcProtocolClient>
      | undefined;
    const client =
      clientPromise && this.hasConnected
        ? await Promise.race([
            clientPromise.catch((error) => {
              reportBackgroundError(
                "Failed to resolve the WebSocket RPC client during transport disposal.",
                error,
              );
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
          ])
        : undefined;
    if (client && this.hasConnected) {
      await Promise.race([
        this.runtime
          .runPromise(
            Effect.suspend(() =>
              client[WS_METHODS.serverDisconnect]({
                clientSessionId: this.identity.clientSessionId,
                connectionId: this.identity.connectionId,
              }),
            ),
          )
          .catch((error) => {
            reportBackgroundError(
              "Failed to send the server disconnect event before transport disposal.",
              error,
            );
          }),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    }
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}
