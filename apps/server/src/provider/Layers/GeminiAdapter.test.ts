import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../acpClient.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acpClient.ts")>();
  return {
    ...actual,
    startAcpClient: vi.fn(),
  };
});

import {
  buildGeminiInitializeParams,
  canGeminiSetSessionMode,
  canGeminiSetSessionModel,
  GeminiAdapterLive,
  GEMINI_ACP_CLIENT_INFO,
} from "./GeminiAdapter.ts";
import { type ServerConfigShape, ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type AcpClient, startAcpClient } from "../acpClient.ts";
import { type GeminiAdapterShape, GeminiAdapter } from "../Services/GeminiAdapter.ts";

const mockedStartAcpClient = vi.mocked(startAcpClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function geminiInitializeResult() {
  return {
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
    },
  };
}

function geminiSessionResult(
  sessionId: string,
  input?: {
    readonly currentModeId?: string;
    readonly currentModelId?: string;
  },
) {
  const currentModeId = input?.currentModeId ?? "default";
  const currentModelId = input?.currentModelId ?? "gemini-2.5-pro";
  return {
    sessionId,
    modes: {
      currentModeId,
      availableModes: [
        { id: "default", name: "Default", description: "Prompts for approval" },
        { id: "yolo", name: "YOLO", description: "Auto-approves all actions" },
      ],
    },
    models: {
      currentModelId,
      availableModels: [{ modelId: currentModelId, name: "Gemini 2.5 Pro" }],
    },
  };
}

function makeFakeGeminiClient(options: {
  readonly requestImpl: (
    method: string,
    params?: unknown,
    requestOptions?: { readonly timeoutMs?: number },
  ) => Promise<unknown>;
}): AcpClient & {
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
    } as unknown as AcpClient["child"],
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

const adapterLayer = GeminiAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "gemini-adapter-test-" })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

async function withAdapter<T>(
  run: (adapter: GeminiAdapterShape, config: ServerConfigShape) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* GeminiAdapter;
        const config = yield* ServerConfig;
        return yield* Effect.promise(() => run(adapter, config));
      }),
    ).pipe(Effect.provide(adapterLayer)),
  );
}

afterEach(() => {
  mockedStartAcpClient.mockReset();
});

describe("buildGeminiInitializeParams", () => {
  it("declares filesystem capabilities required by older Gemini ACP builds", () => {
    expect(buildGeminiInitializeParams()).toEqual({
      protocolVersion: 1,
      clientInfo: GEMINI_ACP_CLIENT_INFO,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    });
  });
});

describe("Gemini ACP capability guards", () => {
  it("skips mode switching when the session does not advertise modes", () => {
    expect(canGeminiSetSessionMode({ availableModes: [] })).toBe(false);
  });

  it("skips model switching when the session does not advertise models", () => {
    expect(canGeminiSetSessionModel({ availableModels: [] })).toBe(false);
  });

  it("enables control calls when capabilities are advertised", () => {
    expect(canGeminiSetSessionMode({ availableModes: [{ id: "default" }] })).toBe(true);
    expect(canGeminiSetSessionModel({ availableModels: [{ modelId: "gemini-2.5-pro" }] })).toBe(
      true,
    );
  });
});

describe("GeminiAdapterLive startup", () => {
  it("falls back to a fresh Gemini session when the persisted resume cursor no longer exists remotely", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/load":
            throw new Error(
              "Request session/load failed: Session not found: gemini-session-missing",
            );
          case "session/new":
            return geminiSessionResult("gemini-session-recreated");
          case "session/set_mode":
            return geminiSessionResult("gemini-session-recreated", {
              currentModeId: "yolo",
            });
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const session = await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-stale-resume"),
            cwd: "/repo/gemini-stale-resume",
            resumeCursor: { sessionId: "gemini-session-missing" },
            runtimeMode: "full-access",
          }),
        );

        expect(session.resumeCursor).toEqual({ sessionId: "gemini-session-recreated" });
        expect(client.request).toHaveBeenNthCalledWith(
          2,
          "session/load",
          {
            cwd: "/repo/gemini-stale-resume",
            mcpServers: [],
            sessionId: "gemini-session-missing",
          },
          { timeoutMs: 20_000 },
        );
        expect(client.request).toHaveBeenNthCalledWith(
          3,
          "session/new",
          {
            cwd: "/repo/gemini-stale-resume",
            mcpServers: [],
          },
          { timeoutMs: 20_000 },
        );
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });
});

