import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

export type AcpJsonRpcId = string | number;

interface JsonRpcError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly id: AcpJsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

export class AcpRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(enrichAcpErrorMessage(message, data));
    this.name = "AcpRequestError";
  }
}

function enrichAcpErrorMessage(message: string, data: unknown): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const details =
      typeof record.details === "string" && record.details.length > 0
        ? record.details
        : typeof record.detail === "string" && record.detail.length > 0
          ? record.detail
          : typeof record.message === "string" && record.message.length > 0
            ? record.message
            : undefined;
    if (details && details !== message) {
      return `${message}: ${details}`;
    }
  }
  return message;
}

export interface AcpNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpRequest {
  readonly id: AcpJsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpRequestOptions {
  readonly timeoutMs?: number;
}

export interface AcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  request: (method: string, params?: unknown, options?: AcpRequestOptions) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  respond: (id: AcpJsonRpcId, result: unknown) => void;
  respondError: (id: AcpJsonRpcId, code: number, message: string, data?: unknown) => void;
  setNotificationHandler: (handler: (notification: AcpNotification) => void) => void;
  setRequestHandler: (handler: (request: AcpRequest) => void) => void;
  setCloseHandler: (
    handler: (input: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void,
  ) => void;
  setProtocolErrorHandler: (handler: (error: Error) => void) => void;
  close: () => Promise<void>;
}

export interface StartAcpClientOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, payload: unknown): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function readJsonRpcError(value: unknown): JsonRpcError | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const code = typeof record.code === "number" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : undefined;

  if (("code" in record && code === undefined) || ("message" in record && message === undefined)) {
    return undefined;
  }

  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...("data" in record ? { data: record.data } : {}),
  };
}

function parseJsonRpcResponse(message: Record<string, unknown>): JsonRpcResponse | undefined {
  if (!isJsonRpcId(message.id) || (!("result" in message) && !("error" in message))) {
    return undefined;
  }

  if ("error" in message) {
    const error = readJsonRpcError(message.error);
    if (message.error !== undefined && error === undefined) {
      return undefined;
    }
    return {
      id: message.id,
      ...("result" in message ? { result: message.result } : {}),
      ...(error ? { error } : {}),
    };
  }

  return {
    id: message.id,
    ...("result" in message ? { result: message.result } : {}),
  };
}

export function startAcpClient(options: StartAcpClientOptions): AcpClient {
  const child = spawn(options.binaryPath, [...options.args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...options.env,
    },
  });
  const output = readline.createInterface({ input: child.stdout });
  const pending = new Map<AcpJsonRpcId, PendingRequest>();
  let nextRequestId = 1;
  let notificationHandler: ((notification: AcpNotification) => void) | undefined;
  let requestHandler: ((request: AcpRequest) => void) | undefined;
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

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const message = parsed as Record<string, unknown>;
    const response = parseJsonRpcResponse(message);
    if (response) {
      const pendingRequest = pending.get(response.id);
      if (!pendingRequest) {
        return;
      }
      pending.delete(response.id);
      if (pendingRequest.timeout) {
        clearTimeout(pendingRequest.timeout);
      }
      if (response.error) {
        pendingRequest.reject(
          new AcpRequestError(
            pendingRequest.method,
            response.error.code,
            response.error.message ?? `ACP request failed (${pendingRequest.method})`,
            response.error.data,
          ),
        );
        return;
      }
      pendingRequest.resolve(response.result);
      return;
    }
    if (isJsonRpcId(message.id) && ("result" in message || "error" in message)) {
      protocolErrorHandler?.(new Error("Received malformed ACP JSON-RPC response."));
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    if (isJsonRpcId(message.id)) {
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
      new Error(`ACP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
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
                reject(
                  new AcpRequestError(method, undefined, `ACP request timed out for ${method}`),
                );
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
    notify(method, params) {
      writeJsonLine(child, { jsonrpc: "2.0", method, params });
    },
    respond(id, result) {
      writeJsonLine(child, { jsonrpc: "2.0", id, result });
    },
    respondError(id, code, message, data) {
      writeJsonLine(child, {
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message,
          ...(data !== undefined ? { data } : {}),
        },
      });
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
