import {
  startAcpClient,
  type AcpClient,
  type AcpJsonRpcId,
  type AcpNotification,
  type AcpRequest,
  type AcpRequestOptions,
} from "./acpClient.ts";

export type CursorAcpJsonRpcId = AcpJsonRpcId;
export type CursorAcpNotification = AcpNotification;
export type CursorAcpRequest = AcpRequest;
export type CursorAcpRequestOptions = AcpRequestOptions;
export type CursorAcpClient = AcpClient;

export interface StartCursorAcpClientOptions {
  readonly binaryPath: string;
  readonly model?: string;
}

export function startCursorAcpClient(options: StartCursorAcpClientOptions): CursorAcpClient {
  return startAcpClient({
    binaryPath: options.binaryPath,
    args: [...(options.model ? ["--model", options.model] : []), "acp"],
    env: {
      NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
    },
  });
}
