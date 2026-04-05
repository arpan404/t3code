import { WsRpcGroup } from "@ace/contracts";
import { resolveWebSocketAuthConnection } from "@ace/shared/wsAuth";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { resolveServerUrl } from "../lib/utils";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export interface WsClientConnectionIdentity {
  readonly clientSessionId: string;
  readonly connectionId: string;
}

export function createWsRpcProtocolLayer(url?: string, identity?: WsClientConnectionIdentity) {
  const resolvedTarget = resolveServerUrl({
    url,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    pathname: "/ws",
  });
  const connection = resolveWebSocketAuthConnection(resolvedTarget, {
    baseUrl: window.location.origin,
    ...(identity
      ? { clientSessionId: identity.clientSessionId, connectionId: identity.connectionId }
      : {}),
  });
  const socketOptions = connection.protocols ? { protocols: [...connection.protocols] } : undefined;
  const socketLayer = Socket.layerWebSocket(connection.url, socketOptions).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}
