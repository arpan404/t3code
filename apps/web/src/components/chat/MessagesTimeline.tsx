import { type MessageId, type TurnId } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { estimateTimelineMessageHeight } from "~/lib/chat/timelineHeight";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeMessageDurationStart,
  normalizeCompactToolLabel,
} from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const LARGE_TOOL_GROUP_SUMMARY_THRESHOLD = 10;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const durationStartByMessageId = computeMessageDurationStart(
      timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    );

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (!activeTurnInProgress && isCompletedToolBatchEntry(timelineEntry)) {
        const items: CompletedToolBatchItem[] = [toCompletedToolBatchItem(timelineEntry)];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || !isCompletedToolBatchEntry(nextEntry)) {
            break;
          }
          items.push(toCompletedToolBatchItem(nextEntry));
          cursor += 1;
        }

        if (countCompletedToolBatchCalls(items) > 0) {
          nextRows.push({
            kind: "completed-tool-calls",
            id: `completed-tool-calls:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            items,
          });
          index = cursor - 1;
          continue;
        }
      }

      if (timelineEntry.kind === "intent") {
        const groupedEntries: TimelineWorkEntry[] = [];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work" || nextEntry.entry.tone !== "tool") {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }

        if (groupedEntries.length > 0) {
          nextRows.push({
            kind: "intent-work",
            id: `intent-work:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            text: timelineEntry.text,
            groupedEntries,
            workCreatedAt: groupedEntries[0]?.createdAt ?? timelineEntry.createdAt,
          });
          index = cursor - 1;
          continue;
        }
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (
            !nextEntry ||
            nextEntry.kind !== "work" ||
            !canGroupAdjacentWorkEntries(groupedEntries[groupedEntries.length - 1], nextEntry.entry)
          ) {
            break;
          }
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "intent") {
        nextRows.push({
          kind: "intent",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          text: timelineEntry.text,
        });
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [
    timelineEntries,
    completionDividerBeforeEntryId,
    isWorking,
    activeTurnStartedAt,
    activeTurnInProgress,
  ]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Use stable row ids so virtual measurements do not leak across thread switches.
    getItemKey: (index: number) => rows[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") return 112;
      if (row.kind === "intent-work") return 160;
      if (row.kind === "completed-tool-calls") return 220;
      if (row.kind === "intent") return 76;
      if (row.kind === "proposed-plan") return estimateTimelineProposedPlanHeight(row.proposedPlan);
      if (row.kind === "working") return 40;
      return estimateTimelineMessageHeight(row.message, { timelineWidthPx });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const lastExpandableWorkRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (
        row?.kind === "work" ||
        row?.kind === "intent-work" ||
        row?.kind === "completed-tool-calls"
      ) {
        return row.id;
      }
    }
    return null;
  }, [rows]);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow, rowIndex: number) => {
    const previousRow = rowIndex > 0 ? rows[rowIndex - 1] : undefined;
    const nextRow = rowIndex + 1 < rows.length ? rows[rowIndex + 1] : undefined;
    const attachThinkingToStreamingAssistant =
      isThinkingWorkRow(row) && isStreamingAssistantMessageRow(nextRow);
    const attachStreamingAssistantToThinking =
      isStreamingAssistantMessageRow(row) && isThinkingWorkRow(previousRow);

    return (
      <div
        className={cn(
          "pb-4",
          attachThinkingToStreamingAssistant && "pb-1",
          attachStreamingAssistantToThinking && "-mt-1 pb-4",
        )}
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
        data-thinking-attached={attachThinkingToStreamingAssistant ? "true" : undefined}
        data-assistant-attached={attachStreamingAssistantToThinking ? "true" : undefined}
        data-intent-disclosure-open={
          row.kind === "intent-work"
            ? String(
                Object.prototype.hasOwnProperty.call(
                  expandedWorkGroups,
                  workGroupId(row.workCreatedAt),
                )
                  ? Boolean(expandedWorkGroups[workGroupId(row.workCreatedAt)])
                  : row.id === lastExpandableWorkRowId,
              )
            : undefined
        }
      >
        {row.kind === "completed-tool-calls" &&
          (() => {
            const groupId = workGroupId(row.createdAt);
            const hasExplicitExpandedState = Object.prototype.hasOwnProperty.call(
              expandedWorkGroups,
              groupId,
            );
            const isExpanded = hasExplicitExpandedState
              ? Boolean(expandedWorkGroups[groupId])
              : row.id === lastExpandableWorkRowId;
            const toolCallCount = countCompletedToolBatchCalls(row.items);
            const intentCount = countCompletedToolBatchIntents(row.items);

            return (
              <div
                className="rounded-2xl border border-border/50 bg-card/20 px-3 py-3"
                data-completed-tool-calls="true"
                data-completed-tool-calls-open={String(isExpanded)}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onToggleWorkGroup(groupId)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                      Tool calls ({toolCallCount})
                    </p>
                    <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      {isExpanded ? "Show less" : "Open"}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {intentCount > 0
                      ? `${intentCount} ${intentCount === 1 ? "intent update" : "intent updates"} · ${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`
                      : `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`}
                  </p>
                </button>
                {isExpanded && (
                  <div className="mt-3 space-y-1.5">
                    {row.items.map((item) =>
                      item.kind === "intent" ? (
                        <CompletedToolBatchIntentRow
                          key={`completed-tool-intent:${item.id}`}
                          text={item.text}
                        />
                      ) : (
                        <SimpleWorkEntryRow
                          key={`completed-tool-work:${item.entry.id}`}
                          workEntry={item.entry}
                          compact
                        />
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "work" &&
          (() => {
            const groupedEntries = row.groupedEntries;
            const groupId = workGroupId(row.createdAt);
            const isLiveWorkGroup = activeTurnInProgress && row.id === lastExpandableWorkRowId;
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const onlyThinkingEntries = groupedEntries.every((entry) => entry.tone === "thinking");
            const isExpanded = onlyThinkingEntries
              ? (expandedWorkGroups[groupId] ?? false)
              : isLiveWorkGroup
                ? false
                : (expandedWorkGroups[groupId] ?? false);
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries = onlyThinkingEntries
              ? isExpanded
                ? groupedEntries
                : []
              : hasOverflow && !isExpanded
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries;
            const hiddenCount = groupedEntries.length - visibleEntries.length;
            const hiddenEntries = hiddenCount > 0 ? groupedEntries.slice(0, hiddenCount) : [];
            const useToolSummaryRow =
              onlyToolEntries &&
              hiddenCount > 0 &&
              groupedEntries.length >= LARGE_TOOL_GROUP_SUMMARY_THRESHOLD &&
              !isExpanded;
            const thinkingPreview = onlyThinkingEntries
              ? summarizeThinkingGroupPreview(groupedEntries)
              : null;
            const showHeader = !useToolSummaryRow && (hasOverflow || !onlyToolEntries);
            const compactGroup = onlyToolEntries && groupedEntries.length >= 8;
            const groupLabel = onlyToolEntries
              ? "Tool calls"
              : onlyThinkingEntries
                ? "Thinking"
                : "Work log";

            return (
              <div
                className={cn(
                  "rounded-xl border border-border/45 px-2.5 py-2",
                  attachThinkingToStreamingAssistant &&
                    "rounded-b-md border-b-border/30 shadow-[0_0_0_1px_rgba(245,158,11,0.06)]",
                  compactGroup ? "bg-transparent" : "bg-card/20",
                )}
              >
                {onlyThinkingEntries ? (
                  <button
                    type="button"
                    className="mb-2 w-full rounded-lg border border-amber-500/20 bg-background/15 px-2.5 py-2 text-left transition-colors duration-150 hover:border-amber-500/30 hover:bg-background/20"
                    onClick={() => onToggleWorkGroup(groupId)}
                    data-thinking-disclosure="true"
                    data-thinking-disclosure-open={String(isExpanded)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        {groupLabel} ({groupedEntries.length})
                      </p>
                      <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/60">
                        {isExpanded ? "Hide" : "Open"}
                      </span>
                    </div>
                    {!isExpanded && thinkingPreview && (
                      <p className="mt-1.5 pr-6 font-mono text-[10px] italic leading-4 text-muted-foreground/68 line-clamp-2">
                        {thinkingPreview}
                      </p>
                    )}
                  </button>
                ) : (
                  showHeader && (
                    <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
                      <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                        {groupLabel} ({groupedEntries.length})
                      </p>
                      {hasOverflow && !isLiveWorkGroup && (
                        <button
                          type="button"
                          className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                          onClick={() => onToggleWorkGroup(groupId)}
                        >
                          {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                        </button>
                      )}
                      {hasOverflow && isLiveWorkGroup && (
                        <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/45">
                          Showing latest {visibleEntries.length}
                        </span>
                      )}
                    </div>
                  )
                )}
                <div className={cn(compactGroup ? "space-y-1" : "space-y-1.5")}>
                  {useToolSummaryRow && (
                    <CollapsedToolGroupSummaryRow
                      totalCount={groupedEntries.length}
                      hiddenCount={hiddenCount}
                      hiddenEntries={hiddenEntries}
                      canExpand={!isLiveWorkGroup}
                      onExpand={() => onToggleWorkGroup(groupId)}
                    />
                  )}
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      compact={compactGroup}
                      expandedThinking={onlyThinkingEntries && isExpanded}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

        {row.kind === "intent-work" &&
          (() => {
            const groupedEntries = row.groupedEntries;
            const groupId = workGroupId(row.workCreatedAt);
            const hasExplicitExpandedState = Object.prototype.hasOwnProperty.call(
              expandedWorkGroups,
              groupId,
            );
            const isCurrentIntentGroup = row.id === lastExpandableWorkRowId;
            const isExpanded = hasExplicitExpandedState
              ? Boolean(expandedWorkGroups[groupId])
              : isCurrentIntentGroup;
            const isLiveWorkGroup = activeTurnInProgress && isCurrentIntentGroup;
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries = isExpanded
              ? isLiveWorkGroup && hasOverflow
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries
              : [];
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const compactGroup = onlyToolEntries && groupedEntries.length >= 8;
            const toolCallCount = countToolCalls(groupedEntries);

            return (
              <div className="px-1 py-0.5" data-intent-disclosure="true">
                <button
                  type="button"
                  className="w-full px-0.5 py-1 text-left"
                  onClick={() => onToggleWorkGroup(groupId)}
                >
                  <p className="wrap-break-word text-[13px] leading-6 text-foreground/86">
                    <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      Message
                    </span>
                    <span>&quot;{row.text}&quot;</span>
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground/58">
                    {toolCallCount === 1 ? "1 tool call" : `${toolCallCount} tool calls`}
                    <span className="ml-2 uppercase tracking-[0.14em]">
                      {isExpanded ? "Hide" : "Open"}
                    </span>
                  </p>
                </button>
                {isExpanded && (
                  <div className="mt-2 border-l border-border/40 pl-3">
                    {isLiveWorkGroup && hasOverflow && (
                      <div className="mb-2 rounded-lg border border-border/50 bg-background/25 px-2.5 py-2 text-[10px] text-muted-foreground/60">
                        Showing latest {visibleEntries.length} of {groupedEntries.length} live tool
                        calls
                      </div>
                    )}
                    <div className={cn(compactGroup ? "space-y-1" : "space-y-1.5")}>
                      {visibleEntries.map((workEntry) => (
                        <SimpleWorkEntryRow
                          key={`intent-work-row:${workEntry.id}`}
                          workEntry={workEntry}
                          compact={compactGroup}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "intent" && (
          <div className="min-w-0 px-1 py-0.5" data-intent-message="true">
            <p className="wrap-break-word px-0.5 text-[13px] leading-6 text-foreground/84">
              <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55">
                Message
              </span>
              <span>&quot;{row.text}&quot;</span>
            </p>
          </div>
        )}

        {row.kind === "message" &&
          row.message.role === "user" &&
          (() => {
            const userImages = row.message.attachments ?? [];
            const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
            const terminalContexts = displayedUserMessage.contexts;
            const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
            return (
              <div className="flex justify-end">
                <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                  {userImages.length > 0 && (
                    <div className="mb-2 grid max-w-105 grid-cols-2 gap-2">
                      {userImages.map(
                        (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                          <div
                            key={image.id}
                            className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(userImages, image.id);
                                  if (!preview) return;
                                  onImageExpand(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full max-h-55 w-full object-cover"
                                  onLoad={onTimelineImageLoad}
                                  onError={onTimelineImageLoad}
                                />
                              </button>
                            ) : (
                              <div className="flex min-h-18 items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                                {image.name}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {(displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                    />
                  )}
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      {displayedUserMessage.copyText && (
                        <MessageCopyButton text={displayedUserMessage.copyText} />
                      )}
                      {canRevertAgentWork && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={isRevertingCheckpoint || isWorking}
                          onClick={() => onRevertUserMessage(row.message.id)}
                          title="Revert to this message"
                        >
                          <Undo2Icon className="size-3" />
                        </Button>
                      )}
                    </div>
                    <p className="text-right text-[10px] text-muted-foreground/30">
                      {formatTimestamp(row.message.createdAt, timestampFormat)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText =
              row.message.text || (row.message.streaming ? "" : "(empty response)");
            return (
              <>
                {row.showCompletionDivider && (
                  <div className="my-3 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      {completionSummary ? `Response • ${completionSummary}` : "Response"}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div
                  className={cn(
                    "min-w-0 px-1 py-0.5",
                    attachStreamingAssistantToThinking &&
                      "rounded-xl border border-border/35 bg-card/8 px-3 py-2.5",
                  )}
                >
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                  />
                  {(() => {
                    const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                    if (!turnSummary) return null;
                    const checkpointFiles = turnSummary.files;
                    if (checkpointFiles.length === 0) return null;
                    const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                    const changedFileCountLabel = String(checkpointFiles.length);
                    const allDirectoriesExpanded =
                      allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                    return (
                      <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                            <span>Changed files ({changedFileCountLabel})</span>
                            {hasNonZeroStat(summaryStat) && (
                              <>
                                <span className="mx-1">•</span>
                                <DiffStatLabel
                                  additions={summaryStat.additions}
                                  deletions={summaryStat.deletions}
                                />
                              </>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              data-scroll-anchor-ignore
                              onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                            >
                              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                              }
                            >
                              View diff
                            </Button>
                          </div>
                        </div>
                        <ChangedFilesTree
                          key={`changed-files-tree:${turnSummary.turnId}`}
                          turnId={turnSummary.turnId}
                          files={checkpointFiles}
                          allDirectoriesExpanded={allDirectoriesExpanded}
                          resolvedTheme={resolvedTheme}
                          onOpenTurnDiff={onOpenTurnDiff}
                        />
                      </div>
                    );
                  })()}
                  <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.durationStart, nowIso)
                        : formatElapsed(row.durationStart, row.message.completedAt),
                      timestampFormat,
                    )}
                  </p>
                </div>
              </>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <div className="min-w-0 px-1 py-0.5">
            <ProposedPlanCard
              planMarkdown={row.proposedPlan.planMarkdown}
              cwd={markdownCwd}
              workspaceRoot={workspaceRoot}
            />
          </div>
        )}

        {row.kind === "working" && (
          <div className="py-0.5 pl-1.5">
            <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
              <span className="inline-flex items-center gap-0.75">
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
              </span>
              <span>
                {row.createdAt
                  ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                  : "Working..."}
              </span>
            </div>
          </div>
        )}
      </div>
    );

    if (!hasMessages && !isWorking) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground/30">
            Send a message to start the conversation.
          </p>
        </div>
      );
    }

    return (
      <div
        ref={timelineRootRef}
        data-timeline-root="true"
        className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
      >
        {virtualizedRowCount > 0 && (
          <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {virtualRows.map((virtualRow: VirtualItem) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={`virtual-row:${row.id}`}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderRowContent(row, virtualRow.index)}
                </div>
              );
            })}
          </div>
        )}

        {nonVirtualizedRows.map((row) => (
          <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row, rows.indexOf(row))}</div>
        ))}
      </div>
    );
  };

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row, virtualRow.index)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row, index) => {
        const rowIndex = virtualizedRowCount + index;
        return <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row, rowIndex)}</div>;
      })}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type CompletedToolBatchItem =
  | Extract<TimelineEntry, { kind: "intent" }>
  | Extract<TimelineEntry, { kind: "work" }>;
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "intent-work";
      id: string;
      createdAt: string;
      text: string;
      groupedEntries: TimelineWorkEntry[];
      workCreatedAt: string;
    }
  | {
      kind: "intent";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "completed-tool-calls";
      id: string;
      createdAt: string;
      items: CompletedToolBatchItem[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

function estimateTimelineProposedPlanHeight(proposedPlan: TimelineProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function isCompletedToolBatchEntry(entry: TimelineEntry): entry is CompletedToolBatchItem {
  return entry.kind === "intent" || (entry.kind === "work" && entry.entry.tone !== "thinking");
}

function toCompletedToolBatchItem(entry: CompletedToolBatchItem): CompletedToolBatchItem {
  return entry;
}

function countCompletedToolBatchCalls(items: ReadonlyArray<CompletedToolBatchItem>): number {
  return items.filter((item) => item.kind === "work" && item.entry.tone === "tool").length;
}

function countCompletedToolBatchIntents(items: ReadonlyArray<CompletedToolBatchItem>): number {
  return items.filter((item) => item.kind === "intent").length;
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workGroupId(createdAt: string): string {
  return `work-group:${createdAt}`;
}

function isThinkingWorkRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "work" && row.groupedEntries.every((entry) => entry.tone === "thinking");
}

function canGroupAdjacentWorkEntries(
  previous: TimelineWorkEntry | undefined,
  next: TimelineWorkEntry,
): boolean {
  if (!previous) {
    return true;
  }

  return previous.tone === next.tone;
}

function isStreamingAssistantMessageRow(row: TimelineRow | undefined): boolean {
  return row?.kind === "message" && row.message.role === "assistant" && row.message.streaming;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
    </pre>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntrySurfaceClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") {
    return "border border-dashed border-amber-500/26 bg-transparent";
  }
  if (tone === "tool") {
    return "border border-border/50 bg-background/35";
  }
  if (tone === "error") {
    return "border border-rose-500/20 bg-rose-500/[0.04]";
  }
  return "border border-emerald-500/18 bg-emerald-500/[0.035]";
}

function workEntryBadgeLabel(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") return "Thinking";
  if (tone === "tool") return "Tool";
  if (tone === "error") return "Issue";
  return "Event";
}

function workEntryBadgeClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") {
    return "border-amber-500/28 bg-transparent text-amber-700 dark:text-amber-100";
  }
  if (tone === "tool") {
    return "border-border/60 bg-background/80 text-muted-foreground/75";
  }
  if (tone === "error") {
    return "border-rose-500/25 bg-rose-500/8 text-rose-700 dark:text-rose-100";
  }
  return "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-100";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  const detailPreview = workEntry.detail?.trim() || null;
  const commandPreview = normalizeWorkCommandPreview(workEntry.command);

  if (commandPreview && (!detailPreview || !isNoisyWorkCommandPreview(workEntry.command))) {
    return commandPreview;
  }
  if (detailPreview) return detailPreview;
  if (commandPreview) return commandPreview;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function summarizeThinkingGroupPreview(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const preview = workEntryPreview(entry);
    if (preview) {
      return preview;
    }
  }

  return null;
}

function normalizeWorkCommandPreview(command: string | undefined): string | null {
  if (!command) {
    return null;
  }
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function isNoisyWorkCommandPreview(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return (
    /[\r\n]/.test(command) ||
    /\|\||&&|;/.test(command) ||
    /\b(?:node|python|ruby)\s+-[ce]\b/.test(command) ||
    command.trim().length > 140
  );
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  compact?: boolean;
  expandedThinking?: boolean;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const badgeLabel = workEntryBadgeLabel(workEntry.tone);
  const compact = props.compact ?? false;
  const expandedThinking = props.expandedThinking ?? false;

  return (
    <div
      className={cn(
        "rounded-lg px-2.5 py-1.5",
        workEntrySurfaceClass(workEntry.tone),
        compact && "px-2 py-1.25",
      )}
      data-work-entry-id={workEntry.id}
      data-work-entry-tone={workEntry.tone}
    >
      <div className="flex items-start gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border/55 bg-background/70",
            compact && "size-4.5 rounded-sm",
            iconConfig.className,
          )}
        >
          <EntryIcon className={cn(compact ? "size-2.5" : "size-3")} />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.16em]",
                compact && "px-1.25 py-px text-[8px] tracking-[0.14em]",
                workEntryBadgeClass(workEntry.tone),
              )}
            >
              {badgeLabel}
            </span>
            <p
              className={cn(
                "min-w-0 truncate text-[11px] leading-5",
                compact && "text-[10px] leading-4.5",
                workEntry.tone === "thinking" && "tracking-[0.01em]",
                workToneClass(workEntry.tone),
                preview ? "text-muted-foreground/70" : "",
              )}
              title={displayText}
            >
              <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                {heading}
              </span>
            </p>
          </div>
          {preview && (
            <p
              className={cn(
                "pl-0.5 font-mono text-[10px] leading-4 text-muted-foreground/65",
                compact && "text-[9px] leading-3.5",
                workEntry.tone === "thinking"
                  ? expandedThinking
                    ? "whitespace-pre-wrap wrap-break-word font-normal italic text-muted-foreground/72"
                    : "line-clamp-4 whitespace-pre-wrap wrap-break-word font-normal italic text-muted-foreground/72"
                  : "truncate",
              )}
              title={preview}
            >
              {preview}
            </p>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className={cn("mt-1.5 flex flex-wrap gap-1 pl-7", compact && "mt-1 pl-6")}>
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

const CompletedToolBatchIntentRow = memo(function CompletedToolBatchIntentRow(props: {
  text: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/25 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-sm border border-border/55 bg-background/70 text-foreground/88">
          <BotIcon className="size-2.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-2">
            <span className="inline-flex shrink-0 items-center rounded-full border border-border/60 bg-background/80 px-1.25 py-px text-[8px] font-medium uppercase tracking-[0.14em] text-muted-foreground/75">
              Message
            </span>
          </div>
          <p className="wrap-break-word text-[11px] leading-5 text-foreground/78">
            &quot;{props.text}&quot;
          </p>
        </div>
      </div>
    </div>
  );
});

const CollapsedToolGroupSummaryRow = memo(function CollapsedToolGroupSummaryRow(props: {
  totalCount: number;
  hiddenCount: number;
  hiddenEntries: ReadonlyArray<TimelineWorkEntry>;
  canExpand: boolean;
  onExpand: () => void;
}) {
  const visibleCount = props.totalCount - props.hiddenCount;
  const hiddenBreakdown = summarizeToolGroupBreakdown(props.hiddenEntries);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/25 px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/58">
          {props.totalCount} tool calls
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/72">
          {props.hiddenCount} earlier hidden, showing latest {visibleCount}
        </p>
        {hiddenBreakdown && (
          <p className="mt-1 truncate text-[10px] text-muted-foreground/55">{hiddenBreakdown}</p>
        )}
      </div>
      {props.canExpand ? (
        <button
          type="button"
          className="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70 transition-colors duration-150 hover:border-foreground/20 hover:text-foreground/78"
          onClick={props.onExpand}
        >
          Expand
        </button>
      ) : (
        <span className="shrink-0 rounded-full border border-border/50 px-2 py-1 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/52">
          Live
        </span>
      )}
    </div>
  );
});

function summarizeToolGroupBreakdown(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  if (entries.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const category = summarizeToolGroupEntryType(entry);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .toSorted(
      (left, right) =>
        right[1] - left[1] ||
        toolBreakdownCategoryRank(left[0]) - toolBreakdownCategoryRank(right[0]) ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, 3)
    .map(([label, count]) => `${count} ${count === 1 ? label : `${label}s`}`);

  return parts.length > 0 ? parts.join(" · ") : null;
}

function countToolCalls(entries: ReadonlyArray<TimelineWorkEntry>): number {
  return entries.filter((entry) => entry.tone === "tool").length;
}

function toolBreakdownCategoryRank(category: string): number {
  switch (category) {
    case "file read":
      return 0;
    case "patch":
      return 1;
    case "command":
      return 2;
    case "search":
      return 3;
    case "image":
      return 4;
    default:
      return 5;
  }
}

function summarizeToolGroupEntryType(entry: TimelineWorkEntry): string {
  const titleText = `${entry.toolTitle ?? ""} ${entry.label}`.toLowerCase();

  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (entry.requestKind === "file-read") {
    return "file read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "patch";
  }
  if (entry.itemType === "web_search") {
    return "search";
  }
  if (entry.itemType === "image_view") {
    return "image";
  }
  if (/\b(read|view|open|cat|show)\b/.test(titleText)) {
    return "file read";
  }
  if (/\b(patch|edit|write|save|copy|update)\b/.test(titleText)) {
    return "patch";
  }
  if (/\b(command|bash|terminal|exec|run)\b/.test(titleText)) {
    return "command";
  }
  if (/\b(search|grep|rg|ripgrep|find)\b/.test(titleText)) {
    return "search";
  }
  return "tool call";
}