describe("GeminiAdapterLive approvals", () => {
  it("auto-resolves Gemini permission requests for full-access sessions", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-full-access", {
              currentModeId: "yolo",
            });
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-full-access"),
            cwd: "/repo/gemini-full-access",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const resolvedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 101,
          method: "session/request_permission",
          params: {
            sessionId: "gemini-session-full-access",
            toolCall: {
              toolCallId: "tool-call-1",
              title: "Write file",
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "allow-session", kind: "allow_always", name: "Allow for session" },
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "deny-once", kind: "reject_once", name: "Deny" },
            ],
          },
        });

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
          requestType: "file_change_approval",
          decision: "acceptForSession",
          resolution: {
            optionId: "allow-session",
            kind: "allow_always",
          },
        });
        expect(client.respond).toHaveBeenCalledWith(101, {
          outcome: {
            outcome: "selected",
            optionId: "allow-session",
          },
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("keeps Gemini permission requests interactive for approval-required sessions", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-approval-required", {
              currentModeId: "default",
            });
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-approval-required"),
            cwd: "/repo/gemini-approval-required",
            runtimeMode: "approval-required",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const requestHandler = client.getRequestHandler();
        expect(requestHandler).toBeTypeOf("function");
        if (!requestHandler) {
          return;
        }

        const openedEventPromise = Effect.runPromise(Stream.runHead(adapter.streamEvents));
        requestHandler({
          id: 202,
          method: "session/request_permission",
          params: {
            sessionId: "gemini-session-approval-required",
            toolCall: {
              toolCallId: "tool-call-2",
              title: "Write file",
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "allow-session", kind: "allow_always", name: "Allow for session" },
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "deny-once", kind: "reject_once", name: "Deny" },
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

        expect(openedEvent.value.payload.requestType).toBe("file_change_approval");
        expect(openedEvent.value.payload.detail).toBe("Write file");
        expect(client.respond).not.toHaveBeenCalled();
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("preserves Gemini notification timestamps on streamed reasoning chunks", async () => {
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-reasoning-timestamp", {
              currentModeId: "yolo",
            });
          case "session/prompt":
            return new Promise(() => undefined);
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId: asThreadId("thread-gemini-reasoning-timestamp"),
            cwd: "/repo/gemini-reasoning-timestamp",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const reasoningDeltaFiber = Effect.runPromise(
          Stream.runHead(
            Stream.filter(
              adapter.streamEvents,
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
            ),
          ),
        );

        await Effect.runPromise(
          adapter.sendTurn({
            threadId: asThreadId("thread-gemini-reasoning-timestamp"),
            input: "Explain the execution order.",
          }),
        );

        const notificationHandler = client.getNotificationHandler();
        expect(notificationHandler).toBeTypeOf("function");
        if (!notificationHandler) {
          return;
        }

        const providerTimestamp = "2024-01-01T00:00:05.000Z";
        notificationHandler({
          method: "session/update",
          params: {
            sessionId: "gemini-session-reasoning-timestamp",
            update: {
              sessionUpdate: "agent_thought_chunk",
              timestamp: providerTimestamp,
              content: {
                type: "text",
                text: "Inspecting the event ordering.",
              },
            },
          },
        });

        const reasoningDelta = await reasoningDeltaFiber;
        expect(reasoningDelta._tag).toBe("Some");
        if (reasoningDelta._tag !== "Some") {
          return;
        }

        expect(reasoningDelta.value.createdAt).toBe(providerTimestamp);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("emits context usage updates and merges Gemini prompt token breakdowns", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const promptResult = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-usage", {
              currentModeId: "yolo",
            });
          case "session/prompt":
            return promptResult;
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-usage");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-usage",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const usageEventsPromise = Effect.runPromise(
          Stream.runCollect(
            Stream.take(
              Stream.filter(
                adapter.streamEvents,
                (event) => event.type === "thread.token-usage.updated",
              ),
              2,
            ),
          ),
        );

        const turn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Explain the latest token usage.",
          }),
        );

        const notificationHandler = client.getNotificationHandler();
        expect(notificationHandler).toBeTypeOf("function");
        if (!notificationHandler) {
          return;
        }

        notificationHandler({
          method: "session/update",
          params: {
            sessionId: "gemini-session-usage",
            update: {
              sessionUpdate: "usage_update",
              used: 4_096,
              size: 32_768,
            },
          },
        });

        resolvePrompt({
          stopReason: "end_turn",
          usage: {
            totalTokens: 1_472,
            inputTokens: 1_024,
            cachedReadTokens: 256,
            outputTokens: 128,
            thoughtTokens: 64,
          },
        });

        const usageEvents = Array.from(await usageEventsPromise);
        expect(usageEvents).toHaveLength(2);

        const [liveUsageEvent, completedUsageEvent] = usageEvents;
        expect(liveUsageEvent?.type).toBe("thread.token-usage.updated");
        expect(completedUsageEvent?.type).toBe("thread.token-usage.updated");
        if (
          liveUsageEvent?.type !== "thread.token-usage.updated" ||
          completedUsageEvent?.type !== "thread.token-usage.updated"
        ) {
          return;
        }

        expect(liveUsageEvent.turnId).toBe(turn.turnId);
        expect(liveUsageEvent.payload.usage).toEqual({
          usedTokens: 4_096,
          maxTokens: 32_768,
          lastUsedTokens: 4_096,
        });
        expect(completedUsageEvent.turnId).toBe(turn.turnId);
        expect(completedUsageEvent.payload.usage).toEqual({
          usedTokens: 4_096,
          maxTokens: 32_768,
          lastUsedTokens: 1_472,
          lastInputTokens: 1_024,
          lastCachedInputTokens: 256,
          lastOutputTokens: 128,
          lastReasoningOutputTokens: 64,
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("emits context usage from Gemini prompt completion quota metadata without a live update", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const promptResult = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-quota-only", {
              currentModeId: "yolo",
            });
          case "session/prompt":
            return promptResult;
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-quota-only");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-quota-only",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const usageEventPromise = Effect.runPromise(
          Stream.runHead(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "thread.token-usage.updated",
            ),
          ),
        );

        const turn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Summarize the final context quota.",
          }),
        );

        resolvePrompt({
          stopReason: "end_turn",
          usage: {
            totalTokens: 1_280,
            inputTokens: 900,
            outputTokens: 220,
          },
          _meta: {
            quota: {
              used: 6_144,
              size: 24_576,
            },
          },
        });

        const usageEvent = await usageEventPromise;
        expect(usageEvent._tag).toBe("Some");
        if (usageEvent._tag !== "Some") {
          return;
        }

        expect(usageEvent.value.type).toBe("thread.token-usage.updated");
        if (usageEvent.value.type !== "thread.token-usage.updated") {
          return;
        }

        expect(usageEvent.value.turnId).toBe(turn.turnId);
        expect(usageEvent.value.payload.usage).toEqual({
          usedTokens: 6_144,
          maxTokens: 24_576,
          lastUsedTokens: 1_280,
          lastInputTokens: 900,
          lastOutputTokens: 220,
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("infers Gemini max tokens from the current model when quota usage omits size", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const promptResult = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-inferred-limit", {
              currentModeId: "yolo",
              currentModelId: "gemini-2.5-pro",
            });
          case "session/prompt":
            return promptResult;
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-inferred-limit");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-inferred-limit",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const usageEventPromise = Effect.runPromise(
          Stream.runHead(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "thread.token-usage.updated",
            ),
          ),
        );

        const turn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Explain the current Gemini context usage.",
          }),
        );

        resolvePrompt({
          stopReason: "end_turn",
          usage: {
            totalTokens: 1_280,
            inputTokens: 900,
            outputTokens: 220,
          },
          _meta: {
            quota: {
              used: 6_144,
            },
          },
        });

        const usageEvent = await usageEventPromise;
        expect(usageEvent._tag).toBe("Some");
        if (usageEvent._tag !== "Some") {
          return;
        }

        expect(usageEvent.value.type).toBe("thread.token-usage.updated");
        if (usageEvent.value.type !== "thread.token-usage.updated") {
          return;
        }

        expect(usageEvent.value.turnId).toBe(turn.turnId);
        expect(usageEvent.value.payload.usage).toEqual({
          usedTokens: 6_144,
          maxTokens: 1_048_576,
          lastUsedTokens: 1_280,
          lastInputTokens: 900,
          lastOutputTokens: 220,
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("reads Gemini ACP nested quota token_count metadata when no live usage update arrives", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const promptResult = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-token-count-only", {
              currentModeId: "yolo",
            });
          case "session/prompt":
            return promptResult;
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-token-count-only");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-token-count-only",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const usageEventPromise = Effect.runPromise(
          Stream.runHead(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "thread.token-usage.updated",
            ),
          ),
        );

        const turn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Summarize the nested Gemini token count metadata.",
          }),
        );

        resolvePrompt({
          stopReason: "end_turn",
          _meta: {
            quota: {
              token_count: {
                input_tokens: 900,
                output_tokens: 220,
              },
              model_usage: [
                {
                  model: "gemini-2.5-pro",
                  token_count: {
                    input_tokens: 900,
                    output_tokens: 220,
                  },
                },
              ],
            },
          },
        });

        const usageEvent = await usageEventPromise;
        expect(usageEvent._tag).toBe("Some");
        if (usageEvent._tag !== "Some") {
          return;
        }

        expect(usageEvent.value.type).toBe("thread.token-usage.updated");
        if (usageEvent.value.type !== "thread.token-usage.updated") {
          return;
        }

        expect(usageEvent.value.turnId).toBe(turn.turnId);
        expect(usageEvent.value.payload.usage).toEqual({
          usedTokens: 1_120,
          lastUsedTokens: 1_120,
          lastInputTokens: 900,
          lastOutputTokens: 220,
        });
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("blocks overlapping Gemini turn starts while session sync is still in flight", async () => {
    let resolveSetModel: ((value: unknown) => void) | undefined;
    const setModelPromise = new Promise<unknown>((resolve) => {
      resolveSetModel = resolve;
    });
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return {
              sessionId: "gemini-session-overlap",
              modes: {
                currentModeId: "yolo",
                availableModes: [
                  { id: "default", name: "Default", description: "Prompts for approval" },
                  { id: "yolo", name: "YOLO", description: "Auto-approves all actions" },
                ],
              },
              models: {
                currentModelId: "gemini-2.5-pro",
                availableModels: [
                  { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
                  { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
                ],
              },
            };
          case "session/set_model":
            return setModelPromise;
          case "session/prompt":
            return { stopReason: "end_turn" };
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-overlap");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-overlap",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const firstTurnPromise = Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Start the first Gemini turn",
            modelSelection: {
              provider: "gemini",
              model: "gemini-2.5-flash",
            },
          }),
        );

        await Promise.resolve();

        await expect(
          Effect.runPromise(
            adapter.sendTurn({
              threadId,
              input: "Try to overlap the Gemini turn",
            }),
          ),
        ).rejects.toMatchObject({
          detail: expect.stringContaining("already running turn"),
        });

        resolveSetModel?.({});
        const firstTurn = await firstTurnPromise;
        expect(firstTurn.threadId).toBe(threadId);

        expect(
          client.request.mock.calls.filter(([method]) => method === "session/prompt").length,
        ).toBe(1);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("releases the Gemini turn reservation when turn start setup fails", async () => {
    let failSetModel = true;
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return {
              sessionId: "gemini-session-start-failure",
              modes: {
                currentModeId: "yolo",
                availableModes: [
                  { id: "default", name: "Default", description: "Prompts for approval" },
                  { id: "yolo", name: "YOLO", description: "Auto-approves all actions" },
                ],
              },
              models: {
                currentModelId: "gemini-2.5-pro",
                availableModels: [
                  { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
                  { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
                ],
              },
            };
          case "session/set_model":
            if (failSetModel) {
              failSetModel = false;
              throw new Error("Gemini model sync failed");
            }
            return {};
          case "session/prompt":
            return { stopReason: "end_turn" };
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-start-failure");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-start-failure",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        await expect(
          Effect.runPromise(
            adapter.sendTurn({
              threadId,
              input: "This turn should fail during setup",
              modelSelection: {
                provider: "gemini",
                model: "gemini-2.5-flash",
              },
            }),
          ),
        ).rejects.toMatchObject({
          detail: expect.stringContaining("Gemini model sync failed"),
        });

        const recoveredTurn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Retry after setup failure",
            modelSelection: {
              provider: "gemini",
              model: "gemini-2.5-flash",
            },
          }),
        );

        expect(recoveredTurn.threadId).toBe(threadId);
        expect(
          client.request.mock.calls.filter(([method]) => method === "session/prompt").length,
        ).toBe(1);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("interrupts Gemini turns without waiting for the prompt request to settle", async () => {
    const firstPromptResult = new Promise<unknown>(() => undefined);
    const secondPromptResult = Promise.resolve({ stopReason: "end_turn" });
    let promptCount = 0;
    const client = makeFakeGeminiClient({
      requestImpl: async (method) => {
        switch (method) {
          case "initialize":
            return geminiInitializeResult();
          case "session/new":
            return geminiSessionResult("gemini-session-interrupt", {
              currentModeId: "yolo",
            });
          case "session/prompt":
            promptCount += 1;
            return promptCount === 1 ? firstPromptResult : secondPromptResult;
          default:
            throw new Error(`Unexpected Gemini ACP request: ${method}`);
        }
      },
    });
    mockedStartAcpClient.mockReturnValue(client);

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-interrupt");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-interrupt",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const firstTurn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Start something long running",
          }),
        );

        const interruptedEventPromise = Effect.runPromise(
          Stream.runHead(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "turn.completed" && event.turnId === firstTurn.turnId,
            ),
          ),
        );

        await Effect.runPromise(adapter.interruptTurn(threadId, firstTurn.turnId));

        expect(client.notify).toHaveBeenCalledWith("session/cancel", {
          sessionId: "gemini-session-interrupt",
        });

        const interruptedEvent = await interruptedEventPromise;
        expect(interruptedEvent._tag).toBe("Some");
        if (interruptedEvent._tag !== "Some") {
          return;
        }

        expect(interruptedEvent.value.type).toBe("turn.completed");
        if (interruptedEvent.value.type !== "turn.completed") {
          return;
        }

        expect(interruptedEvent.value.payload.state).toBe("interrupted");
        expect(interruptedEvent.value.payload.stopReason).toBe("cancelled");

        const secondTurn = await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Retry after interrupt",
          }),
        );

        expect(secondTurn.threadId).toBe(threadId);
        expect(secondTurn.turnId).not.toBe(firstTurn.turnId);
      } finally {
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });

  it("restarts Gemini sessions on rollback and bootstraps the next prompt from preserved transcript", async () => {
    let firstPromptResolve!: (value: unknown) => void;
    let secondPromptResolve!: (value: unknown) => void;
    const firstPromptResult = new Promise<unknown>((resolve) => {
      firstPromptResolve = resolve;
    });
    const secondPromptResult = new Promise<unknown>((resolve) => {
      secondPromptResolve = resolve;
    });
    const clients: Array<ReturnType<typeof makeFakeGeminiClient>> = [];

    mockedStartAcpClient.mockImplementation(() => {
      const sessionIndex = clients.length + 1;
      let promptCount = 0;
      const client = makeFakeGeminiClient({
        requestImpl: async (method) => {
          switch (method) {
            case "initialize":
              return geminiInitializeResult();
            case "session/new":
              return geminiSessionResult(`gemini-session-rollback-${sessionIndex}`, {
                currentModeId: "yolo",
              });
            case "session/prompt":
              if (sessionIndex !== 1) {
                return { stopReason: "end_turn" };
              }
              promptCount += 1;
              return promptCount === 1 ? firstPromptResult : secondPromptResult;
            default:
              throw new Error(`Unexpected Gemini ACP request: ${method}`);
          }
        },
      });
      clients.push(client);
      return client;
    });

    await withAdapter(async (adapter) => {
      try {
        const threadId = asThreadId("thread-gemini-rollback");
        await Effect.runPromise(
          adapter.startSession({
            provider: "gemini",
            threadId,
            cwd: "/repo/gemini-rollback",
            runtimeMode: "full-access",
          }),
        );

        await Effect.runPromise(Stream.take(adapter.streamEvents, 2).pipe(Stream.runDrain));

        const firstTurnPromise = Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Original prompt",
          }),
        );

        const notificationHandler = clients[0]?.getNotificationHandler();
        expect(notificationHandler).toBeTypeOf("function");
        if (!notificationHandler) {
          return;
        }

        notificationHandler({
          method: "session/update",
          params: {
            sessionId: "gemini-session-rollback-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Original answer",
              },
            },
          },
        });
        firstPromptResolve({ stopReason: "end_turn" });
        await firstTurnPromise;

        const secondTurnPromise = Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "Reverted prompt",
          }),
        );
        secondPromptResolve({ stopReason: "end_turn" });
        await secondTurnPromise;

        const rolledBack = await Effect.runPromise(adapter.rollbackThread(threadId, 1));
        expect(rolledBack.turns).toHaveLength(1);
        expect(clients).toHaveLength(2);

        await Effect.runPromise(
          adapter.sendTurn({
            threadId,
            input: "New prompt",
          }),
        );

        const secondPromptCall = clients[1]?.request.mock.calls.find(
          ([method]) => method === "session/prompt",
        );
        const promptPayload = secondPromptCall?.[1] as
          | {
              readonly prompt?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
            }
          | undefined;
        const bootstrapText = promptPayload?.prompt?.find((part) => part.type === "text")?.text;

        expect(bootstrapText).toContain(
          "Continue this conversation using the transcript context below.",
        );
        expect(bootstrapText).toContain("Original prompt");
        expect(bootstrapText).toContain("Original answer");
        expect(bootstrapText).not.toContain("Reverted prompt");
        expect(bootstrapText).toContain("Latest user request (answer this now):\nNew prompt");
      } finally {
        firstPromptResolve({ stopReason: "end_turn" });
        secondPromptResolve({ stopReason: "end_turn" });
        await Effect.runPromise(adapter.stopAll());
      }
    });
  });
});
