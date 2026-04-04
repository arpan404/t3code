import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

export type CursorAcpJsonRpcId = string | number;

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
}

interface JsonRpcResponse {
  readonly id: CursorAcpJsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

export interface CursorAcpNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CursorAcpRequest {
  readonly id: CursorAcpJsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface CursorAcpRequestOptions {
  readonly timeoutMs?: number;
}

export interface CursorAcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  request: (
    method: string,
    params?: unknown,
    options?: CursorAcpRequestOptions,
  ) => Promise<unknown>;
  respond: (id: CursorAcpJsonRpcId, result: unknown) => void;
  respondError: (id: CursorAcpJsonRpcId, code: number, message: string) => void;
  setNotificationHandler: (handler: (notification: CursorAcpNotification) => void) => void;
  setRequestHandler: (handler: (request: CursorAcpRequest) => void) => void;
  setCloseHandler: (
    handler: (input: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void,
  ) => void;
  setProtocolErrorHandler: (handler: (error: Error) => void) => void;
  close: () => Promise<void>;
}

export interface StartCursorAcpClientOptions {
  readonly binaryPath: string;
  readonly model?: string;
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, payload: unknown): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

export function startCursorAcpClient(options: StartCursorAcpClientOptions): CursorAcpClient {
  const args = [...(options.model ? ["--model", options.model] : []), "acp"];
  const child = spawn(options.binaryPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
    },
  });
  const output = readline.createInterface({ input: child.stdout });
  const pending = new Map<CursorAcpJsonRpcId, PendingRequest>();
  let nextRequestId = 1;
  let notificationHandler: ((notification: CursorAcpNotification) => void) | undefined;
  let requestHandler: ((request: CursorAcpRequest) => void) | undefined;
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;
  let protocolErrorHandler: ((error: Error) => void) | undefined;

  const clearPending = (reason: Error) => {
    for (const [id, request] of pending.entries()) {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      pending.delete(id);
      request.reject(reason);
    }
  };

  output.on("line", (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      protocolErrorHandler?.(
        error instanceof Error
          ? error
          : new Error(`Failed to parse ACP JSON line: ${String(error)}`),
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const message = parsed as Record<string, unknown>;
    if (
      (typeof message.id === "string" || typeof message.id === "number") &&
      ("result" in message || "error" in message)
    ) {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) {
        return;
      }
      pending.delete(message.id);
      if (pendingRequest.timeout) {
        clearTimeout(pendingRequest.timeout);
      }
      const response = message as unknown as JsonRpcResponse;
      if (response.error) {
        pendingRequest.reject(
          new Error(response.error.message ?? `ACP request failed (${pendingRequest.method})`),
        );
        return;
      }
      pendingRequest.resolve(response.result);
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    if (typeof message.id === "string" || typeof message.id === "number") {
      requestHandler?.({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    notificationHandler?.({
      method: message.method,
      params: message.params,
    });
  });

  child.on("error", (error) => {
    protocolErrorHandler?.(error);
    clearPending(error);
  });

  child.on("close", (code, signal) => {
    output.close();
    clearPending(
      new Error(`Cursor ACP exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
    closeHandler?.({ code, signal });
  });

  return {
    child,
    request(method, params, requestOptions) {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timeout =
          requestOptions?.timeoutMs !== undefined
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`ACP request timed out for ${method}`));
              }, requestOptions.timeoutMs)
            : undefined;
        pending.set(id, {
          method,
          resolve,
          reject,
          ...(timeout ? { timeout } : {}),
        });
        writeJsonLine(child, { jsonrpc: "2.0", id, method, params });
      });
    },
    respond(id, result) {
      writeJsonLine(child, { jsonrpc: "2.0", id, result });
    },
    respondError(id, code, message) {
      writeJsonLine(child, { jsonrpc: "2.0", id, error: { code, message } });
    },
    setNotificationHandler(handler) {
      notificationHandler = handler;
    },
    setRequestHandler(handler) {
      requestHandler = handler;
    },
    setCloseHandler(handler) {
      closeHandler = handler;
    },
    setProtocolErrorHandler(handler) {
      protocolErrorHandler = handler;
    },
    close() {
      return new Promise((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) {
            return;
          }
          resolved = true;
          resolve();
        };
        child.once("close", finish);
        child.stdin.end();
        child.kill("SIGTERM");
        setTimeout(finish, 2_000);
      });
    },
  };
}
