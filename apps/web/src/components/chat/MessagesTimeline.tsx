import { type MessageId, type TurnId } from "@ace/contracts";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { deriveTimelineEntries } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
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
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { normalizeCompactToolLabel } from "~/lib/chat/messagesTimeline";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@ace/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "~/lib/chat/userMessageTerminalContexts";

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
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  revertActionTitle?: string;
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
  scrollContainer: _scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  revertActionTitle = "Revert to this message",
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: MessagesTimelineProps) {
  const rows = useMemo<TimelineRow[]>(
    () =>
      buildTimelineRows({
        timelineEntries,
        activeTurnInProgress,
        activeTurnStartedAt,
        completionDividerBeforeEntryId,
        completionSummary,
        isWorking,
        turnDiffSummaryByAssistantMessageId,
      }),
    [
      activeTurnInProgress,
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
    ],
  );
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow, _rowIndex: number) => {
    return (
      <div
        className="group/timeline relative pb-3"
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "work" && (
          <div className="min-w-0 border-border/35 border-l py-0.5 pl-4">
            <SimpleWorkEntryRow
              workEntry={row.workEntry}
              inlineIntentText={row.workEntry.intentText ?? null}
            />
            <p className="mt-1.5 pl-5.5 text-[10px] text-muted-foreground/30">
              {formatTimestamp(row.createdAt, timestampFormat)}
            </p>
          </div>
        )}

        {row.kind === "work-group" &&
          (() => {
            const groupId = workGroupId(row.id);
            const isExpanded = expandedWorkGroups[groupId] ?? false;
            const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
            const disclosureLabel = summarizeWorkGroupLabel(row.entries, row.summaryEndAt);
            const secondaryLabel = summarizeWorkGroupBreakdown(row.entries);
            const hasThinkingEntries = row.entries.some(
              (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
            );
            const hasToolEntries = row.entries.some(
              (entry) => entry.kind === "work" && entry.workEntry.tone === "tool",
            );
            const hasIntentEntries = row.entries.some((entry) => entry.kind === "intent");
            const threadGroupTone = hasToolEntries
              ? hasThinkingEntries
                ? "mixed"
                : "tool"
              : hasThinkingEntries
                ? "thinking"
                : hasIntentEntries
                  ? "intent"
                  : row.entries.some(
                        (entry) => entry.kind === "work" && entry.workEntry.tone === "error",
                      )
                    ? "error"
                    : "info";

            return (
              <div
                className={cn("min-w-0 border-l pl-4", workGroupRailClass(row.entries))}
                data-thread-group={threadGroupTone}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onToggleWorkGroup(groupId)}
                  data-meta-disclosure="true"
                  data-meta-disclosure-open={String(isExpanded)}
                  data-thinking-disclosure={hasThinkingEntries ? "true" : undefined}
                  data-thinking-disclosure-open={
                    hasThinkingEntries ? String(isExpanded) : undefined
                  }
                  data-tool-disclosure={hasToolEntries ? "true" : undefined}
                  data-tool-disclosure-open={hasToolEntries ? String(isExpanded) : undefined}
                >
                  <div className="flex items-start gap-3 py-1.5 transition-colors duration-100 hover:text-foreground/92">
                    <span className="mt-1 flex size-4 shrink-0 items-center justify-center text-muted-foreground/40 transition-transform duration-100 group-hover/timeline:text-foreground/55">
                      <ChevronIcon className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline justify-between gap-3">
                        <p className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/58">
                          {disclosureLabel}
                        </p>
                        <span className="shrink-0 text-[10px] text-muted-foreground/45">
                          {isExpanded ? "Hide log" : "Show log"}
                        </span>
                      </div>
                      <p className="wrap-break-word pt-1 text-[13px] leading-6 text-foreground/78">
                        {secondaryLabel}
                      </p>
                    </div>
                  </div>
                </button>
                {isExpanded && (
                  <div className="mt-2 space-y-2 border-border/25 border-l pl-4">
                    {row.entries.map((entry) =>
                      entry.kind === "work" ? (
                        <SimpleWorkEntryRow
                          key={`work-group:${row.id}:${entry.id}`}
                          workEntry={entry.workEntry}
                          inlineIntentText={null}
                        />
                      ) : (
                        <SimpleIntentEntryRow
                          key={`work-group:${row.id}:${entry.id}`}
                          entry={entry}
                        />
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })()}

        {row.kind === "intent" && (
          <div
            className="min-w-0 border-primary/18 border-l py-0.5 pr-1 pl-4"
            data-intent-message="true"
          >
            <p className="px-0.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
              Message
            </p>
            <p className="wrap-break-word px-0.5 pt-1 text-[13px] leading-6 text-foreground/84">
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
                <div
                  className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border/60 bg-secondary/60 px-4 py-3"
                  data-user-message-bubble="true"
                >
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
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
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
                          title={revertActionTitle}
                          aria-label={revertActionTitle}
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
              row.message.text.trim().length > 0
                ? row.message.text
                : row.message.streaming
                  ? ""
                  : "(empty response)";
            return (
              <div className="min-w-0 border-border/35 border-l py-0.5 pr-1 pl-4">
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
                    <div
                      className="mt-3 border-border/35 border-l pl-4"
                      data-turn-diff-summary="true"
                    >
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
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-0.5">
                  {row.completionSummary && (
                    <span
                      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/52"
                      data-response-summary="true"
                    >
                      <Clock3Icon className="size-3 shrink-0" />
                      <span>{row.completionSummary}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <div className="min-w-0 border-emerald-500/18 border-l py-0.5 pr-1 pl-4">
            <ProposedPlanCard
              planMarkdown={row.proposedPlan.planMarkdown}
              cwd={markdownCwd}
              workspaceRoot={workspaceRoot}
            />
          </div>
        )}

        {row.kind === "working" && (
          <div
            className={cn(
              "border-l py-0.5 pl-4",
              row.mode === "silent-thinking" ? "border-amber-500/26" : "border-border/35",
            )}
          >
            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
              {row.mode === "silent-thinking" ? "Thought" : "Live"}
            </p>
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/65">
              <span className="inline-flex items-center gap-1">
                <span className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/25 animate-pulse [animation-delay:400ms]" />
              </span>
              <span>
                {row.createdAt ? (
                  <WorkingTimer
                    createdAt={row.createdAt}
                    label={row.mode === "silent-thinking" ? "Thought for" : "Working for"}
                  />
                ) : row.mode === "silent-thinking" ? (
                  "Thought in progress..."
                ) : (
                  "Working..."
                )}
              </span>
            </div>
            {row.intentText && (
              <p
                className="mt-2 pl-0.5 text-[11px] leading-5 text-muted-foreground/68"
                data-inline-intent="true"
              >
                <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                  Intent
                </span>
                <span className="text-foreground/72">{row.intentText}</span>
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/25">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div data-timeline-root="true" className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden">
      {rows.map((row, index) => (
        <div key={`row:${row.id}`}>{renderRowContent(row, index)}</div>
      ))}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineMetaGroupEntry =
  | {
      kind: "intent";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      workEntry: TimelineWorkEntry;
    };
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      workEntry: TimelineWorkEntry;
    }
  | {
      kind: "work-group";
      id: string;
      createdAt: string;
      entries: TimelineMetaGroupEntry[];
      summaryEndAt: string | null;
    }
  | {
      kind: "intent";
      id: string;
      createdAt: string;
      text: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      completionSummary: string | null;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      mode: "live" | "silent-thinking";
      intentText: string | null;
    };

export function deriveFirstUnvirtualizedTimelineRowIndex(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    activeTurnInProgress: boolean;
    activeTurnStartedAt: string | null;
    preserveCurrentTurnTail: boolean;
  },
): number {
  const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
  if (!input.activeTurnInProgress || !input.preserveCurrentTurnTail) {
    return firstTailRowIndex;
  }

  const turnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
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
      (row) => row.kind === "message" && row.message.role === "assistant" && row.message.streaming,
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
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Self-contained timer that re-renders only itself every second. */
const WorkingTimer = memo(function WorkingTimer({
  createdAt,
  label,
}: {
  createdAt: string;
  label: string;
}) {
  const startedAtMs = Date.parse(createdAt);
  const [elapsed, setElapsed] = useState(() =>
    Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) : 0,
  );

  useEffect(() => {
    if (!Number.isFinite(startedAtMs)) return;
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAtMs]);

  return (
    <>
      {label} {formatElapsedSeconds(elapsed)}
    </>
  );
});

function buildTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  isWorking: boolean;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
}): TimelineRow[] {
  const nextRows: TimelineRow[] = [];
  const activeTurnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  const liveWorkEntryId = findTrailingLiveWorkEntryId(input.timelineEntries, {
    activeTurnInProgress: input.activeTurnInProgress,
    activeTurnStartedAtMs,
  });
  let hasRenderableCurrentTurnOutput = false;
  let lastMessageBoundaryAt: string | null = null;
  let pendingMetaRowId: string | null = null;
  let pendingMetaCreatedAt: string | null = null;
  let pendingMetaEntries: TimelineMetaGroupEntry[] = [];
  let pendingIntentEntries: Array<Extract<TimelineMetaGroupEntry, { kind: "intent" }>> = [];
  let activeLiveIntentText: string | null = null;

  const resetPendingMetaEntries = () => {
    pendingMetaEntries = [];
    pendingMetaRowId = null;
    pendingMetaCreatedAt = null;
  };

  const appendPendingIntentEntriesToMeta = (preferredRowId: string | null) => {
    if (pendingIntentEntries.length === 0) {
      return;
    }

    if (!pendingMetaCreatedAt) {
      pendingMetaCreatedAt = pendingIntentEntries[0]?.createdAt ?? null;
    }
    if (!pendingMetaRowId) {
      pendingMetaRowId = preferredRowId ?? pendingIntentEntries[0]?.id ?? null;
    }

    pendingMetaEntries.push(...pendingIntentEntries);
    pendingIntentEntries = [];
  };

  const consumeLatestPendingIntentText = () => {
    const latestIntentText = pendingIntentEntries.at(-1)?.text ?? null;
    pendingIntentEntries = [];
    return latestIntentText;
  };

  const flushPendingMetaEntries = (
    nextEventCreatedAt: string | null,
    options?: { includePendingIntents?: boolean },
  ) => {
    if (options?.includePendingIntents !== false) {
      appendPendingIntentEntriesToMeta(null);
    }

    if (pendingMetaEntries.length === 0 || !pendingMetaRowId || !pendingMetaCreatedAt) {
      resetPendingMetaEntries();
      return;
    }

    if (shouldCollapseMetaEntries(pendingMetaEntries)) {
      nextRows.push({
        kind: "work-group",
        id: pendingMetaRowId,
        createdAt: pendingMetaCreatedAt,
        entries: pendingMetaEntries,
        summaryEndAt: resolveWorkGroupSummaryEndAt(pendingMetaEntries, nextEventCreatedAt),
      });
    } else {
      for (const entry of pendingMetaEntries) {
        if (entry.kind === "work") {
          nextRows.push({
            kind: "work",
            id: entry.id,
            createdAt: entry.createdAt,
            workEntry: entry.workEntry,
          });
          continue;
        }

        nextRows.push({
          kind: "intent",
          id: entry.id,
          createdAt: entry.createdAt,
          text: entry.text,
        });
      }
    }

    resetPendingMetaEntries();
  };

  const pushPendingWorkEntry = (timelineEntry: Extract<TimelineEntry, { kind: "work" }>) => {
    if (timelineEntry.id === liveWorkEntryId) {
      flushPendingMetaEntries(timelineEntry.createdAt, { includePendingIntents: false });
      const liveIntentText = consumeLatestPendingIntentText();
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        workEntry: withInlineIntentText(timelineEntry.entry, liveIntentText),
      });
      return;
    }

    if (pendingMetaEntries.length === 0) {
      if (pendingIntentEntries.length > 0) {
        pendingMetaEntries = [...pendingIntentEntries];
        pendingMetaCreatedAt = pendingIntentEntries[0]?.createdAt ?? timelineEntry.createdAt;
        pendingIntentEntries = [];
      } else {
        pendingMetaCreatedAt = timelineEntry.createdAt;
      }
      pendingMetaRowId = timelineEntry.id;
    } else {
      appendPendingIntentEntriesToMeta(pendingMetaRowId);
    }

    pendingMetaEntries.push({
      kind: "work",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      workEntry: timelineEntry.entry,
    });
  };

  for (const timelineEntry of input.timelineEntries) {
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
        hasRenderableCurrentTurnOutput = true;
      }
      pushPendingWorkEntry(timelineEntry);
      continue;
    }

    if (timelineEntry.kind === "intent") {
      pendingIntentEntries.push({
        kind: "intent",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        text: timelineEntry.text,
      });
      continue;
    }

    flushPendingMetaEntries(timelineEntry.createdAt);

    if (timelineEntry.kind === "proposed-plan") {
      if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
        hasRenderableCurrentTurnOutput = true;
      }
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (
      timelineEntry.message.role === "assistant" &&
      shouldSkipAssistantMessageRow(
        timelineEntry.message,
        input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id),
      )
    ) {
      continue;
    }

    if (isEventInActiveTurn(timelineEntry.createdAt, activeTurnStartedAtMs)) {
      hasRenderableCurrentTurnOutput = true;
    }

    const durationStart = lastMessageBoundaryAt ?? timelineEntry.message.createdAt;
    if (timelineEntry.message.role === "user") {
      lastMessageBoundaryAt = timelineEntry.message.createdAt;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      completionSummary:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id
          ? input.completionSummary
          : null,
    });

    if (timelineEntry.message.role === "assistant" && timelineEntry.message.completedAt) {
      lastMessageBoundaryAt = timelineEntry.message.completedAt;
    }
  }

  if (input.isWorking && pendingIntentEntries.length > 0) {
    flushPendingMetaEntries(null, { includePendingIntents: false });
    activeLiveIntentText = consumeLatestPendingIntentText();
  } else {
    flushPendingMetaEntries(null);
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      mode: hasRenderableCurrentTurnOutput ? "live" : "silent-thinking",
      intentText: activeLiveIntentText,
    });
  }

  return nextRows;
}

function workGroupId(rowId: string): string {
  return `work-group:${rowId}`;
}

function shouldCollapseMetaEntries(entries: ReadonlyArray<TimelineMetaGroupEntry>): boolean {
  if (entries.some((entry) => entry.kind === "intent")) {
    return true;
  }

  if (entries.length !== 1) {
    return entries.length > 0;
  }

  const [entry] = entries;
  return (
    entry?.kind === "work" &&
    (entry.workEntry.tone === "thinking" || entry.workEntry.tone === "tool")
  );
}

function isEventInActiveTurn(createdAt: string, activeTurnStartedAtMs: number): boolean {
  if (Number.isNaN(activeTurnStartedAtMs)) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  return !Number.isNaN(createdAtMs) && createdAtMs >= activeTurnStartedAtMs;
}

function resolveWorkGroupSummaryEndAt(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  nextEventCreatedAt: string | null,
): string | null {
  if (typeof nextEventCreatedAt === "string") {
    return nextEventCreatedAt;
  }
  return entries.at(-1)?.createdAt ?? null;
}

function withInlineIntentText(
  workEntry: TimelineWorkEntry,
  intentText: string | null,
): TimelineWorkEntry {
  if (!intentText || workEntry.intentText === intentText) {
    return workEntry;
  }
  return {
    ...workEntry,
    intentText,
  };
}

function findTrailingLiveWorkEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: {
    activeTurnInProgress: boolean;
    activeTurnStartedAtMs: number;
  },
): string | null {
  if (!input.activeTurnInProgress) {
    return null;
  }

  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "work") {
      return isEventInActiveTurn(entry.createdAt, input.activeTurnStartedAtMs) ? entry.id : null;
    }
    return null;
  }

  return null;
}

