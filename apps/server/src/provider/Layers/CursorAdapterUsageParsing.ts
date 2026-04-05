import type { ProviderRuntimeEvent } from "@ace/contracts";

import { asObject, asRoundedNonNegativeInt } from "../unknown.ts";

export type CursorUsageSnapshot = Extract<
  ProviderRuntimeEvent,
  { type: "thread.token-usage.updated" }
>["payload"]["usage"];

/** Minimal turn shape needed for computing tool-use counts in usage snapshots. */
export type TurnUsageLike = Record<string, unknown> & {
  readonly toolCalls?: ReadonlyMap<string, unknown> | Map<string, unknown>;
};

export function cursorToolUseCount(turn: TurnUsageLike | undefined): number | undefined {
  const count = turn?.toolCalls?.size ?? 0;
  return count > 0 ? count : undefined;
}

export function buildCursorUsageSnapshot(
  update: Record<string, unknown>,
  turn: TurnUsageLike | undefined,
  inferredMaxTokens?: number,
):
  | {
      readonly usedTokens: number;
      readonly maxTokens?: number;
      readonly lastUsedTokens: number;
      readonly toolUses?: number;
    }
  | undefined {
  const usedTokens =
    asRoundedNonNegativeInt(update.used) ??
    asRoundedNonNegativeInt(update.usedTokens) ??
    asRoundedNonNegativeInt(update.used_tokens) ??
    asRoundedNonNegativeInt(update.promptTokenCount) ??
    asRoundedNonNegativeInt(update.prompt_token_count) ??
    asRoundedNonNegativeInt(update.lastPromptTokenCount) ??
    asRoundedNonNegativeInt(update.last_prompt_token_count);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    asRoundedNonNegativeInt(update.size) ??
    asRoundedNonNegativeInt(update.maxTokens) ??
    asRoundedNonNegativeInt(update.max_tokens) ??
    asRoundedNonNegativeInt(update.tokenLimit) ??
    asRoundedNonNegativeInt(update.token_limit) ??
    asRoundedNonNegativeInt(update.limit) ??
    inferredMaxTokens;
  const toolUses = cursorToolUseCount(turn);

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(toolUses !== undefined ? { toolUses } : {}),
  };
}

type CursorTokenCountTotals = {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

function readCursorTokenCountRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(record?.token_count) ?? asObject(record?.tokenCount);
}

function firstRoundedNonNegativeInt(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = asRoundedNonNegativeInt(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readCursorTokenCountTotals(value: unknown): CursorTokenCountTotals | undefined {
  const record = asObject(value);
  const tokenCount = readCursorTokenCountRecord(record);
  const inputTokens = firstRoundedNonNegativeInt(tokenCount, ["input_tokens", "inputTokens"]);
  const cachedReadTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_read_tokens",
    "cachedReadTokens",
  ]);
  const cachedWriteTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_write_tokens",
    "cachedWriteTokens",
  ]);
  const outputTokens = firstRoundedNonNegativeInt(tokenCount, ["output_tokens", "outputTokens"]);
  const reasoningOutputTokens = firstRoundedNonNegativeInt(tokenCount, [
    "thought_tokens",
    "thoughtTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const derivedTotalTokens =
    (inputTokens ?? 0) +
    (cachedReadTokens ?? 0) +
    (cachedWriteTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningOutputTokens ?? 0);
  const totalTokens =
    firstRoundedNonNegativeInt(tokenCount, ["total_tokens", "totalTokens"]) ??
    (derivedTotalTokens > 0 ? derivedTotalTokens : undefined);

  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedReadTokens === undefined &&
    cachedWriteTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

export function buildCursorTurnUsageSnapshot(
  value: unknown,
  turn: TurnUsageLike | undefined,
  lastUsageSnapshot: CursorUsageSnapshot | undefined,
  inferredMaxTokens?: number,
): CursorUsageSnapshot | undefined {
  const record = asObject(value);
  const usageRecord =
    asObject(record?.usage) ??
    asObject(record?.usageMetadata) ??
    asObject(record?.usage_metadata) ??
    asObject(asObject(record?._meta)?.usage) ??
    asObject(asObject(record?._meta)?.quota) ??
    record;
  const tokenCountTotals = readCursorTokenCountTotals(usageRecord);
  const contextUsage =
    usageRecord === undefined
      ? undefined
      : buildCursorUsageSnapshot(usageRecord, turn, inferredMaxTokens);
  const totalTokens =
    firstRoundedNonNegativeInt(usageRecord, ["totalTokens", "total_tokens"]) ??
    tokenCountTotals?.totalTokens;
  const inputTokens =
    firstRoundedNonNegativeInt(usageRecord, ["inputTokens", "input_tokens"]) ??
    tokenCountTotals?.inputTokens;
  const cachedReadTokens =
    firstRoundedNonNegativeInt(usageRecord, ["cachedReadTokens", "cached_read_tokens"]) ??
    tokenCountTotals?.cachedReadTokens;
  const cachedWriteTokens =
    firstRoundedNonNegativeInt(usageRecord, ["cachedWriteTokens", "cached_write_tokens"]) ??
    tokenCountTotals?.cachedWriteTokens;
  const outputTokens =
    firstRoundedNonNegativeInt(usageRecord, ["outputTokens", "output_tokens"]) ??
    tokenCountTotals?.outputTokens;
  const reasoningOutputTokens =
    firstRoundedNonNegativeInt(usageRecord, [
      "thoughtTokens",
      "thought_tokens",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? tokenCountTotals?.reasoningOutputTokens;
  const cachedInputTokens =
    (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) > 0
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;
  const toolUses = cursorToolUseCount(turn);
  const hasDetails =
    contextUsage !== undefined ||
    totalTokens !== undefined ||
    inputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningOutputTokens !== undefined ||
    toolUses !== undefined;

  if (!hasDetails) {
    return undefined;
  }

  const contextUsedTokens = lastUsageSnapshot?.usedTokens ?? contextUsage?.usedTokens;
  const usedTokens = contextUsedTokens ?? totalTokens;
  const maxTokens =
    lastUsageSnapshot?.maxTokens ??
    contextUsage?.maxTokens ??
    (contextUsedTokens !== undefined ? inferredMaxTokens : undefined);

  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(totalTokens !== undefined && totalTokens > 0
      ? { lastUsedTokens: totalTokens }
      : contextUsage?.lastUsedTokens !== undefined
        ? { lastUsedTokens: contextUsage.lastUsedTokens }
        : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0
      ? { lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(toolUses !== undefined
      ? { toolUses }
      : contextUsage?.toolUses !== undefined
        ? { toolUses: contextUsage.toolUses }
        : {}),
  };
}
