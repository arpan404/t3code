import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { TurnId } from "@t3tools/contracts";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text?: string }) => <div>{text}</div>,
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("MessagesTimeline", () => {
  it("falls back to a small unvirtualized tail once work is no longer actively running", async () => {
    const { deriveFirstUnvirtualizedTimelineRowIndex } = await import("./MessagesTimeline");
    const rows = [
      {
        kind: "message" as const,
        id: "user-1",
        createdAt: "2026-03-17T19:12:20.000Z",
        message: {
          id: MessageId.makeUnsafe("user-1"),
          role: "user" as const,
          text: "Start",
          createdAt: "2026-03-17T19:12:20.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.000Z",
        completionSummary: null,
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        kind: "work" as const,
        id: `thinking-${index}`,
        createdAt: `2026-03-17T19:12:${21 + index}.000Z`,
        workEntry: {
          id: `thinking-entry-${index}`,
          createdAt: `2026-03-17T19:12:${21 + index}.000Z`,
          label: "Reasoning",
          detail: `step ${index}`,
          tone: "thinking" as const,
        },
      })),
    ];

    expect(
      deriveFirstUnvirtualizedTimelineRowIndex(rows, {
        activeTurnInProgress: true,
        activeTurnStartedAt: "2026-03-17T19:12:21.000Z",
        preserveCurrentTurnTail: false,
      }),
    ).toBe(rows.length - 8);
  });

  it("keeps the current turn tail expanded only while work is actively running", async () => {
    const { deriveFirstUnvirtualizedTimelineRowIndex } = await import("./MessagesTimeline");
    const rows = [
      {
        kind: "message" as const,
        id: "user-1",
        createdAt: "2026-03-17T19:12:20.000Z",
        message: {
          id: MessageId.makeUnsafe("user-1"),
          role: "user" as const,
          text: "Start",
          createdAt: "2026-03-17T19:12:20.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.000Z",
        completionSummary: null,
      },
      {
        kind: "message" as const,
        id: "assistant-1",
        createdAt: "2026-03-17T19:12:20.500Z",
        message: {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant" as const,
          text: "Working on it",
          createdAt: "2026-03-17T19:12:20.500Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:20.500Z",
        completionSummary: null,
      },
      {
        kind: "message" as const,
        id: "user-2",
        createdAt: "2026-03-17T19:12:21.000Z",
        message: {
          id: MessageId.makeUnsafe("user-2"),
          role: "user" as const,
          text: "Continue",
          createdAt: "2026-03-17T19:12:21.000Z",
          streaming: false,
        },
        durationStart: "2026-03-17T19:12:21.000Z",
        completionSummary: null,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: "work" as const,
        id: `tool-${index}`,
        createdAt: `2026-03-17T19:12:${22 + index}.000Z`,
        workEntry: {
          id: `tool-entry-${index}`,
          createdAt: `2026-03-17T19:12:${22 + index}.000Z`,
          label: "Run command",
          detail: `cmd ${index}`,
          tone: "tool" as const,
        },
      })),
      {
        kind: "working" as const,
        id: "working-indicator-row",
        createdAt: "2026-03-17T19:12:40.000Z",
        mode: "live" as const,
        intentText: null,
      },
    ];

    expect(
      deriveFirstUnvirtualizedTimelineRowIndex(rows, {
        activeTurnInProgress: true,
        activeTurnStartedAt: "2026-03-17T19:12:21.000Z",
        preserveCurrentTurnTail: true,
      }),
    ).toBe(2);
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain('data-user-message-bubble="true"');
    expect(markup).not.toContain('data-thread-row="true"');
  });

  it("uses custom restore copy for the revert action tooltip", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const messageId = MessageId.makeUnsafe("user-rebuildable-provider");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "user-rebuildable-provider",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: messageId,
              role: "user",
              text: "Restore me",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[messageId, 1]])}
        onRevertUserMessage={() => {}}
        revertActionTitle="Restore files and rebuild from this message"
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Restore files and rebuild from this message");
  });

  it("renders context compaction entries as normal work rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain('data-work-entry-id="work-1"');
  });

  it("renders assistant, tool, follow-up, thinking, and tool rows in chronological order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-1"),
              role: "assistant",
              text: "I inspected the workspace.",
              turnId: TurnId.makeUnsafe("turn-1"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
          {
            id: "work-tool-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.500Z",
            entry: {
              id: "work-tool-1",
              createdAt: "2026-03-17T19:12:29.500Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "src/session-logic.ts",
              tone: "tool",
            },
          },
          {
            id: "assistant-2",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-2"),
              role: "assistant",
              text: "The timeline needed message segmentation.",
              turnId: TurnId.makeUnsafe("turn-1"),
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
          {
            id: "thinking-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-1",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Segment assistant output around tool execution.",
              tone: "thinking",
            },
          },
          {
            id: "work-tool-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-tool-2",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Apply patch",
              toolTitle: "Apply patch",
              detail: "apps/web/src/components/chat/MessagesTimeline.tsx",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{
          "work-group:work-tool-1": true,
          "work-group:thinking-1": true,
          "work-group:work-tool-2": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const firstAssistantIndex = markup.indexOf("I inspected the workspace.");
    const firstToolIndex = markup.indexOf("src/session-logic.ts");
    const followUpIndex = markup.indexOf("The timeline needed message segmentation.");
    const thinkingIndex = markup.indexOf("Segment assistant output around tool execution.");
    const secondToolIndex = markup.indexOf("apps/web/src/components/chat/MessagesTimeline.tsx");

    expect(firstAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolIndex).toBeGreaterThan(firstAssistantIndex);
    expect(followUpIndex).toBeGreaterThan(firstToolIndex);
    expect(thinkingIndex).toBeGreaterThan(followUpIndex);
    expect(secondToolIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).toContain('data-work-entry-tone="thinking"');
    expect(markup).toContain('data-work-entry-id="work-tool-1"');
    expect(markup).toContain('data-work-entry-id="work-tool-2"');
    expect(markup).not.toContain('data-thread-row="true"');
  });

  it("skips blank assistant placeholder rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-empty",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-empty"),
              role: "assistant",
              text: "  \n",
              turnId: TurnId.makeUnsafe("turn-empty"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:28.500Z",
              streaming: false,
            },
          },
          {
            id: "tool-after-empty",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "tool-after-empty",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "assistant-visible",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-visible"),
              role: "assistant",
              text: "Here is the actual response.",
              turnId: TurnId.makeUnsafe("turn-empty"),
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{ "work-group:tool-after-empty": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-message-id="assistant-empty"');
    expect(markup).toContain("README.md");
    expect(markup).toContain("Here is the actual response.");
  });

  it("prefers human-readable detail over noisy wrapper commands in tool rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "work-tool-noisy-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-tool-noisy-command",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Running format & checks",
              toolTitle: "Running format & checks",
              detail: "Running format & checks",
              command:
                "cat package.json || true\nnode -e \"const p=require('./package.json')\"\nbun fmt && bun lint && bun typecheck",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format &amp; checks");
    expect(markup).not.toContain("cat package.json");
  });

  it("collapses completed tool-only runs until expanded", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const hiddenEntries = [
      { label: "Read file", toolTitle: "Read file" },
      { label: "Open file", toolTitle: "Open file" },
      { label: "Apply patch", toolTitle: "Apply patch" },
      { label: "Run command", toolTitle: "Run command" },
    ];
    const visibleEntries = Array.from({ length: 6 }, (_, index) => ({
      label: `Tool ${index + 5}`,
      toolTitle: `Tool ${index + 5}`,
    }));
    const timelineEntries = [...hiddenEntries, ...visibleEntries].map((entry, index) => ({
      id: `work-tool-${index + 1}`,
      kind: "work" as const,
      createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
      entry: {
        id: `work-tool-${index + 1}`,
        createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
        label: entry.label,
        toolTitle: entry.toolTitle,
        detail: `detail ${index + 1}`,
        tone: "tool" as const,
      },
    }));

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:40.000Z"
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).toContain('data-tool-disclosure-open="false"');
    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).toContain("Worked for 9s");
    expect(markup).toContain("10 tool calls");
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-background/70");
    expect(markup).not.toContain('data-work-entry-id="work-tool-1"');
    expect(markup).not.toContain('data-work-entry-id="work-tool-10"');
  });

  it("keeps the current live work row visible while earlier live work can expand", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const timelineEntries = Array.from({ length: 10 }, (_, index) => ({
      id: `live-work-tool-${index + 1}`,
      kind: "work" as const,
      createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
      entry: {
        id: `live-work-tool-${index + 1}`,
        createdAt: `2026-03-17T19:12:${String(20 + index).padStart(2, "0")}.000Z`,
        label: `Live Tool ${index + 1}`,
        toolTitle: `Live Tool ${index + 1}`,
        detail: `live detail ${index + 1}`,
        tone: "tool" as const,
      },
    }));

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:20.000Z"
        scrollContainer={null}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:40.000Z"
        expandedWorkGroups={{ "work-group:live-work-tool-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain("9 tool calls");
    expect(markup).toContain('data-work-entry-id="live-work-tool-1"');
    expect(markup).toContain('data-work-entry-id="live-work-tool-10"');
  });

  it("keeps completed tool rows before the active turn alongside live rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:35.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "old-tool-before-turn",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "old-tool-before-turn",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "README.md",
              tone: "tool",
            },
          },
          {
            id: "new-tool-during-turn",
            kind: "work",
            createdAt: "2026-03-17T19:12:36.000Z",
            entry: {
              id: "new-tool-during-turn",
              createdAt: "2026-03-17T19:12:36.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:40.000Z"
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("1 tool call");
    expect(markup).not.toContain("README.md");
    expect(markup).toContain("bun lint");
    expect(markup.indexOf("1 tool call")).toBeLessThan(markup.indexOf("bun lint"));
  });

  it("shows accumulated thinking text instead of a single truncated token line", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-accumulated",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-accumulated",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail:
                "Inspecting package.json and lockfiles to determine available scripts before patching the renderer.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{ "work-group:thinking-accumulated": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      "Inspecting package.json and lockfiles to determine available scripts before patching the renderer.",
    );
    expect(markup).not.toContain("line-clamp-4");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("text-[11px] leading-5 text-foreground/72");
    expect(markup).not.toContain("font-mono text-[10px] leading-4 text-muted-foreground/65");
  });

  it("keeps thinking disclosures collapsed by default until expanded", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-collapsed",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-collapsed",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Inspecting package scripts before patching the renderer.",
              tone: "thinking",
            },
          },
          {
            id: "thinking-collapsed-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.500Z",
            entry: {
              id: "thinking-collapsed-2",
              createdAt: "2026-03-17T19:12:33.500Z",
              label: "Reasoning",
              detail: "Comparing the grouped timeline behavior after the patch.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure-open="false"');
    expect(markup).toContain("Worked for 2s");
    expect(markup).not.toContain('data-work-entry-id="thinking-collapsed"');
    expect(markup).not.toContain('data-work-entry-id="thinking-collapsed-2"');
    expect(markup).not.toContain("Inspecting package scripts before patching the renderer.");
    expect(markup).not.toContain("Comparing the grouped timeline behavior after the patch.");
  });

  it("measures completed thinking until the nearest next event", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-next-event-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.100Z",
            entry: {
              id: "thinking-next-event-1",
              createdAt: "2026-03-17T19:12:31.100Z",
              label: "Reasoning",
              detail: "Checking the existing render boundary.",
              tone: "thinking",
            },
          },
          {
            id: "thinking-next-event-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.600Z",
            entry: {
              id: "thinking-next-event-2",
              createdAt: "2026-03-17T19:12:31.600Z",
              label: "Reasoning",
              detail: "Preparing the grouped summary after the reasoning block.",
              tone: "thinking",
            },
          },
          {
            id: "tool-after-thinking",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.400Z",
            entry: {
              id: "tool-after-thinking",
              createdAt: "2026-03-17T19:12:33.400Z",
              label: "Read file",
              detail: "Opening the patched timeline component.",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:40.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const thinkingIndex = markup.indexOf("Worked for 3s");
    const toolIndex = markup.indexOf('data-work-entry-id="tool-after-thinking"');

    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).not.toContain("Worked for 1s");
  });

  it("moves completed thinking behind a disclosure once assistant output starts", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-live",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "thinking-live",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Reasoning",
              detail: "Inspecting the package scripts before composing the response.",
              tone: "thinking",
            },
          },
          {
            id: "assistant-streaming",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-streaming"),
              role: "assistant",
              text: "Running checks now.",
              turnId: TurnId.makeUnsafe("turn-live"),
              createdAt: "2026-03-17T19:12:32.000Z",
              streaming: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const thinkingIndex = markup.indexOf('data-thinking-disclosure="true"');
    const assistantIndex = markup.indexOf('data-message-id="assistant-streaming"');

    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).not.toContain('data-work-entry-id="thinking-live"');
  });

  it("renders thinking rows inside the thread log without the old card treatment", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-outline",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-outline",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Tracing the ordering boundary before patching the renderer.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{ "work-group:thinking-outline": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).not.toContain("bg-amber-500/[0.035]");
    expect(markup).not.toContain("rounded-xl border border-border/45 bg-background/70");
    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain('data-work-entry-tone="thinking"');
    expect(markup).toContain("Tracing the ordering boundary before patching the renderer.");
    expect(markup).toContain("Worked for 1s");
  });

  it("keeps assistant follow-ups beneath the preceding work row in order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:31.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "work-tool-followup",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-tool-followup",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "apps/web/src/session-logic.ts",
              tone: "tool",
            },
          },
          {
            id: "assistant-followup",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-followup"),
              role: "assistant",
              text: "Found the next grouping edge case.",
              turnId: TurnId.makeUnsafe("turn-followup"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:34.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const workIndex = markup.indexOf('data-tool-disclosure="true"');
    const assistantIndex = markup.indexOf('data-message-id="assistant-followup"');

    expect(workIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(workIndex);
    expect(markup).toContain("Found the next grouping edge case.");
    expect(markup).not.toContain('data-work-entry-id="work-tool-followup"');
  });

  it("renders changed-files summaries after preceding work without swallowing the next turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("assistant-with-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "tool-before-diff",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-before-diff",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
            },
          },
          {
            id: "assistant-with-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:32.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the timeline rendering.",
              turnId: TurnId.makeUnsafe("turn-diff"),
              createdAt: "2026-03-17T19:12:32.000Z",
              completedAt: "2026-03-17T19:12:33.000Z",
              streaming: false,
            },
          },
          {
            id: "user-after-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:34.000Z",
            message: {
              id: MessageId.makeUnsafe("user-after-diff"),
              role: "user",
              text: "Thanks, now fix the spacing below it.",
              createdAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff"),
                completedAt: "2026-03-17T19:12:33.500Z",
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 10,
                    deletions: 2,
                  },
                  {
                    path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
                    additions: 4,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-turn-diff-summary="true"');
    expect(markup).toContain("Changed files (2)");
    expect(markup.indexOf("bun lint")).toBeLessThan(
      markup.indexOf("Updated the timeline rendering."),
    );
    expect(markup.indexOf("Updated the timeline rendering.")).toBeLessThan(
      markup.indexOf("Changed files (2)"),
    );
    expect(markup.indexOf("Changed files (2)")).toBeLessThan(
      markup.indexOf("Thanks, now fix the spacing below it."),
    );
  });

  it("shows completed intent and tool activity after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-after-intent",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-after-intent",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt && bun lint",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{ "work-group:tool-after-intent": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format and checks");
    expect(markup).toContain("bun fmt &amp;&amp; bun lint");
    expect(markup).toContain('data-work-entry-id="tool-after-intent"');
    expect(markup.indexOf("Running format and checks")).toBeLessThan(
      markup.indexOf("bun fmt &amp;&amp; bun lint"),
    );
  });

  it("shows completed image-view tool calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-image-view",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Reviewing screenshot",
          },
          {
            id: "image-view-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "image-view-tool",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "View image",
              toolTitle: "View image",
              detail: "screenshot.png",
              tone: "tool",
              itemType: "image_view",
              intentText: "Reviewing screenshot",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{ "work-group:image-view-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Reviewing screenshot");
    expect(markup).toContain("screenshot.png");
    expect(markup).toContain('data-work-entry-id="image-view-tool"');
  });

  it("groups completed intent and thinking work into the same disclosure", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-counting-files",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Counting files",
          },
          {
            id: "thinking-after-intent",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "thinking-after-intent",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Reasoning",
              detail: "Checking tracked files before counting everything on disk.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-meta-disclosure="true"');
    expect(markup).not.toContain('data-intent-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain("1 intent · 1 reasoning step");
    expect(markup).not.toContain("0 tool calls");
  });

  it("keeps repeated completed intent bursts with tool calls in chronological order", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-burst-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
          {
            id: "intent-2",
            kind: "intent",
            createdAt: "2026-03-17T19:12:32.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "tool-burst-2",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun lint",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{
          "work-group:tool-burst-1": true,
          "work-group:tool-burst-2": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const firstIntentIndex = markup.indexOf("Running format and checks");
    const firstToolIndex = markup.indexOf("bun fmt");
    const secondIntentIndex = markup.indexOf("Running format and checks", firstIntentIndex + 1);
    const secondToolIndex = markup.indexOf("bun lint");

    expect(firstIntentIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolIndex).toBeGreaterThan(firstIntentIndex);
    expect(secondIntentIndex).toBeGreaterThan(firstToolIndex);
    expect(secondToolIndex).toBeGreaterThan(secondIntentIndex);
    expect(markup.match(/data-intent-message="true"/g) ?? []).toHaveLength(2);
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain('data-work-entry-id="tool-burst-1"');
    expect(markup).toContain('data-work-entry-id="tool-burst-2"');
  });

  it("keeps repeated live intent bursts separate while only the current tool stays inline", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-live-1",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Exploring cursor flow",
          },
          {
            id: "tool-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-live-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              toolTitle: "Read file",
              detail: "apps/server/src/provider/Layers/ProviderService.ts",
              tone: "tool",
              intentText: "Exploring cursor flow",
            },
          },
          {
            id: "intent-live-2",
            kind: "intent",
            createdAt: "2026-03-17T19:12:32.000Z",
            text: "Exploring cursor flow",
          },
          {
            id: "tool-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "tool-live-2",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Search code",
              toolTitle: "Search code",
              detail: "apps/web/src/components/chat/MessagesTimeline.tsx",
              tone: "tool",
              intentText: "Exploring cursor flow",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-intent-message="true"/g) ?? []).toHaveLength(0);
    expect(markup.match(/data-inline-intent="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain('data-tool-disclosure="true"');
    expect(markup).not.toContain("ProviderService.ts");
    expect(markup).toContain("Intent");
    expect(markup).toContain("Exploring cursor flow");
    expect(markup).toContain("MessagesTimeline.tsx");
  });

  it("moves the final response summary into the assistant footer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-summary-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-summary-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId="assistant-summary-row"
        completionSummary="Worked for 2m 20s"
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-response-summary="true"');
    expect(markup).toContain("Worked for 2m 20s");
    expect(markup).not.toContain("•");
  });

  it("does not render time metadata beneath assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-no-meta-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-no-meta-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("19:12:31");
    expect(markup).not.toContain("•");
  });

  it("does not render an assistant header for assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-no-header-row",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-no-header-message"),
              role: "assistant",
              text: "Updated the timeline rendering.",
              createdAt: "2026-03-17T19:12:31.500Z",
              completedAt: "2026-03-17T19:12:34.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("Assistant");
    expect(markup).toContain("Updated the timeline rendering.");
  });

  it("keeps a trailing live intent inside the live status row when no tool has started yet", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-only-live",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Inspecting the provider transcript before responding",
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-intent-message="true"');
    expect(markup).toContain('data-inline-intent="true"');
    expect(markup).toContain("Inspecting the provider transcript before responding");
  });

  it("uses the matching group id when expanding completed tool calls", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "intent-primary",
            kind: "intent",
            createdAt: "2026-03-17T19:12:30.000Z",
            text: "Running format and checks",
          },
          {
            id: "tool-burst-primary-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "tool-burst-primary-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun fmt",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
          {
            id: "tool-burst-primary-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.100Z",
            entry: {
              id: "tool-burst-primary-2",
              createdAt: "2026-03-17T19:12:31.100Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "bun typecheck",
              tone: "tool",
              intentText: "Running format and checks",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:35.000Z"
        expandedWorkGroups={{
          "work-group:tool-burst-primary-1": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running format and checks");
    expect(markup).toContain('data-tool-disclosure-open="true"');
    expect(markup).toContain("bun fmt");
    expect(markup).toContain("bun typecheck");
    expect(markup).toContain('data-work-entry-id="tool-burst-primary-1"');
    expect(markup).toContain('data-work-entry-id="tool-burst-primary-2"');
  });

  it("keeps separate work disclosures isolated when they share a timestamp", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-first",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-first",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "First thinking block.",
              tone: "thinking",
            },
          },
          {
            id: "assistant-between-thinking",
            kind: "message",
            createdAt: "2026-03-17T19:12:31.500Z",
            message: {
              id: MessageId.makeUnsafe("assistant-between-thinking"),
              role: "assistant",
              text: "keeping rows separate",
              createdAt: "2026-03-17T19:12:31.500Z",
              streaming: false,
            },
          },
          {
            id: "thinking-second",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.500Z",
            entry: {
              id: "thinking-second",
              createdAt: "2026-03-17T19:12:31.500Z",
              label: "Reasoning",
              detail: "Second thinking block.",
              tone: "thinking",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
        expandedWorkGroups={{ "work-group:thinking-second": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-thinking-disclosure="true"/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain('data-work-entry-id="thinking-first"');
    expect(markup).toContain('data-work-entry-id="thinking-second"');
  });
});
