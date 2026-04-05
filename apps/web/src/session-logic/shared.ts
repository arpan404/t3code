import { isToolLifecycleItemType, type OrchestrationThreadActivity } from "@ace/contracts";

import { compareActivityLifecycleRank, compareSequenceThenCreatedAt } from "../lib/activityOrder";
import type { PendingApproval, WorkLogEntry } from "./types";

export function requestKindFromRequestType(
  requestType: unknown,
): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractEmbeddedWorkLogText(value: string): string | null {
  for (const key of ["intent", "goal", "explanation", "summary"] as const) {
    const match = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "i").exec(value);
    const extracted = asTrimmedString(match?.[1]);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

export function sanitizeWorkLogText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const embedded = extractEmbeddedWorkLogText(trimmed);
  if (embedded) {
    return embedded;
  }

  const payloadBoundary = trimmed.indexOf(" - {");
  if (payloadBoundary > 0) {
    return trimmed.slice(0, payloadBoundary).trim();
  }

  return trimmed;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

export function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

export function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return typeof payload?.title === "string" ? sanitizeWorkLogText(payload.title) : null;
}

function extractIntentRecordText(record: Record<string, unknown> | null): string | null {
  if (!record) {
    return null;
  }

  for (const key of ["intent", "goal", "explanation", "summary"] as const) {
    const value = asTrimmedString(record[key]);
    if (!value) {
      continue;
    }
    const sanitized = sanitizeWorkLogText(value);
    if (normalizeIntentToolLabel(sanitized) === "report intent") {
      continue;
    }
    return normalizeIntentDisplayText(sanitized);
  }

  return null;
}

export function extractEmbeddedIntentText(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  if (!data) {
    return null;
  }

  const directIntent =
    extractIntentRecordText(asRecord(data.arguments)) ??
    extractIntentRecordText(asRecord(asRecord(data.item)?.input));
  if (directIntent) {
    return directIntent;
  }

  const intentionSummary = asTrimmedString(data.intentionSummary);
  if (intentionSummary) {
    return normalizeIntentDisplayText(sanitizeWorkLogText(intentionSummary));
  }

  const rawToolTitle = asTrimmedString(data.toolTitle);
  if (!rawToolTitle || !/^report intent\b/i.test(rawToolTitle)) {
    return null;
  }

  const sanitized = sanitizeWorkLogText(rawToolTitle);
  if (normalizeIntentToolLabel(sanitized) === "report intent") {
    return null;
  }
  return normalizeIntentDisplayText(sanitized);
}

export function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

export function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

export function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

export function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

export function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const createdAtComparison = compareSequenceThenCreatedAt(left, right);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

export function normalizeIntentToolLabel(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/[_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeIntentComparisonText(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase()
    .trim();
}

export function normalizeIntentDisplayText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const words = compact.split(" ").filter(Boolean);

  if (words.length >= 2 && words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const left = words.slice(0, midpoint).join(" ");
    const right = words.slice(midpoint).join(" ");
    if (normalizeIntentComparisonText(left) === normalizeIntentComparisonText(right)) {
      return left;
    }
  }

  return compact;
}
