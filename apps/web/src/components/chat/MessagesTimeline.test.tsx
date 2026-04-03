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
  it("renders inline terminal labels with the composer chip UI", async () => {
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

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders context compaction entries in the normal work log", async () => {
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

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("renders assistant, tool, follow-up, and thinking rows in chronological order", async () => {
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
          "work-group:2026-03-17T19:12:29.500Z": true,
          "work-group:2026-03-17T19:12:31.500Z": true,
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
    const firstToolIndex = markup.indexOf("Read file");
    const followUpIndex = markup.indexOf("The timeline needed message segmentation.");
    const thinkingIndex = markup.indexOf("Segment assistant output around tool execution.");
    const secondToolIndex = markup.indexOf("Apply patch");

    expect(firstAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(firstToolIndex).toBeGreaterThan(firstAssistantIndex);
    expect(followUpIndex).toBeGreaterThan(firstToolIndex);
    expect(thinkingIndex).toBeGreaterThan(followUpIndex);
    expect(secondToolIndex).toBeGreaterThan(thinkingIndex);
    expect(markup).toContain('data-work-entry-tone="thinking"');
    expect(markup).toContain('data-completed-tool-calls="true"');
    expect(markup).toContain(">Thinking<");
    expect(markup).toContain(">Tool<");
  });

  it("prefers human-readable detail over noisy wrapper commands in tool rows", async () => {
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

    expect(markup).toContain("Running format &amp; checks");
    expect(markup).not.toContain("cat package.json");
  });

  it("renders very large completed tool-only runs inside one tool calls container", async () => {
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

    expect(markup).toContain('data-completed-tool-calls="true"');
    expect(markup).toContain('data-completed-tool-calls-open="true"');
    expect(markup).toContain("Tool calls (10)");
    expect(markup).toContain('data-work-entry-id="work-tool-1"');
    expect(markup).toContain('data-work-entry-id="work-tool-10"');
  });

  it("keeps live work groups collapsed even when an expanded state exists", async () => {
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
        expandedWorkGroups={{ "work-group:2026-03-17T19:12:20.000Z": true }}
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

    expect(markup).toContain("4 earlier hidden, showing latest 6");
    expect(markup).toContain(">Live<");
    expect(markup).not.toContain(">Expand<");
    expect(markup).not.toContain(">Show less<");
    expect(markup).not.toContain('data-work-entry-id="live-work-tool-1"');
    expect(markup).toContain('data-work-entry-id="live-work-tool-10"');
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
        expandedWorkGroups={{ "work-group:2026-03-17T19:12:31.500Z": true }}
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
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:33.000Z"
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

    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure-open="false"');
    expect(markup).toContain("Thinking (1)");
    expect(markup).toContain("Inspecting package scripts before patching the renderer.");
    expect(markup).not.toContain('data-work-entry-id="thinking-collapsed"');
  });

  it("visually attaches live thinking rows to a streaming assistant response", async () => {
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

    expect(markup).toContain('data-thinking-attached="true"');
    expect(markup).toContain('data-assistant-attached="true"');
    expect(markup).toContain("bg-card/8");
  });

  it("renders thinking rows with outline treatment instead of a filled background", async () => {
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
        expandedWorkGroups={{ "work-group:2026-03-17T19:12:31.500Z": true }}
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

    expect(markup).toContain("border-dashed");
    expect(markup).not.toContain("bg-amber-500/[0.035]");
    expect(markup).toContain('data-work-entry-tone="thinking"');
  });

  it("renders completed intent and tool activity inside one tool calls container", async () => {
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

    expect(markup).toContain("Running format and checks");
    expect(markup).toContain("bun fmt &amp;&amp; bun lint");
    expect(markup).toContain('data-completed-tool-calls="true"');
    expect(markup).toContain('data-completed-tool-calls-open="true"');
    expect(markup).toContain("Tool calls (1)");
    expect(markup).toContain(">Message<");
    expect(markup).toContain("1 intent update · 1 tool call");
    expect(markup).toContain("&quot;Running format and checks&quot;");
  });

  it("counts image views as tool calls in completed tool call containers", async () => {
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

    expect(markup).toContain("Tool calls (1)");
    expect(markup).not.toContain("1 image");
  });

  it("does not create an intent tool disclosure for thinking-only work", async () => {
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
          {
            id: "tool-after-thinking",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "tool-after-thinking",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Run command",
              toolTitle: "Run command",
              detail: "git ls-files",
              tone: "tool",
              intentText: "Counting files",
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

    expect(markup).toContain('data-intent-message="true"');
    expect(markup).not.toContain('data-intent-disclosure="true"');
    expect(markup).toContain('data-thinking-disclosure="true"');
    expect(markup).not.toContain("0 tool calls");
    expect(markup).toContain("git ls-files");
  });

  it("folds repeated completed intent bursts into one tool calls container", async () => {
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

    const renderedCompletedToolContainerCount = (
      markup.match(/data-completed-tool-calls="true"/g) ?? []
    ).length;

    expect(renderedCompletedToolContainerCount).toBe(1);
    expect(markup).toContain('data-completed-tool-calls-open="true"');
    expect(markup).toContain(">Message<");
    expect(markup).toContain('data-work-entry-id="tool-burst-1"');
    expect(markup).toContain('data-work-entry-id="tool-burst-2"');
  });

  it("honors explicit expansion state for completed tool call containers", async () => {
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
          "work-group:2026-03-17T19:12:30.000Z": false,
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

    expect(markup).toContain('data-completed-tool-calls-open="false"');
    expect(markup).toContain("Tool calls (2)");
    expect(markup).not.toContain('data-work-entry-id="tool-burst-primary-1"');
    expect(markup).not.toContain('data-work-entry-id="tool-burst-primary-2"');
  });
});
