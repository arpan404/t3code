import { type OrchestrationThreadActivity, type TurnId } from "@ace/contracts";

import type { WorkLogEntry } from "./types";
import {
  asTrimmedString,
  compareActivitiesByOrder,
  extractChangedFiles,
  extractEmbeddedIntentText,
  extractToolCommand,
  extractToolTitle,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
  sanitizeWorkLogText,
  stripTrailingExitCode,
} from "./shared";

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

export function findLatestRenderableWorkTurnId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnId | undefined {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const activity = ordered[index];
    if (!activity) {
      continue;
    }
    if (activity.turnId && isRenderableWorkLogActivity(activity)) {
      return activity.turnId;
    }
  }
  return undefined;
}

function isRenderableWorkLogActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated") {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  return !isPlanBoundaryToolActivity(activity);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const embeddedIntentText = extractEmbeddedIntentText(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    label: sanitizeWorkLogText(activity.summary),
    tone:
      activity.kind === "task.progress" ||
      activity.kind === "reasoning.completed" ||
      payload?.itemType === "reasoning"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(sanitizeWorkLogText(payload.detail)).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  if (command) {
    entry.command = command;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (embeddedIntentText && entry.tone === "tool") {
    entry.intentText = embeddedIntentText;
  }
  const collapseKey = deriveActivityCollapseKey(entry, payload, activity.turnId);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.collapseKey === undefined || previous.collapseKey !== next.collapseKey) {
    return false;
  }

  if (previous.tone === "thinking" && next.tone === "thinking") {
    return true;
  }

  if (
    !isToolLifecycleActivityKind(previous.activityKind) ||
    !isToolLifecycleActivityKind(next.activityKind)
  ) {
    return false;
  }

  return previous.activityKind !== "tool.completed";
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail =
    previous.tone === "thinking" && next.tone === "thinking"
      ? mergeThinkingWorkLogDetail(previous.detail, next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  return {
    ...previous,
    ...next,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined || next.sequence !== undefined
      ? { sequence: previous.sequence ?? next.sequence }
      : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
  };
}

function mergeThinkingWorkLogDetail(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }

  const needsSpace = /[A-Za-z0-9).!?]$/.test(previous) && /^[A-Za-z0-9(]/.test(next);
  return `${previous}${needsSpace ? " " : ""}${next}`;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function isToolLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function deriveActivityCollapseKey(
  entry: DerivedWorkLogEntry,
  payload: Record<string, unknown> | null,
  turnId: TurnId | null | undefined,
): string | undefined {
  const turnSegment = turnId ?? "none";
  if (entry.tone === "thinking") {
    const taskId = asTrimmedString(payload?.taskId);
    if (taskId) {
      return `thinking:${turnSegment}:${taskId}`;
    }
  }

  if (!isToolLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }

  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [turnSegment, itemType, normalizedLabel].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:start(?:ed)?|complete|completed)\s*$/i, "").trim();
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId?: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter(isRenderableWorkLogActivity)
    .map(toDerivedWorkLogEntry);
  return collapseDerivedWorkLogEntries(entries).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}