function workGroupRailClass(entries: ReadonlyArray<TimelineMetaGroupEntry>): string {
  const hasThinking = entries.some(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
  );
  const hasTool = entries.some((entry) => entry.kind === "work" && entry.workEntry.tone === "tool");
  const hasIntent = entries.some((entry) => entry.kind === "intent");

  if (entries.some((entry) => entry.kind === "work" && entry.workEntry.tone === "error")) {
    return "border-rose-500/22";
  }
  if (hasThinking && !hasTool) {
    return "border-amber-500/26";
  }
  if (hasTool) {
    return "border-border/35";
  }
  if (hasIntent) {
    return "border-primary/18";
  }
  return "border-emerald-500/18";
}

function summarizeWorkGroupLabel(
  entries: ReadonlyArray<TimelineMetaGroupEntry>,
  summaryEndAt: string | null,
): string {
  const firstEntry = entries[0];
  const duration =
    firstEntry && summaryEndAt
      ? formatCompletedWorkTimer(firstEntry.createdAt, summaryEndAt)
      : null;

  return duration ? `Worked for ${duration}` : "Activity log";
}

function formatCompletedWorkTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(1, Math.ceil((endedAtMs - startedAtMs) / 1000));
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

function summarizeWorkGroupBreakdown(entries: ReadonlyArray<TimelineMetaGroupEntry>): string {
  const intentCount = entries.filter((entry) => entry.kind === "intent").length;
  const toolCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "tool",
  ).length;
  const thinkingCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "thinking",
  ).length;
  const errorCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "error",
  ).length;
  const infoCount = entries.filter(
    (entry) => entry.kind === "work" && entry.workEntry.tone === "info",
  ).length;
  const parts: string[] = [];

  if (intentCount > 0) {
    parts.push(intentCount === 1 ? "1 intent" : `${intentCount} intents`);
  }
  if (toolCount > 0) {
    parts.push(toolCount === 1 ? "1 tool call" : `${toolCount} tool calls`);
  }
  if (thinkingCount > 0) {
    parts.push(thinkingCount === 1 ? "1 reasoning step" : `${thinkingCount} reasoning steps`);
  }
  if (errorCount > 0) {
    parts.push(errorCount === 1 ? "1 issue" : `${errorCount} issues`);
  }
  if (infoCount > 0) {
    parts.push(infoCount === 1 ? "1 event" : `${infoCount} events`);
  }

  if (parts.length > 0) {
    return parts.join(" · ");
  }

  return entries.length === 1 ? "1 log entry" : `${entries.length} log entries`;
}

