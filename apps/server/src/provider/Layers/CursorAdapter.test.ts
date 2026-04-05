import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalRequestId, RuntimeItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cursorAcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cursorAcp")>();
  return {
    ...actual,
    startCursorAcpClient: vi.fn(),
  };
});

import {
  CursorAdapterLive,
  buildCursorTurnUsageSnapshot,
  buildCursorUsageSnapshot,
  classifyCursorToolItemType,
  describePermissionRequest,
  extractCursorStreamText,
  permissionOptionKindForRuntimeMode,
  requestTypeForCursorTool,
  runtimeItemStatusFromCursorStatus,
  streamKindFromUpdateKind,
} from "./CursorAdapter";
import { type ServerConfigShape, ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { startCursorAcpClient, type CursorAcpClient } from "../cursorAcp";
import { type CursorAdapterShape, CursorAdapter } from "../Services/CursorAdapter.ts";

const mockedStartCursorAcpClient = vi.mocked(startCursorAcpClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";

const cursorInitializeResult = (input?: {
  readonly loadSession?: boolean;
  readonly image?: boolean;
}) => ({
  protocolVersion: 1,
  authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
  agentCapabilities: {
    loadSession: input?.loadSession ?? true,
    promptCapabilities: {
      image: input?.image ?? true,
    },
  },
});

const cursorSessionConfigOptions = (input?: {
  readonly mode?: string;
  readonly model?: string;
}) => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: input?.mode ?? "agent",
    options: [
      { value: "agent", name: "Agent" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    currentValue: input?.model ?? "gpt-5-mini[]",
    options: [
      { value: "gpt-5-mini[]", name: "GPT-5 mini" },
      { value: "claude-3.7-sonnet[]", name: "Claude Sonnet" },
    ],
  },
];

const cursorSessionResult = (
  sessionId: string,
  input?: {
    readonly mode?: string;
    readonly model?: string;
  },
) => ({
  sessionId,
  configOptions: cursorSessionConfigOptions(input),
  modes: {
    currentModeId: input?.mode ?? "agent",
    availableModes: [
      { id: "agent", name: "Agent" },
      { id: "plan", name: "Plan" },
    ],
  },
  models: {
    currentModelId: input?.model ?? "gpt-5-mini[]",
    availableModels: [{ modelId: input?.model ?? "gpt-5-mini[]", name: "GPT-5 mini" }],
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeFakeCursorClient(options: {
  readonly requestImpl: (
    method: string,
    params?: unknown,
    requestOptions?: { readonly timeoutMs?: number },
  ) => Promise<unknown>;
}): CursorAcpClient & {
  readonly request: ReturnType<typeof vi.fn>;
  readonly getNotificationHandler: () =>
    | ((notification: { readonly method: string; readonly params?: unknown }) => void)
    | undefined;
  readonly getRequestHandler: () =>
    | ((request: {
        readonly id: string | number;
        readonly method: string;
        readonly params?: unknown;
      }) => void)
    | undefined;
} {
  let closeHandler:
    | ((input: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void)
    | undefined;
  let notificationHandler:
    | ((notification: { readonly method: string; readonly params?: unknown }) => void)
    | undefined;
  let requestHandler:
    | ((request: {
        readonly id: string | number;
        readonly method: string;
        readonly params?: unknown;
      }) => void)
    | undefined;

  const request = vi.fn(options.requestImpl);

  return {
    child: {
      kill: vi.fn(() => true),
    } as unknown as CursorAcpClient["child"],
    request,
    notify: vi.fn(),
    respond: vi.fn(),
    respondError: vi.fn(),
    setNotificationHandler: vi.fn((handler) => {
      notificationHandler = handler;
    }),
    setRequestHandler: vi.fn((handler) => {
      requestHandler = handler;
    }),
    setCloseHandler: vi.fn((handler) => {
      closeHandler = handler;
    }),
    setProtocolErrorHandler: vi.fn(),
    getNotificationHandler: () => notificationHandler,
    getRequestHandler: () => requestHandler,
    close: vi.fn(async () => {
      closeHandler?.({ code: 0, signal: null });
    }),
  };
}

const adapterLayer = CursorAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cursor-adapter-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

async function withAdapter<T>(
  run: (adapter: CursorAdapterShape, config: ServerConfigShape) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const config = yield* ServerConfig;
        return yield* Effect.promise(() => run(adapter, config));
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );
}

afterEach(() => {
  mockedStartCursorAcpClient.mockReset();
});

describe("permissionOptionKindForRuntimeMode", () => {
  it("auto-approves Cursor ACP tool permissions for full-access sessions", () => {
    expect(permissionOptionKindForRuntimeMode("full-access")).toEqual({
      primary: "allow_always",
      fallback: "allow_once",
      decision: "acceptForSession",
    });
  });

  it("keeps manual approval flow for approval-required sessions", () => {
    expect(permissionOptionKindForRuntimeMode("approval-required")).toEqual({
      primary: "allow_once",
      fallback: "allow_always",
      decision: "accept",
    });
  });
});

describe("streamKindFromUpdateKind", () => {
  it("maps Cursor thought chunks to reasoning text", () => {
    expect(streamKindFromUpdateKind("agent_thought_chunk")).toBe("reasoning_text");
  });

  it("keeps normal assistant chunks as assistant text", () => {
    expect(streamKindFromUpdateKind("agent_message_chunk")).toBe("assistant_text");
  });
});

describe("extractCursorStreamText", () => {
  it("preserves leading and trailing whitespace for streamed chunks", () => {
    expect(extractCursorStreamText({ content: { text: "  hello world  \n" } })).toBe(
      "  hello world  \n",
    );
  });

  it("keeps whitespace-only streamed chunks instead of trimming them away", () => {
    expect(extractCursorStreamText({ text: "   " })).toBe("   ");
  });
});

describe("classifyCursorToolItemType", () => {
  it("classifies execute/terminal tool calls as command execution", () => {
    expect(
      classifyCursorToolItemType({
        kind: "execute",
        title: "Terminal",
      }),
    ).toBe("command_execution");
  });

  it("classifies explore subagent tasks as collab agent tool calls", () => {
    expect(
      classifyCursorToolItemType({
        title: "Explore codebase",
        subagentType: "explore",
      }),
    ).toBe("collab_agent_tool_call");
  });
});

describe("requestTypeForCursorTool", () => {
  it("classifies read-style tools as file-read approvals", () => {
    expect(
      requestTypeForCursorTool({
        kind: "read",
        title: "Read file",
      }),
    ).toBe("file_read_approval");
  });
});

describe("runtimeItemStatusFromCursorStatus", () => {
  it("normalizes Cursor in-progress and completed statuses", () => {
    expect(runtimeItemStatusFromCursorStatus("in_progress")).toBe("inProgress");
    expect(runtimeItemStatusFromCursorStatus("completed")).toBe("completed");
    expect(runtimeItemStatusFromCursorStatus("failed")).toBe("failed");
  });
});

describe("describePermissionRequest", () => {
  it("extracts the command text from Cursor permission requests", () => {
    expect(
      describePermissionRequest({
        toolCall: {
          toolCallId: "tool_123",
          title: "`pwd && ls -la /tmp/repo`",
          kind: "execute",
          status: "pending",
        },
      }),
    ).toBe("pwd && ls -la /tmp/repo");
  });
});

describe("CursorAdapterLive", () => {
  it("uses the current ACP session params for new and resumed sessions", async () => {
    const newClient = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-new");
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    const resumedClient = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/load":
            return cursorSessionResult("cursor-session-existing");
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValueOnce(newClient).mockReturnValueOnce(resumedClient);

    await withAdapter(async (adapter) => {
      try {
        const started = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-new"),
            cwd: "/repo/new",
            runtimeMode: "full-access",
          }),
        );
        expect(started.resumeCursor).toEqual({ sessionId: "cursor-session-new" });
        expect(newClient.request).toHaveBeenNthCalledWith(
          3,
          "session/new",
          {
            cwd: "/repo/new",
            mcpServers: [],
          },
          { timeoutMs: 15_000 },
        );

        const resumed = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-existing"),
            cwd: "/repo/existing",
            resumeCursor: { sessionId: "cursor-session-existing" },
            runtimeMode: "full-access",
          }),
        );
        expect(resumed.resumeCursor).toEqual({ sessionId: "cursor-session-existing" });
        expect(resumedClient.request).toHaveBeenNthCalledWith(
          3,
          "session/load",
          {
            cwd: "/repo/existing",
            mcpServers: [],
            sessionId: "cursor-session-existing",
          },
          { timeoutMs: 15_000 },
        );
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("waits for an in-flight startup instead of returning a connecting session", async () => {
    const sessionNew = deferred<ReturnType<typeof cursorSessionResult>>();
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return sessionNew.promise;
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const input = {
          provider: "cursor" as const,
          threadId: asThreadId("thread-race"),
          cwd: "/repo/race",
          runtimeMode: "full-access" as const,
        };
        let secondResolved = false;

        const firstStart = Effect.runPromise(adapter.startSession(input));
        await waitForCondition(() =>
          client.request.mock.calls.some(([method]) => method === "session/new"),
        );

        const secondStart = Effect.runPromise(
          adapter.startSession(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                secondResolved = true;
              }),
            ),
          ),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(secondResolved).toBe(false);

        sessionNew.resolve(cursorSessionResult("cursor-session-race"));

        const [firstSession, secondSession] = await Promise.all([firstStart, secondStart]);
        expect(firstSession.status).toBe("ready");
        expect(firstSession.resumeCursor).toEqual({ sessionId: "cursor-session-race" });
        expect(secondSession.status).toBe("ready");
        expect(secondSession.resumeCursor).toEqual({ sessionId: "cursor-session-race" });
        expect(
          client.request.mock.calls.filter(([method]) => method === "initialize"),
        ).toHaveLength(1);
        expect(
          client.request.mock.calls.filter(([method]) => method === "session/new"),
        ).toHaveLength(1);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("preserves active-turn send failures without wrapping them in Effect.tryPromise", async () => {
    const promptResult = deferred<{ readonly stopReason: string }>();
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-send-turn");
          case "session/prompt":
            return promptResult.promise;
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-send-turn"),
            cwd: "/repo/send-turn",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(
          adapter.sendTurn({
            threadId: asThreadId("thread-send-turn"),
            input: "first prompt",
          }),
        );

        await expect(
          Effect.runPromise(
            adapter.sendTurn({
              threadId: asThreadId("thread-send-turn"),
              input: "second prompt",
            }),
          ),
        ).rejects.toMatchObject({
          _tag: "ProviderAdapterRequestError",
          provider: "cursor",
          method: "session/prompt",
          detail: "Cursor session already has an active turn.",
        });

        promptResult.resolve({ stopReason: "end_turn" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("rehydrates image attachments and syncs plan mode before prompting", async () => {
    const firstPromptResult = deferred<{ readonly stopReason: string }>();
    const secondPromptResult = deferred<{ readonly stopReason: string }>();
    const promptResults = [firstPromptResult.promise, secondPromptResult.promise] as const;
    let promptIndex = 0;
    const client = makeFakeCursorClient({
      requestImpl: async (method, params) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-attachments");
          case "session/set_config_option": {
            const record = params as { readonly value?: string };
            return {
              configOptions: cursorSessionConfigOptions({
                mode: record.value === "plan" ? "plan" : "agent",
              }),
            };
          }
          case "session/prompt":
            return (
              promptResults[promptIndex++] ?? Promise.reject(new Error("Unexpected prompt call"))
            );
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter, config) => {
      try {
        const threadId = asThreadId("thread-attachments");
        const attachment = {
          type: "image" as const,
          id: "thread-attachments-123e4567-e89b-12d3-a456-426614174000",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: Buffer.from(tinyPngBase64, "base64").length,
        };

        await writeFile(
          join(config.attachmentsDir, `${attachment.id}.png`),
          Buffer.from(tinyPngBase64, "base64"),
        );

        await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId,
            cwd: "/repo/attachments",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Describe this screenshot",
            interactionMode: "plan",
            attachments: [attachment],
          }),
        );

        expect(client.request).toHaveBeenCalledWith(
          "session/set_config_option",
          {
            sessionId: "cursor-session-attachments",
            configId: "mode",
            value: "plan",
          },
          { timeoutMs: 15_000 },
        );
        expect(client.request).toHaveBeenCalledWith("session/prompt", {
          sessionId: "cursor-session-attachments",
          prompt: [
            { type: "text", text: "Describe this screenshot" },
            {
              type: "image",
              mimeType: "image/png",
              data: tinyPngBase64,
            },
          ],
        });

        const firstCompletedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        firstPromptResult.resolve({ stopReason: "end_turn" });
        const firstCompletedEvent = await firstCompletedEventPromise;
        expect(firstCompletedEvent._tag).toBe("Some");
        if (firstCompletedEvent._tag !== "Some") {
          return;
        }
        expect(firstCompletedEvent.value.type).toBe("turn.completed");

        await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Continue normally",
            interactionMode: "default",
          }),
        );

        const modeRequests = client.request.mock.calls.filter(
          ([method, requestParams]) =>
            method === "session/set_config_option" &&
            (requestParams as { readonly configId?: string } | undefined)?.configId === "mode",
        );
        expect(modeRequests).toEqual([
          [
            "session/set_config_option",
            {
              sessionId: "cursor-session-attachments",
              configId: "mode",
              value: "plan",
            },
            { timeoutMs: 15_000 },
          ],
          [
            "session/set_config_option",
            {
              sessionId: "cursor-session-attachments",
              configId: "mode",
              value: "agent",
            },
            { timeoutMs: 15_000 },
          ],
        ]);

        secondPromptResult.resolve({ stopReason: "end_turn" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("maps approval decisions to ACP-provided option ids", async () => {
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-approval");
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const session = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-approval"),
            cwd: "/repo/approval",
            runtimeMode: "approval-required",
          }),
        );

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const openedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 51,
          method: "session/request_permission",
          params: {
            toolCall: {
              toolCallId: "tool-approval",
              title: "`npm run build`",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "approve-per-run", kind: "allow_once", name: "Allow once" },
              {
                optionId: "approve-this-session",
                kind: "allow_always",
                name: "Allow for session",
              },
              { optionId: "deny-per-run", kind: "reject_once", name: "Reject" },
            ],
          },
        });

        const openedEvent = await openedEventPromise;
        expect(openedEvent._tag).toBe("Some");
        if (openedEvent._tag !== "Some") {
          return;
        }
        expect(openedEvent.value.type).toBe("request.opened");
        if (openedEvent.value.type !== "request.opened") {
          return;
        }
        const requestId = openedEvent.value.requestId;
        expect(typeof requestId).toBe("string");
        if (!requestId) {
          return;
        }

        const resolvedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        await Effect.runPromise(
          adapter.respondToRequest(
            session.threadId,
            ApprovalRequestId.makeUnsafe(requestId),
            "acceptForSession",
          ),
        );

        const resolvedEvent = await resolvedEventPromise;
        expect(resolvedEvent._tag).toBe("Some");
        if (resolvedEvent._tag !== "Some") {
          return;
        }
        expect(resolvedEvent.value.type).toBe("request.resolved");
        if (resolvedEvent.value.type !== "request.resolved") {
          return;
        }
        expect(resolvedEvent.value.payload).toEqual({
          requestType: "command_execution_approval",
          decision: "acceptForSession",
          resolution: {
            optionId: "approve-this-session",
            kind: "allow_always",
          },
        });
        expect(client.respond).toHaveBeenCalledWith(51, {
          outcome: {
            outcome: "selected",
            optionId: "approve-this-session",
          },
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("cancels active turns with ACP notifications and cancels pending approvals", async () => {
    const firstPromptResult = deferred<{ readonly stopReason: string }>();
    const secondPromptResult = deferred<{ readonly stopReason: string }>();
    let promptCount = 0;
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-cancel");
          case "session/prompt":
            promptCount += 1;
            return promptCount === 1 ? firstPromptResult.promise : secondPromptResult.promise;
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-cancel");
        await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId,
            cwd: "/repo/cancel",
            runtimeMode: "approval-required",
          }),
        );
        const startedTurn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Run something risky",
          }),
        );

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        requestHandler({
          id: 77,
          method: "session/request_permission",
          params: {
            toolCall: {
              toolCallId: "tool-cancel",
              title: "`npm run lint`",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "approve-per-run", kind: "allow_once", name: "Allow once" },
              { optionId: "deny-per-run", kind: "reject_once", name: "Reject" },
            ],
          },
        });

        const postInterruptEventsPromise = Effect.runPromise(
          Stream.runCollect(Stream.take(adapter.streamEvents, 2)),
        );
        await Effect.runPromise(adapter.interruptTurn(threadId, startedTurn.turnId));

        expect(client.notify).toHaveBeenCalledWith("session/cancel", {
          sessionId: "cursor-session-cancel",
        });
        expect(client.respond).toHaveBeenCalledWith(77, {
          outcome: {
            outcome: "cancelled",
          },
        });

        const postInterruptEvents = Array.from(await postInterruptEventsPromise);
        expect(postInterruptEvents).toHaveLength(2);

        const resolvedEvent = postInterruptEvents[0];
        const abortedEvent = postInterruptEvents[1];
        expect(resolvedEvent?.type).toBe("request.resolved");
        if (resolvedEvent?.type !== "request.resolved") {
          return;
        }
        expect(abortedEvent?.type).toBe("turn.aborted");
        if (abortedEvent?.type !== "turn.aborted") {
          return;
        }
        expect(resolvedEvent.payload).toEqual({
          requestType: "command_execution_approval",
          decision: "cancel",
          resolution: {
            outcome: "cancelled",
          },
        });

        const restartedTurn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Retry after cancel",
          }),
        );
        expect(restartedTurn.threadId).toBe(threadId);
        expect(restartedTurn.turnId).not.toBe(startedTurn.turnId);
      } finally {
        secondPromptResult.resolve({ stopReason: "end_turn" });
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("round-trips multi-select ask_question answers back to Cursor ACP option ids", async () => {
    const client = makeFakeCursorClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return cursorInitializeResult();
          case "authenticate":
            return {};
          case "session/new":
            return cursorSessionResult("cursor-session-user-input");
          default:
            throw new Error(`Unexpected Cursor ACP request: ${method}`);
        }
      },
    });
    mockedStartCursorAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const session = await Effect.runPromise(
          adapter.startSession({
            provider: "cursor",
            threadId: asThreadId("thread-user-input"),
            cwd: "/repo/user-input",
            runtimeMode: "full-access",
          }),
        );

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const requestedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 44,
          method: "cursor/ask_question",
          params: {
            title: "Tool selection",
            questions: [
              {
                id: "tools",
                prompt: "Which tools should run?",
                allowMultiple: true,
                options: [
                  { id: "search", label: "Search" },
                  { id: "edit", label: "Edit" },
                ],
              },
            ],
          },
        });

        const requestedEvent = await requestedEventPromise;
        expect(requestedEvent._tag).toBe("Some");
        if (requestedEvent._tag !== "Some") {
          return;
        }
        expect(requestedEvent.value.type).toBe("user-input.requested");
        if (requestedEvent.value.type !== "user-input.requested") {
          return;
        }
        const requestId = requestedEvent.value.requestId;
        expect(typeof requestId).toBe("string");
        if (!requestId) {
          return;
        }
        expect(requestedEvent.value.payload.questions).toEqual([
          {
            id: "tools",
            header: "Tool selection",
            question: "Which tools should run?",
            multiSelect: true,
            options: [
              { label: "Search", description: "Search" },
              { label: "Edit", description: "Edit" },
            ],
          },
        ]);

        const resolvedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        await Effect.runPromise(
          adapter.respondToUserInput(session.threadId, ApprovalRequestId.makeUnsafe(requestId), {
            tools: ["Search", "Edit"],
          }),
        );

        const resolvedEvent = await resolvedEventPromise;
        expect(resolvedEvent._tag).toBe("Some");
        if (resolvedEvent._tag !== "Some") {
          return;
        }
        expect(resolvedEvent.value.type).toBe("user-input.resolved");
        if (resolvedEvent.value.type !== "user-input.resolved") {
          return;
        }
        expect(resolvedEvent.value.payload.answers).toEqual({
          tools: ["Search", "Edit"],
        });

        expect(client.respond).toHaveBeenCalledWith(44, {
          outcome: {
            outcome: "answered",
            answers: [
              {
                questionId: "tools",
                selectedOptionIds: ["search", "edit"],
              },
            ],
          },
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("normalizes Cursor usage updates into thread usage details", () => {
    const snapshot = buildCursorUsageSnapshot(
      {
        used: 32_000,
        size: 128_000,
      },
      {
        id: TurnId.makeUnsafe("cursor-turn-usage"),
        startedAtMs: Date.now(),
        items: [],
        assistantText: "",
        interruptRequested: false,
        reasoningText: "",
        assistantItem: undefined,
        reasoningItem: undefined,
        toolCalls: new Map([
          [
            "tool-1",
            {
              toolCallId: "tool-1",
              itemId: RuntimeItemId.makeUnsafe("cursor-tool-1"),
              itemType: "command_execution",
              title: "Run command",
              status: "completed",
              data: {},
            },
          ],
        ]),
      },
    );

    expect(snapshot).toEqual({
      usedTokens: 32_000,
      maxTokens: 128_000,
      lastUsedTokens: 32_000,
      toolUses: 1,
    });
  });

  it("fills Cursor max tokens from the current model when usage updates omit size", () => {
    const snapshot = buildCursorUsageSnapshot(
      {
        used: 32_000,
      },
      undefined,
      200_000,
    );

    expect(snapshot).toEqual({
      usedTokens: 32_000,
      maxTokens: 200_000,
      lastUsedTokens: 32_000,
    });
  });

  it("emits token-only Cursor usage details from prompt completion metadata", () => {
    const snapshot = buildCursorTurnUsageSnapshot(
      {
        usage: {
          totalTokens: 1_472,
          inputTokens: 1_024,
          cachedReadTokens: 256,
          outputTokens: 128,
          thoughtTokens: 64,
        },
      },
      undefined,
      undefined,
      200_000,
    );

    expect(snapshot).toEqual({
      usedTokens: 1_472,
      lastUsedTokens: 1_472,
      lastInputTokens: 1_024,
      lastCachedInputTokens: 256,
      lastOutputTokens: 128,
      lastReasoningOutputTokens: 64,
    });
  });

  it("merges Cursor prompt completion token totals with live context usage", () => {
    const snapshot = buildCursorTurnUsageSnapshot(
      {
        usage: {
          totalTokens: 1_472,
          inputTokens: 1_024,
          outputTokens: 128,
        },
      },
      undefined,
      {
        usedTokens: 32_000,
        maxTokens: 128_000,
        lastUsedTokens: 32_000,
      },
      200_000,
    );

    expect(snapshot).toEqual({
      usedTokens: 32_000,
      maxTokens: 128_000,
      lastUsedTokens: 1_472,
      lastInputTokens: 1_024,
      lastOutputTokens: 128,
    });
  });
});
