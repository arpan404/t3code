import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

import { startAcpClient } from "./acpClient.ts";

type FakeChildProcess = ChildProcessWithoutNullStreams &
  EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };

function makeFakeChild(): FakeChildProcess {
  const events = new EventEmitter() as FakeChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  return child;
}

async function flushIo() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("acpClient", () => {
  const mockedSpawn = vi.mocked(spawn);
  let child: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    child = makeFakeChild();
    mockedSpawn.mockReturnValue(child);
  });

  afterEach(() => {
    mockedSpawn.mockReset();
  });

  it("sends JSON-RPC requests and resolves responses", async () => {
    const client = startAcpClient({
      binaryPath: "cursor-agent",
      args: ["acp"],
      env: { TEST_ENV: "1" },
      cwd: "/repo",
    });

    const stdinChunks: Array<string> = [];
    child.stdin.on("data", (chunk: Buffer | string) => stdinChunks.push(String(chunk)));

    const resultPromise = client.request("session/new", { cwd: "/repo" });
    await flushIo();

    const payload = JSON.parse(stdinChunks.join(""));
    assert.equal(payload.method, "session/new");
    assert.deepEqual(payload.params, { cwd: "/repo" });

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { sessionId: "abc" } })}\n`,
    );

    await expect(resultPromise).resolves.toEqual({ sessionId: "abc" });
  });

  it("rejects request errors as AcpRequestError with enriched details", async () => {
    const client = startAcpClient({
      binaryPath: "cursor-agent",
      args: ["acp"],
    });

    const stdinChunks: Array<string> = [];
    child.stdin.on("data", (chunk: Buffer | string) => stdinChunks.push(String(chunk)));

    const resultPromise = client.request("session/load", { sessionId: "missing" });
    await flushIo();

    const payload = JSON.parse(stdinChunks.join(""));
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: 404,
          message: "session/load failed",
          data: { details: "Session not found" },
        },
      })}\n`,
    );

    await expect(resultPromise).rejects.toEqual(
      expect.objectContaining({
        name: "AcpRequestError",
        method: "session/load",
        code: 404,
        message: "session/load failed: Session not found",
      }),
    );
  });

  it("routes notifications and requests to registered handlers", async () => {
    const client = startAcpClient({
      binaryPath: "cursor-agent",
      args: ["acp"],
    });

    const notifications: Array<unknown> = [];
    const requests: Array<unknown> = [];
    client.setNotificationHandler((notification) => notifications.push(notification));
    client.setRequestHandler((request) => requests.push(request));

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { ok: true } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { tool: "bash" } })}\n`,
    );
    await flushIo();

    assert.deepEqual(notifications, [{ method: "session/update", params: { ok: true } }]);
    assert.deepEqual(requests, [
      { id: 7, method: "session/request_permission", params: { tool: "bash" } },
    ]);
  });

  it("surfaces malformed responses and rejects pending requests on close", async () => {
    const client = startAcpClient({
      binaryPath: "cursor-agent",
      args: ["acp"],
    });

    const protocolErrors: Array<Error> = [];
    client.setProtocolErrorHandler((error) => protocolErrors.push(error));
    const pending = client.request("session/prompt", { prompt: "hello" }, { timeoutMs: 1000 });
    await flushIo();

    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "bad" } })}\n`);
    await flushIo();
    assert.equal(protocolErrors[0]?.message, "Received malformed ACP JSON-RPC response.");

    child.emit("close", 1, null);

    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it("supports explicit respond helpers and close shutdown", async () => {
    const client = startAcpClient({
      binaryPath: "cursor-agent",
      args: ["acp"],
    });

    const writes: Array<string> = [];
    child.stdin.on("data", (chunk: Buffer | string) => writes.push(String(chunk)));

    client.notify("session/cancel", { sessionId: "s1" });
    client.respond(7, { ok: true });
    client.respondError(8, 400, "bad request", { detail: "nope" });

    const closePromise = client.close();
    child.emit("close", 0, null);
    await closePromise;

    const payloads = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(payloads, [
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
      {
        jsonrpc: "2.0",
        id: 8,
        error: { code: 400, message: "bad request", data: { detail: "nope" } },
      },
    ]);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
