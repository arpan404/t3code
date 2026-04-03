import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  AssistantMessageEvent,
  ModelInfo,
  ResumeSessionConfig,
  SessionEvent,
  SessionConfig,
} from "@github/copilot-sdk";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

vi.mock("../githubCopilotSdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../githubCopilotSdk")>();
  return {
    ...actual,
    createGitHubCopilotClient: vi.fn(),
  };
});

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createGitHubCopilotClient,
  type GitHubCopilotClientLike,
  type GitHubCopilotSessionClient,
} from "../githubCopilotSdk";
import { GitHubCopilotAdapter } from "../Services/GitHubCopilotAdapter.ts";
import { makeGitHubCopilotAdapterLive } from "./GitHubCopilotAdapter.ts";

const mockedCreateGitHubCopilotClient = vi.mocked(createGitHubCopilotClient);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakeStartConfig = SessionConfig;

function makeFakeClient(options: {
  readonly models: ReadonlyArray<ModelInfo>;
}): GitHubCopilotClientLike & {
  readonly createSession: ReturnType<
    typeof vi.fn<(config: FakeStartConfig) => Promise<GitHubCopilotSessionClient>>
  >;
  readonly emitSessionEvent: (event: SessionEvent) => void;
} {
  const assistantMessageEvent: AssistantMessageEvent = {
    id: "assistant-message-1",
    type: "assistant.message",
    timestamp: new Date().toISOString(),
    parentId: null,
    data: {
      messageId: "assistant-message-1",
      content: "ok",
    },
  };
  const sessionListeners: Array<(event: SessionEvent) => void> = [];

  const createSession = vi.fn(
    async (config: FakeStartConfig): Promise<GitHubCopilotSessionClient> => ({
      sessionId: "copilot-session-1",
      on: vi.fn((listener: (event: SessionEvent) => void) => {
        sessionListeners.push(listener);
        return () => {
          const index = sessionListeners.indexOf(listener);
          if (index >= 0) {
            sessionListeners.splice(index, 1);
          }
        };
      }),
      disconnect: vi.fn(async () => undefined),
      send: vi.fn(async () => "message-1"),
      sendAndWait: vi.fn(async () => assistantMessageEvent),
      abort: vi.fn(async () => undefined),
      ...config,
    }),
  );

  return {
    listModels: vi.fn(async () => options.models),
    createSession,
    resumeSession: vi.fn(async (_sessionId: string, _config: ResumeSessionConfig) => {
      throw new Error("resumeSession should not be called in this test");
    }),
    getStatus: vi.fn(async () => ({ version: "test", protocolVersion: 1 })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, statusMessage: "ok" })),
    stop: vi.fn(async () => []),
    emitSessionEvent: (event: SessionEvent) => {
      for (const listener of sessionListeners) {
        listener(event);
      }
    },
  };
}

afterEach(() => {
  mockedCreateGitHubCopilotClient.mockReset();
});

