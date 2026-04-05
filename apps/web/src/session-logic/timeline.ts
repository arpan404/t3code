import { type OrchestrationLatestTurn } from "@ace/contracts";

import { compareSequenceThenCreatedAt } from "../lib/activityOrder";
import type { ChatMessage, ProposedPlan, TimelineEntry, WorkLogEntry } from "./types";
import {
  normalizeIntentComparisonText,
  normalizeIntentDisplayText,
  normalizeIntentToolLabel,
} from "./shared";

function compareCompatibleTimelineSequence(
  left: number | undefined,
  right: number | undefined,
): number {
  if (
    left === undefined ||
    right === undefined ||
    left === right ||
    isTimestampDerivedSequence(left) !== isTimestampDerivedSequence(right)
  ) {
    return 0;
  }
  return left - right;
}

function isTimestampDerivedSequence(sequence: number): boolean {
  return sequence >= 1_000_000_000_000;
}

function isReportIntentWorkEntry(entry: WorkLogEntry): boolean {
  return (
    normalizeIntentToolLabel(entry.toolTitle) === "report intent" ||
    normalizeIntentToolLabel(entry.label) === "report intent" ||
    normalizeIntentToolLabel(entry.detail) === "report intent"
  );
}

function extractReportIntentText(entry: WorkLogEntry): string | null {
  for (const candidate of [entry.detail, entry.toolTitle, entry.label]) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }
    if (normalizeIntentToolLabel(trimmed) === "report intent") {
      continue;
    }
    return normalizeIntentDisplayText(trimmed);
  }
  return null;
}

function compareTimelineEntriesByOrder(
  left: {
    timelineEntry: TimelineEntry;
    sourceIndex: number;
    sequence?: number | undefined;
  },
  right: {
    timelineEntry: TimelineEntry;
    sourceIndex: number;
    sequence?: number | undefined;
  },
): number {
  const orderComparison =
    left.timelineEntry.kind === "work" && right.timelineEntry.kind === "work"
      ? compareSequenceThenCreatedAt(
          {
            createdAt: left.timelineEntry.createdAt,
            sequence: left.sequence,
          },
          {
            createdAt: right.timelineEntry.createdAt,
            sequence: right.sequence,
          },
        )
      : left.timelineEntry.createdAt.localeCompare(right.timelineEntry.createdAt) ||
        compareCompatibleTimelineSequence(left.sequence, right.sequence);
  if (orderComparison !== 0) {
    return orderComparison;
  }

  return (
    left.sourceIndex - right.sourceIndex ||
    left.timelineEntry.id.localeCompare(right.timelineEntry.id)
  );
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const rawEntriesBase = [
    ...messages.map((message) => ({
      timelineEntry: {
        id: message.id,
        kind: "message" as const,
        createdAt: message.createdAt,
        message,
      },
      sequence: message.sequence,
    })),
    ...proposedPlans.map((proposedPlan) => ({
      timelineEntry: {
        id: proposedPlan.id,
        kind: "proposed-plan" as const,
        createdAt: proposedPlan.createdAt,
        proposedPlan,
      },
    })),
    ...workEntries.map((entry) => ({
      timelineEntry: {
        id: entry.id,
        kind: "work" as const,
        createdAt: entry.createdAt,
        entry,
      },
      sequence: entry.sequence,
    })),
  ];
  const rawEntries = rawEntriesBase
    .map((entry, sourceIndex) => Object.assign(entry, { sourceIndex }))
    .toSorted(compareTimelineEntriesByOrder);

  const normalizedEntries: TimelineEntry[] = [];
  let pendingIntentText: string | null = null;
  let previousIntentFingerprint: string | null = null;

  for (const { timelineEntry: entry } of rawEntries) {
    if (entry.kind === "work" && isReportIntentWorkEntry(entry.entry)) {
      const intentText = extractReportIntentText(entry.entry);
      if (intentText) {
        const nextIntentFingerprint = normalizeIntentComparisonText(intentText);
        if (nextIntentFingerprint !== previousIntentFingerprint) {
          normalizedEntries.push({
            id: `intent:${entry.id}`,
            kind: "intent",
            createdAt: entry.createdAt,
            text: intentText,
          });
        }
        pendingIntentText = intentText;
        previousIntentFingerprint = nextIntentFingerprint;
      }
      continue;
    }

    if (entry.kind === "work" && pendingIntentText) {
      if (entry.entry.tone === "tool") {
        const attachedIntentText = normalizeIntentDisplayText(pendingIntentText);
        normalizedEntries.push({
          ...entry,
          entry: {
            ...entry.entry,
            intentText: attachedIntentText,
          },
        });
        pendingIntentText = null;
        previousIntentFingerprint = normalizeIntentComparisonText(attachedIntentText);
        continue;
      }

      normalizedEntries.push(entry);
      continue;
    }

    if (entry.kind === "work" && entry.entry.tone === "tool" && entry.entry.intentText) {
      const embeddedIntentText = normalizeIntentDisplayText(entry.entry.intentText);
      const nextIntentFingerprint = normalizeIntentComparisonText(embeddedIntentText);
      if (nextIntentFingerprint !== previousIntentFingerprint) {
        normalizedEntries.push({
          id: `intent:${entry.id}`,
          kind: "intent",
          createdAt: entry.createdAt,
          text: embeddedIntentText,
        });
      }
      normalizedEntries.push({
        ...entry,
        entry: {
          ...entry.entry,
          intentText: embeddedIntentText,
        },
      });
      previousIntentFingerprint = nextIntentFingerprint;
      continue;
    }

    previousIntentFingerprint = null;

    normalizedEntries.push(entry);
  }

  return normalizedEntries;
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}