function shouldSkipAssistantMessageRow(
  message: TimelineMessage,
  turnSummary: TurnDiffSummary | undefined,
): boolean {
  if (message.role !== "assistant" || message.streaming) {
    return false;
  }
  if (turnSummary && turnSummary.files.length > 0) {
    return false;
  }
  return message.text.trim().length === 0;
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

function workEntryMarkerClass(tone: TimelineWorkEntry["tone"]): string {
  if (tone === "thinking") return "bg-amber-500/55";
  if (tone === "tool") return "bg-border";
  if (tone === "error") return "bg-rose-500/60";
  return "bg-emerald-500/60";
}

function workEntryDetailText(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  const detailText = workEntry.detail?.trim() || null;
  const commandText = normalizeWorkCommandText(workEntry.command);

  if (detailText) return detailText;
  if (commandText) return commandText;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function normalizeWorkCommandText(command: string | undefined): string | null {
  if (!command) {
    return null;
  }
  const normalized = command.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
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

const SimpleIntentEntryRow = memo(function SimpleIntentEntryRow(props: {
  entry: Extract<TimelineMetaGroupEntry, { kind: "intent" }>;
}) {
  return (
    <div className="pl-0.5" data-intent-message="true" data-meta-entry-kind="intent">
      <div className="flex items-start gap-2.5 transition-[opacity,translate] duration-200">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/55" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
            <SquarePenIcon className="size-3 shrink-0 text-foreground/88" />
            <p className="min-w-0 flex-1 truncate text-[12px] leading-5 text-muted-foreground/68">
              <span className="text-foreground/80">Intent</span>
            </p>
            <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
              Note
            </span>
          </div>
          <p className="pl-5.5 wrap-break-word whitespace-pre-wrap text-[11px] leading-5 text-foreground/72">
            {props.entry.text}
          </p>
        </div>
      </div>
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  inlineIntentText?: string | null;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const detailText = workEntryDetailText(workEntry);
  const displayText = detailText ? `${heading} - ${detailText}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const inlineIntentText = props.inlineIntentText?.trim() || null;
  const toneLabel =
    workEntry.tone === "thinking"
      ? "Thinking"
      : workEntry.tone === "tool"
        ? "Tool"
        : workEntry.tone === "error"
          ? "Issue"
          : "Event";

  return (
    <div className="pl-0.5" data-work-entry-id={workEntry.id} data-work-entry-tone={workEntry.tone}>
      <div className="flex items-start gap-2.5 transition-[opacity,translate] duration-200">
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            workEntryMarkerClass(workEntry.tone),
          )}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="mb-0.5 flex min-w-0 items-center gap-1.5">
            <EntryIcon className={cn("size-3 shrink-0", iconConfig.className)} />
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] leading-5",
                workEntry.tone === "thinking" && "tracking-[0.01em]",
                workToneClass(workEntry.tone),
                detailText ? "text-muted-foreground/70" : "",
              )}
              title={displayText}
            >
              <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                {heading}
              </span>
            </p>
            <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
              {toneLabel}
            </span>
          </div>
          {inlineIntentText && (
            <p
              className="mb-1 pl-5.5 text-[11px] leading-5 text-muted-foreground/68"
              data-inline-intent="true"
            >
              <span className="mr-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/38">
                Intent
              </span>
              <span className="text-foreground/72">{inlineIntentText}</span>
            </p>
          )}
          {detailText && (
            <p
              className={cn(
                "pl-5.5",
                workEntry.tone === "thinking"
                  ? "wrap-break-word whitespace-pre-wrap text-[11px] leading-5 text-foreground/72"
                  : "wrap-break-word whitespace-pre-wrap font-mono text-[10px] leading-5 text-muted-foreground/65",
              )}
              title={detailText}
            >
              {detailText}
            </p>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 pl-5.5">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="font-mono text-[10px] text-muted-foreground/75"
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