const layer = it.layer(
  makeGitHubCopilotAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("GitHubCopilotAdapterLive startSession", (it) => {
  it.effect(
    "passes reasoning effort during startup when the selected Copilot model supports it",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [
            {
              id: "gpt-5",
              name: "GPT-5",
              capabilities: {
                supports: {
                  vision: false,
                  reasoningEffort: true,
                },
                limits: {
                  max_context_window_tokens: 200_000,
                },
              },
              supportedReasoningEfforts: ["medium", "high", "xhigh"],
              defaultReasoningEffort: "high",
            },
          ],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const session = yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-supported"),
          cwd: "/repo",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-5",
            options: {
              reasoningEffort: "xhigh",
            },
          },
          runtimeMode: "full-access",
        });

        assert.equal(session.model, "gpt-5");
        const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
        assert.equal(typeof createConfig?.onPermissionRequest, "function");
        assert.equal(typeof createConfig?.onUserInputRequest, "function");
        assert.equal(createConfig?.model, "gpt-5");
        assert.equal(createConfig?.reasoningEffort, "xhigh");
        assert.equal(createConfig?.workingDirectory, "/repo");
        assert.equal(createConfig?.streaming, true);

        yield* adapter.stopSession(asThreadId("thread-supported"));
      }),
  );

  it.effect(
    "omits reasoning effort during startup when the selected Copilot model does not support it",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              capabilities: {
                supports: {
                  vision: false,
                  reasoningEffort: false,
                },
                limits: {
                  max_context_window_tokens: 128_000,
                },
              },
            },
          ],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const session = yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-unsupported"),
          cwd: "/repo",
          modelSelection: {
            provider: "githubCopilot",
            model: "gpt-4.1",
            options: {
              reasoningEffort: "high",
            },
          },
          runtimeMode: "full-access",
        });

        assert.equal(session.model, "gpt-4.1");
        const createConfig = fakeClient.createSession.mock.calls[0]?.[0];
        assert.equal(typeof createConfig?.onPermissionRequest, "function");
        assert.equal(typeof createConfig?.onUserInputRequest, "function");
        assert.equal(createConfig?.model, "gpt-4.1");
        assert.equal("reasoningEffort" in (createConfig ?? {}), false);
        assert.equal(createConfig?.workingDirectory, "/repo");
        assert.equal(createConfig?.streaming, true);

        yield* adapter.stopSession(asThreadId("thread-unsupported"));
      }),
  );

  it.effect("emits context window updates from GitHub Copilot usage events", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const usageEventsFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "thread.token-usage.updated",
          ),
          2,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-usage"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-usage"),
        input: "Explain the repository.",
      });

      fakeClient.emitSessionEvent({
        id: "event-usage-info",
        type: "session.usage_info",
        timestamp: new Date().toISOString(),
        parentId: null,
        ephemeral: true,
        data: {
          tokenLimit: 128_000,
          currentTokens: 6_400,
          messagesLength: 3,
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-usage",
        type: "assistant.usage",
        timestamp: new Date().toISOString(),
        parentId: "event-usage-info",
        ephemeral: true,
        data: {
          model: "gpt-4.1",
          inputTokens: 512,
          cacheReadTokens: 128,
          outputTokens: 64,
          duration: 1_250,
        },
      });

      const events = Array.from(yield* Fiber.join(usageEventsFiber));

      assert.equal(events.length, 2);
      assert.equal(events[0]?.type, "thread.token-usage.updated");
      assert.equal(events[1]?.type, "thread.token-usage.updated");

      if (events[0]?.type !== "thread.token-usage.updated") {
        return;
      }
      if (events[1]?.type !== "thread.token-usage.updated") {
        return;
      }

      assert.equal(events[0].threadId, asThreadId("thread-usage"));
      assert.equal(events[0].turnId, events[1].turnId);
      assert.deepEqual(events[0].payload.usage, {
        usedTokens: 6_400,
        maxTokens: 128_000,
        lastUsedTokens: 6_400,
      });
      assert.deepEqual(events[1].payload.usage, {
        usedTokens: 6_400,
        maxTokens: 128_000,
        lastUsedTokens: 6_400,
        lastInputTokens: 512,
        lastCachedInputTokens: 128,
        lastOutputTokens: 64,
        durationMs: 1_250,
      });

      yield* adapter.stopSession(asThreadId("thread-usage"));
    }),
  );

  it.effect(
    "emits rich tool metadata and reasoning completions from GitHub Copilot session events",
    () =>
      Effect.gen(function* () {
        const fakeClient = makeFakeClient({
          models: [],
        });
        mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

        const adapter = yield* GitHubCopilotAdapter;
        const interestingEventsFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(adapter.streamEvents, (event) => {
              if (event.type === "item.started") {
                return event.payload.itemType === "file_change";
              }
              if (event.type === "item.completed") {
                return (
                  event.payload.itemType === "file_change" || event.payload.itemType === "reasoning"
                );
              }
              return false;
            }),
            3,
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          provider: "githubCopilot",
          threadId: asThreadId("thread-tooling"),
          cwd: "/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-tooling"),
          input: "Patch the chat timeline.",
        });

        fakeClient.emitSessionEvent({
          id: "event-assistant-tool-request",
          type: "assistant.message",
          timestamp: new Date().toISOString(),
          parentId: null,
          data: {
            messageId: "assistant-tool-request",
            content: "I will update the timeline and then explain the changes.",
            toolRequests: [
              {
                toolCallId: "tool-call-1",
                name: "apply_patch",
                arguments: {
                  filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
                },
                toolTitle: "Patch Messages Timeline",
                intentionSummary: "Update the message ordering UI",
              },
            ],
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-start",
          type: "tool.execution_start",
          timestamp: new Date().toISOString(),
          parentId: "event-assistant-tool-request",
          data: {
            toolCallId: "tool-call-1",
            toolName: "apply_patch",
            arguments: {
              filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
            },
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-tool-complete",
          type: "tool.execution_complete",
          timestamp: new Date().toISOString(),
          parentId: "event-tool-start",
          data: {
            toolCallId: "tool-call-1",
            success: true,
            result: {
              content: "Patch applied",
              detailedContent:
                "Updated MessagesTimeline.tsx to show ordered tool and thinking rows.",
            },
          },
        });

        fakeClient.emitSessionEvent({
          id: "event-reasoning-complete",
          type: "assistant.reasoning",
          timestamp: new Date().toISOString(),
          parentId: "event-tool-complete",
          data: {
            reasoningId: "reasoning-1",
            content: "The timeline needs assistant segment boundaries around tool execution.",
          },
        });

        const events = Array.from(yield* Fiber.join(interestingEventsFiber));
        assert.equal(events.length, 3);

        const toolStarted = events[0];
        const toolCompleted = events[1];
        const reasoningCompleted = events[2];

        assert.equal(toolStarted?.type, "item.started");
        assert.equal(toolCompleted?.type, "item.completed");
        assert.equal(reasoningCompleted?.type, "item.completed");

        if (toolStarted?.type !== "item.started") {
          return;
        }
        if (toolCompleted?.type !== "item.completed") {
          return;
        }
        if (reasoningCompleted?.type !== "item.completed") {
          return;
        }

        assert.equal(toolStarted.payload.title, "Patch Messages Timeline");
        assert.match(
          toolStarted.payload.detail ?? "",
          /apps\/web\/src\/components\/chat\/MessagesTimeline\.tsx/,
        );
        assert.deepEqual(toolStarted.payload.data, {
          toolName: "apply_patch",
          arguments: {
            filePath: "apps/web/src/components/chat/MessagesTimeline.tsx",
          },
        });

        assert.equal(toolCompleted.payload.itemType, "file_change");
        assert.equal(toolCompleted.payload.title, "Patch Messages Timeline");
        assert.match(
          toolCompleted.payload.detail ?? "",
          /Updated MessagesTimeline\.tsx to show ordered tool and thinking rows\./,
        );

        assert.equal(reasoningCompleted.payload.itemType, "reasoning");
        const reasoningData =
          reasoningCompleted.payload.data && typeof reasoningCompleted.payload.data === "object"
            ? (reasoningCompleted.payload.data as { content?: string })
            : {};
        assert.equal(
          reasoningData.content,
          "The timeline needs assistant segment boundaries around tool execution.",
        );

        yield* adapter.stopSession(asThreadId("thread-tooling"));
      }),
  );

  it.effect("sanitizes noisy GitHub Copilot tool wrapper metadata", () =>
    Effect.gen(function* () {
      const fakeClient = makeFakeClient({
        models: [],
      });
      mockedCreateGitHubCopilotClient.mockResolvedValue(fakeClient);

      const adapter = yield* GitHubCopilotAdapter;
      const toolStartedFiber = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(
            adapter.streamEvents,
            (event) =>
              event.type === "item.started" &&
              event.payload.data !== undefined &&
              typeof event.payload.data === "object" &&
              (event.payload.data as { toolName?: string }).toolName === "run_in_terminal",
          ),
          1,
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        provider: "githubCopilot",
        threadId: asThreadId("thread-sanitized-tooling"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-sanitized-tooling"),
        input: "Run the repository checks.",
      });

      fakeClient.emitSessionEvent({
        id: "event-assistant-tool-request-intent",
        type: "assistant.message",
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {
          messageId: "assistant-tool-request-intent",
          content: "I will run the repository checks.",
          toolRequests: [
            {
              toolCallId: "tool-call-intent",
              name: "run_in_terminal",
              arguments: {
                intent: "Running format & checks",
                command:
                  "cat package.json || true\nnode -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).join('\\n'))\"\nbun fmt && bun lint && bun typecheck",
              },
              toolTitle:
                'Report Intent - {"intent":"Running format & checks"} Running format & checks',
            },
          ],
        },
      });

      fakeClient.emitSessionEvent({
        id: "event-tool-start-intent",
        type: "tool.execution_start",
        timestamp: new Date().toISOString(),
        parentId: "event-assistant-tool-request-intent",
        data: {
          toolCallId: "tool-call-intent",
          toolName: "run_in_terminal",
          arguments: {
            intent: "Running format & checks",
            command:
              "cat package.json || true\nnode -e \"const p=require('./package.json'); console.log(Object.keys(p.scripts||{}).join('\\n'))\"\nbun fmt && bun lint && bun typecheck",
          },
        },
      });

      const [toolStarted] = Array.from(yield* Fiber.join(toolStartedFiber));
      assert.equal(toolStarted?.type, "item.started");

      if (toolStarted?.type !== "item.started") {
        return;
      }

      assert.equal(toolStarted.payload.title, "Running format & checks");
      assert.equal(toolStarted.payload.detail, "Running format & checks");
      assert.equal(/cat package\.json/.test(toolStarted.payload.detail ?? ""), false);

      yield* adapter.stopSession(asThreadId("thread-sanitized-tooling"));
    }),
  );
});
