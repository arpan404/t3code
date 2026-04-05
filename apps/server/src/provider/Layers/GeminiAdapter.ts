import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { inferModelContextWindowTokens } from "@ace/shared/model";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { meaningfulErrorMessage } from "../errorCause.ts";
import { logWarningEffect, runLoggedEffect } from "../fireAndForget.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import {
  asArrayOrEmpty as asArray,
  asNonEmptyString as asString,
  asObject,
  asRoundedNonNegativeInt,
} from "../unknown.ts";
import {
  AcpRequestError,
  startAcpClient,
  type AcpClient,
  type AcpJsonRpcId,
  type AcpNotification,
  type AcpRequest,
} from "../acpClient.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type GeminiAdapterShape, GeminiAdapter } from "../Services/GeminiAdapter.ts";

const PROVIDER = "gemini" as const;
const ACP_CONTROL_TIMEOUT_MS = 20_000;
const ACP_PROTOCOL_VERSION = 1;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;
export const GEMINI_ACP_CLIENT_INFO = {
  name: "ace",
  version: "1.0.17",
} as const;

export function buildGeminiInitializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientInfo: GEMINI_ACP_CLIENT_INFO,
    clientCapabilities: {
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    },
  };
}

export function canGeminiSetSessionMode(metadata: Pick<GeminiSessionMetadata, "availableModes">) {
  return metadata.availableModes.length > 0;
}

export function canGeminiSetSessionModel(metadata: Pick<GeminiSessionMetadata, "availableModels">) {
  return metadata.availableModels.length > 0;
}

function shouldAutoResolveGeminiPermission(runtimeMode: ProviderSession["runtimeMode"]): boolean {
  return runtimeMode === "full-access";
}

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

type GeminiPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
type GeminiToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
type GeminiToolStatus = "pending" | "in_progress" | "completed" | "failed";
type GeminiToolItemType = "command_execution" | "file_change" | "dynamic_tool_call";

type GeminiMode = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

type GeminiModel = {
  readonly modelId: string;
  readonly name?: string;
  readonly description?: string;
};

type GeminiAuthMethod = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
};

type GeminiToolLocation = {
  readonly path: string;
  readonly line?: number | null;
};

type GeminiTextContent = {
  readonly type: "text";
  readonly text: string;
};

type GeminiResourceLinkContent = {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string | null;
  readonly size?: number | null;
  readonly description?: string | null;
};

type GeminiPromptContent = GeminiTextContent | GeminiResourceLinkContent;

type GeminiToolCallContent =
  | {
      readonly type: "content";
      readonly content?: {
        readonly type?: string;
        readonly text?: string;
      };
    }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | {
      readonly type: "terminal";
      readonly terminalId: string;
    };

type GeminiToolCallLike = {
  readonly toolCallId: string;
  readonly status?: GeminiToolStatus;
  readonly title?: string;
  readonly kind?: GeminiToolKind;
  readonly content?: ReadonlyArray<GeminiToolCallContent>;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly locations?: ReadonlyArray<GeminiToolLocation>;
};

type GeminiSessionMetadata = {
  readonly authMethods: ReadonlyArray<GeminiAuthMethod>;
  readonly loadSession: boolean;
  availableModes: ReadonlyArray<GeminiMode>;
  currentModeId?: string;
  availableModels: ReadonlyArray<GeminiModel>;
  currentModelId?: string;
};

type GeminiToolItemState = {
  readonly itemId: RuntimeItemId;
  readonly itemType: GeminiToolItemType;
  completed: boolean;
};

type GeminiTurnState = {
  readonly id: TurnId;
  started: boolean;
  readonly inputText: string;
  readonly attachmentNames: ReadonlyArray<string>;
  assistantText: string;
  readonly items: Array<unknown>;
  readonly assistantItemId: RuntimeItemId;
  assistantStarted: boolean;
  readonly reasoningItemId: RuntimeItemId;
  reasoningStarted: boolean;
  readonly toolItems: Map<string, GeminiToolItemState>;
  interruptedRequested: boolean;
};

type GeminiPendingPermission = {
  readonly jsonRpcId: AcpJsonRpcId;
  readonly requestId: RuntimeRequestId;
  readonly turnId?: TurnId;
  readonly requestType: ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"];
  readonly options: ReadonlyArray<{
    readonly optionId: string;
    readonly name: string;
    readonly kind: GeminiPermissionOptionKind;
  }>;
  readonly toolCallId: string;
};

type GeminiContextUsageSnapshot = {
  readonly usedTokens: number;
  readonly maxTokens?: number;
  readonly totalProcessedTokens?: number;
};

type GeminiSessionContext = {
  readonly threadId: ThreadId;
  readonly client: AcpClient;
  readonly sessionId: string;
  session: ProviderSession;
  metadata: GeminiSessionMetadata;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  readonly sequenceTieBreakersByTimestampMs: Map<number, number>;
  nextFallbackSessionSequence: number;
  activeTurn: GeminiTurnState | null;
  readonly pendingPermissions: Map<string, GeminiPendingPermission>;
  lastUsageSnapshot?: GeminiContextUsageSnapshot;
  totalProcessedTokens: number;
  pendingBootstrapReset: boolean;
  closed: boolean;
  stopRequested: boolean;
};

type GeminiOutcome =
  | {
      readonly state: "completed" | "interrupted";
      readonly stopReason?: string | null;
      readonly usage?: unknown;
    }
  | {
      readonly state: "failed";
      readonly stopReason?: string | null;
      readonly errorMessage: string;
      readonly usage?: unknown;
    };

function isoNow(): string {
  return new Date().toISOString();
}

function parseIsoTimestampMs(value: string): number | undefined {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return meaningfulErrorMessage(cause, fallback);
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

type GeminiTokenCountTotals = {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

function readGeminiTokenCountRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(record?.token_count) ?? asObject(record?.tokenCount);
}

function readGeminiModelUsageTotals(value: unknown): GeminiTokenCountTotals | undefined {
  const modelUsage = asArray(value);
  let inputTokens = 0;
  let outputTokens = 0;
  let foundTokens = false;

  for (const entry of modelUsage) {
    const tokenCount = readGeminiTokenCountRecord(asObject(entry));
    const inputTokenCount = firstRoundedNonNegativeInt(tokenCount, ["input_tokens", "inputTokens"]);
    const outputTokenCount = firstRoundedNonNegativeInt(tokenCount, [
      "output_tokens",
      "outputTokens",
    ]);

    if (inputTokenCount !== undefined) {
      inputTokens += inputTokenCount;
      foundTokens = true;
    }
    if (outputTokenCount !== undefined) {
      outputTokens += outputTokenCount;
      foundTokens = true;
    }
  }

  if (!foundTokens) {
    return undefined;
  }

  const totalTokens = inputTokens + outputTokens;
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
}

function readGeminiTokenCountTotals(value: unknown): GeminiTokenCountTotals | undefined {
  const record = asObject(value);
  const tokenCount = readGeminiTokenCountRecord(record);
  const modelUsageTotals = readGeminiModelUsageTotals(record?.model_usage ?? record?.modelUsage);

  const inputTokens =
    firstRoundedNonNegativeInt(tokenCount, ["input_tokens", "inputTokens"]) ??
    modelUsageTotals?.inputTokens;
  const cachedReadTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_read_tokens",
    "cachedReadTokens",
  ]);
  const cachedWriteTokens = firstRoundedNonNegativeInt(tokenCount, [
    "cached_write_tokens",
    "cachedWriteTokens",
  ]);
  const outputTokens =
    firstRoundedNonNegativeInt(tokenCount, ["output_tokens", "outputTokens"]) ??
    modelUsageTotals?.outputTokens;
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
    (derivedTotalTokens > 0 ? derivedTotalTokens : undefined) ??
    modelUsageTotals?.totalTokens;

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

function geminiToolUseCount(turn: GeminiTurnState | null): number | undefined {
  const count = turn?.toolItems.size ?? 0;
  return count > 0 ? count : undefined;
}

function buildGeminiContextUsageSnapshot(
  value: unknown,
  turn: GeminiTurnState | null,
  inferredMaxTokens?: number,
):
  | (ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] &
      GeminiContextUsageSnapshot)
  | undefined {
  const record = asObject(value);
  const usageMetadata = asObject(record?.usageMetadata) ?? asObject(record?.usage_metadata);
  const usedTokens =
    firstRoundedNonNegativeInt(record, [
      "used",
      "usedTokens",
      "used_tokens",
      "promptTokenCount",
      "prompt_token_count",
      "lastPromptTokenCount",
      "last_prompt_token_count",
    ]) ??
    firstRoundedNonNegativeInt(usageMetadata, [
      "used",
      "usedTokens",
      "used_tokens",
      "promptTokenCount",
      "prompt_token_count",
      "lastPromptTokenCount",
      "last_prompt_token_count",
    ]);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    firstRoundedNonNegativeInt(record, [
      "size",
      "maxTokens",
      "max_tokens",
      "contextWindow",
      "context_window",
      "maxContextWindowTokens",
      "max_context_window_tokens",
      "tokenLimit",
      "token_limit",
      "limit",
    ]) ??
    firstRoundedNonNegativeInt(usageMetadata, [
      "size",
      "maxTokens",
      "max_tokens",
      "contextWindow",
      "context_window",
      "maxContextWindowTokens",
      "max_context_window_tokens",
      "tokenLimit",
      "token_limit",
      "limit",
    ]) ??
    inferredMaxTokens;
  const toolUses = geminiToolUseCount(turn);

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(toolUses !== undefined ? { toolUses } : {}),
  };
}

function buildGeminiTurnUsageSnapshot(
  value: unknown,
  turn: GeminiTurnState,
  lastUsageSnapshot: GeminiContextUsageSnapshot | undefined,
  inferredMaxTokens?: number,
): ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] | undefined {
  const record = asObject(value);
  const tokenCountTotals = readGeminiTokenCountTotals(record);
  const finalContextUsage = buildGeminiContextUsageSnapshot(value, turn, inferredMaxTokens);
  const totalTokens =
    firstRoundedNonNegativeInt(record, ["totalTokens", "total_tokens"]) ??
    tokenCountTotals?.totalTokens;
  const inputTokens =
    firstRoundedNonNegativeInt(record, ["inputTokens", "input_tokens"]) ??
    tokenCountTotals?.inputTokens;
  const cachedReadTokens =
    firstRoundedNonNegativeInt(record, ["cachedReadTokens", "cached_read_tokens"]) ??
    tokenCountTotals?.cachedReadTokens;
  const cachedWriteTokens =
    firstRoundedNonNegativeInt(record, ["cachedWriteTokens", "cached_write_tokens"]) ??
    tokenCountTotals?.cachedWriteTokens;
  const outputTokens =
    firstRoundedNonNegativeInt(record, ["outputTokens", "output_tokens"]) ??
    tokenCountTotals?.outputTokens;
  const reasoningOutputTokens =
    firstRoundedNonNegativeInt(record, [
      "thoughtTokens",
      "thought_tokens",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? tokenCountTotals?.reasoningOutputTokens;
  const durationMs = firstRoundedNonNegativeInt(record, ["durationMs", "duration", "duration_ms"]);
  const cachedInputTokens =
    (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0) > 0
      ? (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
      : undefined;
  const toolUses = geminiToolUseCount(turn);
  const hasDetails =
    finalContextUsage !== undefined ||
    totalTokens !== undefined ||
    inputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    outputTokens !== undefined ||
    reasoningOutputTokens !== undefined ||
    durationMs !== undefined ||
    toolUses !== undefined;

  if (!hasDetails) {
    return undefined;
  }

  const contextUsedTokens = lastUsageSnapshot?.usedTokens ?? finalContextUsage?.usedTokens;
  const usedTokens = contextUsedTokens ?? totalTokens;
  const maxTokens =
    lastUsageSnapshot?.maxTokens ??
    finalContextUsage?.maxTokens ??
    (contextUsedTokens !== undefined ? inferredMaxTokens : undefined);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(totalTokens !== undefined && totalTokens > 0
      ? { lastUsedTokens: totalTokens }
      : finalContextUsage?.lastUsedTokens !== undefined
        ? { lastUsedTokens: finalContextUsage.lastUsedTokens }
        : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0
      ? { lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined && reasoningOutputTokens > 0
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    ...(toolUses !== undefined
      ? { toolUses }
      : finalContextUsage?.toolUses !== undefined
        ? { toolUses: finalContextUsage.toolUses }
        : {}),
  };
}

function readGeminiProcessedTokens(value: unknown): number | undefined {
  const record = asObject(value);
  const tokenCountTotals = readGeminiTokenCountTotals(record);
  const totalTokens =
    firstRoundedNonNegativeInt(record, ["totalTokens", "total_tokens"]) ??
    tokenCountTotals?.totalTokens;
  if (totalTokens !== undefined && totalTokens > 0) {
    return totalTokens;
  }

  const inputTokens =
    firstRoundedNonNegativeInt(record, ["inputTokens", "input_tokens"]) ??
    tokenCountTotals?.inputTokens;
  const cachedReadTokens =
    firstRoundedNonNegativeInt(record, ["cachedReadTokens", "cached_read_tokens"]) ??
    tokenCountTotals?.cachedReadTokens;
  const cachedWriteTokens =
    firstRoundedNonNegativeInt(record, ["cachedWriteTokens", "cached_write_tokens"]) ??
    tokenCountTotals?.cachedWriteTokens;
  const outputTokens =
    firstRoundedNonNegativeInt(record, ["outputTokens", "output_tokens"]) ??
    tokenCountTotals?.outputTokens;
  const reasoningOutputTokens =
    firstRoundedNonNegativeInt(record, [
      "thoughtTokens",
      "thought_tokens",
      "reasoningTokens",
      "reasoning_tokens",
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ]) ?? tokenCountTotals?.reasoningOutputTokens;
  const derivedTotal =
    (inputTokens ?? 0) +
    (cachedReadTokens ?? 0) +
    (cachedWriteTokens ?? 0) +
    (outputTokens ?? 0) +
    (reasoningOutputTokens ?? 0);

  return derivedTotal > 0 ? derivedTotal : undefined;
}

function resolveGeminiNotificationCreatedAt(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
): string | undefined {
  return (
    asString(update.createdAt) ??
    asString(update.timestamp) ??
    asString(update.updatedAt) ??
    asString(params.createdAt) ??
    asString(params.timestamp)
  );
}

function normalizeSessionModes(value: unknown): {
  readonly availableModes: ReadonlyArray<GeminiMode>;
  readonly currentModeId?: string;
} {
  const record = asObject(value);
  const availableModes = asArray(record?.availableModes)
    .map((entry) => {
      const mode = asObject(entry);
      const id = asString(mode?.id);
      const name = asString(mode?.name);
      const description = asString(mode?.description);
      if (!id) {
        return null;
      }
      const normalizedMode: { id: string; name?: string; description?: string } = { id };
      if (name) {
        normalizedMode.name = name;
      }
      if (description) {
        normalizedMode.description = description;
      }
      return normalizedMode;
    })
    .filter((entry): entry is GeminiMode => entry !== null);
  const currentModeId = asString(record?.currentModeId);
  return currentModeId ? { availableModes, currentModeId } : { availableModes };
}

function normalizeSessionModels(value: unknown): {
  readonly availableModels: ReadonlyArray<GeminiModel>;
  readonly currentModelId?: string;
} {
  const record = asObject(value);
  const availableModels = asArray(record?.availableModels)
    .map((entry) => {
      const model = asObject(entry);
      const modelId = asString(model?.modelId);
      const name = asString(model?.name);
      const description = asString(model?.description);
      if (!modelId) {
        return null;
      }
      const normalizedModel: { modelId: string; name?: string; description?: string } = { modelId };
      if (name) {
        normalizedModel.name = name;
      }
      if (description) {
        normalizedModel.description = description;
      }
      return normalizedModel;
    })
    .filter((entry): entry is GeminiModel => entry !== null);
  const currentModelId = asString(record?.currentModelId);
  return currentModelId ? { availableModels, currentModelId } : { availableModels };
}

function normalizeInitializeResponse(value: unknown): GeminiSessionMetadata {
  const record = asObject(value);
  const authMethods = asArray(record?.authMethods)
    .map((entry) => {
      const method = asObject(entry);
      const id = asString(method?.id);
      const name = asString(method?.name);
      const description = asString(method?.description);
      const type = asString(method?.type);
      if (!id) {
        return null;
      }
      const normalizedMethod: {
        id: string;
        name?: string;
        description?: string;
        type?: string;
      } = { id };
      if (name) {
        normalizedMethod.name = name;
      }
      if (description) {
        normalizedMethod.description = description;
      }
      if (type) {
        normalizedMethod.type = type;
      }
      return normalizedMethod;
    })
    .filter((entry): entry is GeminiAuthMethod => entry !== null);
  const agentCapabilities = asObject(record?.agentCapabilities);
  return {
    authMethods,
    loadSession: agentCapabilities?.loadSession === true,
    availableModes: [],
    availableModels: [],
  };
}

function updateMetadataFromSessionResult(
  metadata: GeminiSessionMetadata,
  result: unknown,
): GeminiSessionMetadata {
  const record = asObject(result);
  const modes = normalizeSessionModes(record?.modes);
  const models = normalizeSessionModels(record?.models);
  return {
    ...metadata,
    availableModes: modes.availableModes,
    ...(modes.currentModeId ? { currentModeId: modes.currentModeId } : {}),
    availableModels: models.availableModels,
    ...(models.currentModelId ? { currentModelId: models.currentModelId } : {}),
  };
}

function readGeminiResumeCursor(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  return asString((resumeCursor as Record<string, unknown>).sessionId);
}

function isGeminiAuthRequiredError(cause: unknown): boolean {
  if (!(cause instanceof AcpRequestError)) {
    return false;
  }
  const message = cause.message.toLowerCase();
  return cause.code === -32000 && message.includes("authentication required");
}

function isMissingGeminiSessionError(cause: unknown): boolean {
  const message = toMessage(cause, "").toLowerCase();
  return (
    message.includes("session not found") ||
    message.includes("unknown session") ||
    (message.includes("not found") && message.includes("session"))
  );
}

function preferredAuthMethod(
  authMethods: ReadonlyArray<GeminiAuthMethod>,
): { readonly methodId: string; readonly meta?: Record<string, unknown> } | undefined {
  const find = (id: string) => authMethods.find((method) => method.id === id);

  if (process.env.GEMINI_API_KEY && find("gemini-api-key")) {
    return {
      methodId: "gemini-api-key",
      meta: {
        "api-key": process.env.GEMINI_API_KEY,
      },
    };
  }
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase() === "true" && find("vertex-ai")) {
    return { methodId: "vertex-ai" };
  }
  if (process.env.GOOGLE_GENAI_USE_GCA?.toLowerCase() === "true" && find("oauth-personal")) {
    return { methodId: "oauth-personal" };
  }
  return undefined;
}

function describeGeminiAuthRequirement(metadata: GeminiSessionMetadata): string {
  const apiKeySupported = metadata.authMethods.some((method) => method.id === "gemini-api-key");
  return apiKeySupported
    ? "Gemini CLI requires authentication. Configure `GEMINI_API_KEY` or sign in with the Gemini CLI before starting a session."
    : "Gemini CLI requires authentication before starting a session.";
}

function normalizeModeLabel(mode: GeminiMode): string {
  return `${mode.id} ${mode.name ?? ""} ${mode.description ?? ""}`.toLowerCase();
}

function resolveDesiredModeId(
  metadata: GeminiSessionMetadata,
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode: ProviderSendTurnInput["interactionMode"],
): string | undefined {
  const availableModes = metadata.availableModes;
  if (availableModes.length === 0) {
    return undefined;
  }
  const planMode = availableModes.find((mode) => normalizeModeLabel(mode).includes("plan"));
  const yoloMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("yolo") || label.includes("auto-approves all");
  });
  const defaultMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("default") || label.includes("prompts for approval");
  });
  const permissiveMode = availableModes.find((mode) => {
    const label = normalizeModeLabel(mode);
    return label.includes("auto-approves");
  });
  const fallbackMode = availableModes.find((mode) => !normalizeModeLabel(mode).includes("plan"));

  if (interactionMode === "plan") {
    return planMode?.id;
  }
  if (runtimeMode === "full-access") {
    return yoloMode?.id ?? permissiveMode?.id ?? fallbackMode?.id;
  }
  return defaultMode?.id ?? fallbackMode?.id ?? availableModes[0]?.id;
}

function runtimeItemTypeFromToolKind(kind?: GeminiToolKind | null): GeminiToolItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function requestTypeFromToolKind(
  kind?: GeminiToolKind | null,
): ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"] {
  switch (kind) {
    case "execute":
      return "command_execution_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function mapPlanStatus(value: string | undefined): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "in_progress":
      return "inProgress";
    default:
      return "pending";
  }
}

function extractTextContent(value: unknown): string | undefined {
  const record = asObject(value);
  if (asString(record?.text)) {
    return asString(record?.text);
  }
  return undefined;
}

function extractToolDetail(
  content: ReadonlyArray<GeminiToolCallContent> | null | undefined,
): string | undefined {
  for (const entry of content ?? []) {
    if (entry.type === "content") {
      const text = extractTextContent(entry.content);
      if (text) {
        return text;
      }
      continue;
    }
    if (entry.type === "diff") {
      return entry.path;
    }
    if (entry.type === "terminal") {
      return entry.terminalId;
    }
  }
  return undefined;
}

function buildPromptContent(
  input: ProviderSendTurnInput,
  attachmentsDir: string,
): ReadonlyArray<GeminiPromptContent> {
  const content: GeminiPromptContent[] = [];

  if (input.input && input.input.trim().length > 0) {
    content.push({
      type: "text",
      text: input.input,
    });
  }

  for (const attachment of input.attachments ?? []) {
    const resolvedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment,
    });
    if (!resolvedPath) {
      continue;
    }
    content.push({
      type: "resource_link",
      uri: pathToFileURL(resolvedPath).href,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
    });
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: " ",
    });
  }

  return content;
}

function selectPermissionOption(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly name: string;
    readonly kind: GeminiPermissionOptionKind;
  }>,
  decision: ProviderApprovalDecision,
):
  | {
      readonly optionId: string;
      readonly kind: GeminiPermissionOptionKind;
    }
  | undefined {
  const firstOfKind = (kind: GeminiPermissionOptionKind) =>
    options.find((option) => option.kind === kind);

  switch (decision) {
    case "acceptForSession":
      return firstOfKind("allow_always") ?? firstOfKind("allow_once") ?? firstOfKind("reject_once");
    case "accept":
      return firstOfKind("allow_once") ?? firstOfKind("allow_always") ?? firstOfKind("reject_once");
    case "decline":
      return firstOfKind("reject_once") ?? firstOfKind("reject_always");
    case "cancel":
    default:
      return undefined;
  }
}

const makeGeminiAdapter = Effect.gen(function* () {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const sessions = new Map<ThreadId, GeminiSessionContext>();

  const emit = (event: ProviderRuntimeEvent): void => {
    runLoggedEffect({
      runPromise,
      effect: Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      message: "Failed to emit Gemini runtime event.",
      metadata: { eventId: event.eventId, threadId: event.threadId, type: event.type },
    });
  };

  const reportClientCloseFailure = (cause: unknown, metadata?: Record<string, unknown>) => {
    logWarningEffect({
      runPromise,
      message: "Failed to close Gemini ACP client.",
      metadata: {
        ...metadata,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    });
  };

  const currentGeminiContextWindowTokens = (context: GeminiSessionContext) =>
    inferModelContextWindowTokens(
      PROVIDER,
      context.metadata.currentModelId ?? context.session.model,
    );

  const baseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    context: GeminiSessionContext,
    input: {
      readonly type: TType;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
      readonly createdAt?: string;
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
    },
  ): ProviderRuntimeEventByType<TType> => {
    const createdAt = input.createdAt ?? isoNow();
    const timestampMs = parseIsoTimestampMs(createdAt);
    const sessionSequence = (() => {
      if (timestampMs !== undefined) {
        const nextTieBreaker = (context.sequenceTieBreakersByTimestampMs.get(timestampMs) ?? 0) + 1;
        context.sequenceTieBreakersByTimestampMs.set(timestampMs, nextTieBreaker);
        return timestampMs * 1_000 + nextTieBreaker;
      }
      context.nextFallbackSessionSequence += 1;
      return context.nextFallbackSessionSequence;
    })();

    return {
      type: input.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      sessionSequence,
      payload: input.payload,
    } as unknown as ProviderRuntimeEventByType<TType>;
  };

  const createToolItemState = (
    context: GeminiSessionContext,
    toolCall: GeminiToolCallLike,
    createdAt?: string,
  ): GeminiToolItemState | null => {
    const turn = context.activeTurn;
    if (!turn) {
      return null;
    }
    const existing = turn.toolItems.get(toolCall.toolCallId);
    if (existing) {
      return existing;
    }

    const item = {
      itemId: RuntimeItemId.makeUnsafe(`gemini-tool:${toolCall.toolCallId}`),
      itemType: runtimeItemTypeFromToolKind(toolCall.kind),
      completed: false,
    } satisfies GeminiToolItemState;

    turn.toolItems.set(toolCall.toolCallId, item);
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: item.itemId,
        payload: {
          itemType: item.itemType,
          status: "inProgress",
          ...(asString(toolCall.title) ? { title: asString(toolCall.title) } : {}),
          ...(extractToolDetail(toolCall.content)
            ? { detail: extractToolDetail(toolCall.content) }
            : {}),
          data: {
            toolCallId: toolCall.toolCallId,
            ...(toolCall.kind ? { kind: toolCall.kind } : {}),
            ...(toolCall.content ? { content: toolCall.content } : {}),
            ...(toolCall.locations ? { locations: toolCall.locations } : {}),
            ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
            ...(toolCall.rawOutput !== undefined ? { rawOutput: toolCall.rawOutput } : {}),
          },
        },
      }),
    );

    return item;
  };

  const updateToolItem = (
    context: GeminiSessionContext,
    toolCall: GeminiToolCallLike,
    createdAt?: string,
  ) => {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }
    const item = createToolItemState(context, toolCall, createdAt);
    if (!item) {
      return;
    }
    const turnId = turn.id;
    const payload = {
      itemType: item.itemType,
      ...(asString(toolCall.title) ? { title: asString(toolCall.title) } : {}),
      ...(extractToolDetail(toolCall.content)
        ? { detail: extractToolDetail(toolCall.content) }
        : {}),
      data: {
        toolCallId: toolCall.toolCallId,
        ...(toolCall.kind ? { kind: toolCall.kind } : {}),
        ...(toolCall.content ? { content: toolCall.content } : {}),
        ...(toolCall.locations ? { locations: toolCall.locations } : {}),
        ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
        ...(toolCall.rawOutput !== undefined ? { rawOutput: toolCall.rawOutput } : {}),
      },
    } as const;

    if (toolCall.status === "completed" || toolCall.status === "failed") {
      item.completed = true;
      emit(
        baseEvent(context, {
          type: "item.completed",
          ...(createdAt ? { createdAt } : {}),
          turnId,
          itemId: item.itemId,
          payload: {
            ...payload,
            status: toolCall.status === "failed" ? "failed" : "completed",
          },
        }),
      );
      return;
    }

    emit(
      baseEvent(context, {
        type: "item.updated",
        ...(createdAt ? { createdAt } : {}),
        turnId,
        itemId: item.itemId,
        payload: {
          ...payload,
          status: "inProgress",
        },
      }),
    );
  };

  const ensureAssistantStarted = (context: GeminiSessionContext, createdAt?: string) => {
    const turn = context.activeTurn;
    if (!turn || turn.assistantStarted) {
      return;
    }
    turn.assistantStarted = true;
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: turn.assistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
        },
      }),
    );
  };

  const ensureReasoningStarted = (context: GeminiSessionContext, createdAt?: string) => {
    const turn = context.activeTurn;
    if (!turn || turn.reasoningStarted) {
      return;
    }
    turn.reasoningStarted = true;
    emit(
      baseEvent(context, {
        type: "item.started",
        ...(createdAt ? { createdAt } : {}),
        turnId: turn.id,
        itemId: turn.reasoningItemId,
        payload: {
          itemType: "reasoning",
          status: "inProgress",
        },
      }),
    );
  };

  const completePendingToolItems = (
    context: GeminiSessionContext,
    turn: GeminiTurnState,
    state: GeminiOutcome["state"],
  ) => {
    for (const item of turn.toolItems.values()) {
      if (item.completed) {
        continue;
      }
      item.completed = true;
      emit(
        baseEvent(context, {
          type: "item.completed",
          turnId: turn.id,
          itemId: item.itemId,
          payload: {
            itemType: item.itemType,
            status:
              state === "failed" ? "failed" : state === "interrupted" ? "declined" : "completed",
          },
        }),
      );
    }
  };

  const completeTurn = (context: GeminiSessionContext, outcome: GeminiOutcome) => {
    const turn = context.activeTurn;
    if (!turn) {
      return;
    }

    if (turn.started) {
      completePendingToolItems(context, turn, outcome.state);
      if (turn.reasoningStarted) {
        emit(
          baseEvent(context, {
            type: "item.completed",
            turnId: turn.id,
            itemId: turn.reasoningItemId,
            payload: {
              itemType: "reasoning",
              status: outcome.state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      if (turn.assistantStarted) {
        emit(
          baseEvent(context, {
            type: "item.completed",
            turnId: turn.id,
            itemId: turn.assistantItemId,
            payload: {
              itemType: "assistant_message",
              status: outcome.state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }

      const usageSnapshot = buildGeminiTurnUsageSnapshot(
        outcome.usage,
        turn,
        context.lastUsageSnapshot,
        currentGeminiContextWindowTokens(context),
      );
      const processedTokens = readGeminiProcessedTokens(outcome.usage);
      if (processedTokens !== undefined && processedTokens > 0) {
        context.totalProcessedTokens += processedTokens;
      }
      const completedUsageSnapshot =
        usageSnapshot !== undefined
          ? {
              ...usageSnapshot,
              ...(context.totalProcessedTokens > usageSnapshot.usedTokens
                ? { totalProcessedTokens: context.totalProcessedTokens }
                : {}),
            }
          : undefined;
      if (completedUsageSnapshot) {
        context.lastUsageSnapshot = {
          usedTokens: completedUsageSnapshot.usedTokens,
          ...(completedUsageSnapshot.maxTokens !== undefined
            ? { maxTokens: completedUsageSnapshot.maxTokens }
            : {}),
          ...(context.totalProcessedTokens > 0
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        emit(
          baseEvent(context, {
            type: "thread.token-usage.updated",
            turnId: turn.id,
            payload: {
              usage: completedUsageSnapshot,
            },
          }),
        );
      }
    }

    cancelPendingPermissionsForTurn(context, turn.id);
    if (turn.started) {
      context.turns.push({ id: turn.id, items: [...turn.items] });
      context.replayTurns.push({
        prompt: turn.inputText,
        attachmentNames: [...turn.attachmentNames],
        ...(turn.assistantText.trim().length > 0 ? { assistantResponse: turn.assistantText } : {}),
      });
    }
    context.activeTurn = null;
    context.session = {
      ...context.session,
      status: outcome.state === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      updatedAt: isoNow(),
      ...(outcome.state === "failed"
        ? { lastError: outcome.errorMessage }
        : { lastError: undefined }),
    };

    if (!turn.started) {
      return;
    }

    emit(
      baseEvent(context, {
        type: "turn.completed",
        turnId: turn.id,
        payload: {
          state: outcome.state,
          ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          ...(outcome.state === "failed" ? { errorMessage: outcome.errorMessage } : {}),
        },
      }),
    );
  };

  const resolvePendingPermission = (
    context: GeminiSessionContext,
    pending: GeminiPendingPermission,
    input:
      | {
          readonly decision: "cancel";
        }
      | {
          readonly decision: Exclude<ProviderApprovalDecision, "cancel">;
          readonly optionId: string;
          readonly kind: GeminiPermissionOptionKind;
        },
  ) => {
    context.pendingPermissions.delete(pending.requestId);
    if (context.activeTurn && input.decision === "cancel") {
      const toolItem = context.activeTurn.toolItems.get(pending.toolCallId);
      if (toolItem && !toolItem.completed) {
        toolItem.completed = true;
        emit(
          baseEvent(context, {
            type: "item.completed",
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            itemId: toolItem.itemId,
            payload: {
              itemType: toolItem.itemType,
              status: "declined",
            },
          }),
        );
      }
    }
    emit(
      baseEvent(context, {
        type: "request.resolved",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: pending.requestId,
        payload: {
          requestType: pending.requestType,
          decision: input.decision,
          ...(input.decision === "cancel"
            ? {
                resolution: {
                  outcome: "cancelled",
                },
              }
            : {
                resolution: {
                  optionId: input.optionId,
                  kind: input.kind,
                },
              }),
        },
      }),
    );
  };

  const cancelPendingPermissionsForTurn = (context: GeminiSessionContext, turnId: TurnId) => {
    for (const pending of context.pendingPermissions.values()) {
      if (pending.turnId !== turnId) {
        continue;
      }
      context.client.respond(pending.jsonRpcId, {
        outcome: {
          outcome: "cancelled",
        },
      });
      resolvePendingPermission(context, pending, {
        decision: "cancel",
      });
    }
  };

  const handleGeminiPermissionRequest = async (
    context: GeminiSessionContext,
    request: AcpRequest,
  ): Promise<void> => {
    const params = asObject(request.params);
    if (!params) {
      context.client.respondError(request.id, -32602, "Invalid Gemini permission request.");
      return;
    }
    const requestSessionId = asString(params.sessionId);
    if (requestSessionId !== context.sessionId) {
      context.client.respondError(request.id, -32000, "Session not found.");
      return;
    }
    const toolCall = asObject(params.toolCall);
    const toolCallId = asString(toolCall?.toolCallId);
    if (!toolCallId) {
      context.client.respondError(
        request.id,
        -32602,
        "Gemini permission request is missing toolCallId.",
      );
      return;
    }

    const pendingOptions = asArray(params.options)
      .map((entry) => {
        const option = asObject(entry);
        const optionId = asString(option?.optionId);
        const name = asString(option?.name);
        const kind = asString(option?.kind) as GeminiPermissionOptionKind | undefined;
        if (!optionId || !name || !kind) {
          return null;
        }
        return { optionId, name, kind };
      })
      .filter(
        (
          entry,
        ): entry is {
          readonly optionId: string;
          readonly name: string;
          readonly kind: GeminiPermissionOptionKind;
        } => entry !== null,
      );

    const status = asString(toolCall?.status);
    const title = asString(toolCall?.title);
    const kind = asString(toolCall?.kind);
    const normalizedToolCall: GeminiToolCallLike = {
      toolCallId,
      ...(status ? { status: status as GeminiToolStatus } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind: kind as GeminiToolKind } : {}),
      ...(Array.isArray(toolCall?.content)
        ? { content: toolCall?.content as ReadonlyArray<GeminiToolCallContent> }
        : {}),
      ...(Array.isArray(toolCall?.locations)
        ? { locations: toolCall?.locations as ReadonlyArray<GeminiToolLocation> }
        : {}),
      ...("rawInput" in (toolCall ?? {}) ? { rawInput: toolCall?.rawInput } : {}),
      ...("rawOutput" in (toolCall ?? {}) ? { rawOutput: toolCall?.rawOutput } : {}),
    };

    createToolItemState(context, normalizedToolCall);

    const requestId = RuntimeRequestId.makeUnsafe(String(request.id));
    if (shouldAutoResolveGeminiPermission(context.session.runtimeMode)) {
      const selectedOption = selectPermissionOption(pendingOptions, "acceptForSession");
      if (selectedOption) {
        context.client.respond(request.id, {
          outcome: {
            outcome: "selected",
            optionId: selectedOption.optionId,
          },
        });
        emit(
          baseEvent(context, {
            type: "request.resolved",
            ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
            payload: {
              requestType: requestTypeFromToolKind(normalizedToolCall.kind),
              decision: "acceptForSession",
              resolution: {
                optionId: selectedOption.optionId,
                kind: selectedOption.kind,
              },
            },
          }),
        );
        return;
      }
    }

    const pending: GeminiPendingPermission = {
      jsonRpcId: request.id,
      requestId,
      ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
      requestType: requestTypeFromToolKind(normalizedToolCall.kind),
      options: pendingOptions,
      toolCallId,
    };
    context.pendingPermissions.set(requestId, pending);

    emit(
      baseEvent(context, {
        type: "request.opened",
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId,
        payload: {
          requestType: pending.requestType,
          ...(asString(normalizedToolCall.title)
            ? { detail: asString(normalizedToolCall.title) }
            : {}),
          args: params,
        },
      }),
    );
  };

  const handleGeminiNotification = (
    context: GeminiSessionContext,
    notification: AcpNotification,
  ) => {
    if (notification.method !== "session/update") {
      return;
    }
    const params = asObject(notification.params);
    if (!params || asString(params.sessionId) !== context.sessionId) {
      return;
    }
    const update = asObject(params.update);
    if (!update) {
      return;
    }

    const updateType = asString(update.sessionUpdate);
    if (!updateType) {
      return;
    }
    const notificationCreatedAt = resolveGeminiNotificationCreatedAt(params, update);

    switch (updateType) {
      case "agent_message_chunk": {
        const delta = extractTextContent(update.content);
        if (!delta || !context.activeTurn) {
          return;
        }
        ensureAssistantStarted(context, notificationCreatedAt);
        context.activeTurn.assistantText += delta;
        emit(
          baseEvent(context, {
            type: "content.delta",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            itemId: context.activeTurn.assistantItemId,
            payload: {
              streamKind: "assistant_text",
              delta,
            },
          }),
        );
        return;
      }
      case "agent_thought_chunk": {
        const delta = extractTextContent(update.content);
        if (!delta || !context.activeTurn) {
          return;
        }
        ensureReasoningStarted(context, notificationCreatedAt);
        emit(
          baseEvent(context, {
            type: "content.delta",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            itemId: context.activeTurn.reasoningItemId,
            payload: {
              streamKind: "reasoning_text",
              delta,
            },
          }),
        );
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (!context.activeTurn) {
          return;
        }
        const toolCallId = asString(update.toolCallId);
        const status = asString(update.status);
        const title = asString(update.title);
        const kind = asString(update.kind);
        if (!toolCallId) {
          return;
        }
        updateToolItem(
          context,
          {
            toolCallId,
            ...(status ? { status: status as GeminiToolStatus } : {}),
            ...(title ? { title } : {}),
            ...(kind ? { kind: kind as GeminiToolKind } : {}),
            ...(Array.isArray(update.content)
              ? { content: update.content as ReadonlyArray<GeminiToolCallContent> }
              : {}),
            ...(Array.isArray(update.locations)
              ? { locations: update.locations as ReadonlyArray<GeminiToolLocation> }
              : {}),
            ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
            ...("rawOutput" in update ? { rawOutput: update.rawOutput } : {}),
          },
          notificationCreatedAt,
        );
        return;
      }
      case "plan": {
        if (!context.activeTurn) {
          return;
        }
        const entries = asArray(update.entries)
          .map((entry) => {
            const planEntry = asObject(entry);
            const content = asString(planEntry?.content);
            if (!content) {
              return null;
            }
            return {
              step: content,
              status: mapPlanStatus(asString(planEntry?.status)),
            };
          })
          .filter(
            (
              entry,
            ): entry is {
              readonly step: string;
              readonly status: "pending" | "inProgress" | "completed";
            } => entry !== null,
          );
        emit(
          baseEvent(context, {
            type: "turn.plan.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            turnId: context.activeTurn.id,
            payload: {
              plan: entries,
            },
          }),
        );
        return;
      }
      case "usage_update": {
        const usage = buildGeminiContextUsageSnapshot(
          update,
          context.activeTurn,
          currentGeminiContextWindowTokens(context),
        );
        if (!usage) {
          return;
        }
        const liveUsageSnapshot = {
          ...usage,
          ...(context.totalProcessedTokens > usage.usedTokens
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        context.lastUsageSnapshot = {
          usedTokens: usage.usedTokens,
          ...(usage.maxTokens !== undefined ? { maxTokens: usage.maxTokens } : {}),
          ...(context.totalProcessedTokens > 0
            ? { totalProcessedTokens: context.totalProcessedTokens }
            : {}),
        };
        emit(
          baseEvent(context, {
            type: "thread.token-usage.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
            payload: {
              usage: liveUsageSnapshot,
            },
          }),
        );
        return;
      }
      case "session_info_update": {
        const title = asString(update.title);
        const updatedAt = asString(update.updatedAt);
        if (!title && !updatedAt) {
          return;
        }
        emit(
          baseEvent(context, {
            type: "thread.metadata.updated",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            payload: {
              ...(title ? { name: title } : {}),
              metadata: updatedAt ? { updatedAt } : {},
            },
          }),
        );
        return;
      }
      case "current_mode_update": {
        const currentModeId = asString(update.currentModeId);
        if (!currentModeId) {
          return;
        }
        context.metadata = {
          ...context.metadata,
          currentModeId,
        };
        emit(
          baseEvent(context, {
            type: "session.configured",
            ...(notificationCreatedAt ? { createdAt: notificationCreatedAt } : {}),
            payload: {
              config: {
                currentModeId,
              },
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  };

  const syncGeminiSessionState = async (
    context: GeminiSessionContext,
    input: {
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly interactionMode: ProviderSendTurnInput["interactionMode"];
      readonly modelSelection?:
        | ProviderSessionStartInput["modelSelection"]
        | ProviderSendTurnInput["modelSelection"];
    },
  ): Promise<void> => {
    const desiredModeId = resolveDesiredModeId(
      context.metadata,
      input.runtimeMode,
      input.interactionMode,
    );
    const canSetMode = canGeminiSetSessionMode(context.metadata);
    if (input.interactionMode === "plan" && !desiredModeId) {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/set_mode",
        detail: "Gemini ACP session does not expose a plan mode.",
      });
    }
    if (canSetMode && desiredModeId && context.metadata.currentModeId !== desiredModeId) {
      await context.client.request(
        "session/set_mode",
        {
          sessionId: context.sessionId,
          modeId: desiredModeId,
        },
        { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
      );
      context.metadata = {
        ...context.metadata,
        currentModeId: desiredModeId,
      };
      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: {
              currentModeId: desiredModeId,
            },
          },
        }),
      );
    }

    const desiredModel =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.model
        : (context.session.model ?? DEFAULT_MODEL_BY_PROVIDER.gemini);
    const canSetModel = canGeminiSetSessionModel(context.metadata);
    if (canSetModel && context.metadata.currentModelId !== desiredModel) {
      await context.client.request(
        "session/set_model",
        {
          sessionId: context.sessionId,
          modelId: desiredModel,
        },
        { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
      );
      context.metadata = {
        ...context.metadata,
        currentModelId: desiredModel,
      };
      context.session = {
        ...context.session,
        model: desiredModel,
        updatedAt: isoNow(),
      };
      emit(
        baseEvent(context, {
          type: "session.configured",
          payload: {
            config: {
              currentModelId: desiredModel,
            },
          },
        }),
      );
    }
  };

  const startInitializedGeminiClient = async (
    binaryPath: string,
    cwd: string,
  ): Promise<{ readonly client: AcpClient; readonly metadata: GeminiSessionMetadata }> => {
    const initializeParams = buildGeminiInitializeParams();

    const attempts: ReadonlyArray<ReadonlyArray<string>> = [["--acp"], ["--experimental-acp"]];
    let lastError: unknown = undefined;
    for (const args of attempts) {
      const client = startAcpClient({
        binaryPath,
        args,
        cwd,
        env: {
          NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
        },
      });
      try {
        const initializeResult = await client.request("initialize", initializeParams, {
          timeoutMs: ACP_CONTROL_TIMEOUT_MS,
        });
        return {
          client,
          metadata: normalizeInitializeResponse(initializeResult),
        };
      } catch (cause) {
        lastError = cause;
        try {
          await client.close();
        } catch (closeCause) {
          reportClientCloseFailure(closeCause, { phase: "connect" });
        }
      }
    }
    throw lastError;
  };

  const authenticateGeminiIfRequired = async (
    client: AcpClient,
    metadata: GeminiSessionMetadata,
  ): Promise<void> => {
    const auth = preferredAuthMethod(metadata.authMethods);
    if (!auth) {
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "authenticate",
        detail: describeGeminiAuthRequirement(metadata),
      });
    }
    await client.request(
      "authenticate",
      {
        methodId: auth.methodId,
        ...(auth.meta ? { _meta: auth.meta } : {}),
      },
      { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
    );
  };

  const startOrLoadGeminiSession = async (
    client: AcpClient,
    metadata: GeminiSessionMetadata,
    input: ProviderSessionStartInput,
    cwd: string,
  ): Promise<{
    readonly sessionId: string;
    readonly metadata: GeminiSessionMetadata;
    readonly method: "session/load" | "session/new";
  }> => {
    const resumeSessionId = readGeminiResumeCursor(input.resumeCursor);
    const canLoadSession = resumeSessionId !== undefined && metadata.loadSession;
    const newSessionParams = {
      cwd,
      mcpServers: [],
    };

    const execute = async (
      method: "session/load" | "session/new",
      params: {
        readonly cwd: string;
        readonly mcpServers: ReadonlyArray<never>;
        readonly sessionId?: string;
      },
    ) => {
      const result = await client.request(method, params, {
        timeoutMs: ACP_CONTROL_TIMEOUT_MS,
      });
      const resultRecord = asObject(result);
      const sessionId = asString(resultRecord?.sessionId) ?? resumeSessionId;
      if (!sessionId) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Gemini ACP did not return a session id.",
        });
      }
      return {
        sessionId,
        metadata: updateMetadataFromSessionResult(metadata, result),
        method,
      };
    };

    const executeWithAuthRetry = async (
      method: "session/load" | "session/new",
      params: {
        readonly cwd: string;
        readonly mcpServers: ReadonlyArray<never>;
        readonly sessionId?: string;
      },
    ) => {
      try {
        return await execute(method, params);
      } catch (cause) {
        if (!isGeminiAuthRequiredError(cause)) {
          throw cause;
        }
        await authenticateGeminiIfRequired(client, metadata);
        return await execute(method, params);
      }
    };

    if (canLoadSession) {
      try {
        return await executeWithAuthRetry("session/load", {
          ...newSessionParams,
          sessionId: resumeSessionId,
        });
      } catch (cause) {
        if (!isMissingGeminiSessionError(cause)) {
          throw cause;
        }
        return await executeWithAuthRetry("session/new", newSessionParams);
      }
    }

    return await executeWithAuthRetry("session/new", newSessionParams);
  };

  const finalizeContextOnClose = (
    context: GeminiSessionContext,
    input: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    },
  ) => {
    if (context.closed) {
      return;
    }
    context.closed = true;
    if (context.activeTurn) {
      completeTurn(
        context,
        context.activeTurn.interruptedRequested
          ? {
              state: "interrupted",
              stopReason: "cancelled",
            }
          : {
              state: "failed",
              errorMessage: `Gemini ACP process exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
            },
      );
    }
    emit(
      baseEvent(context, {
        type: "session.exited",
        payload: {
          reason: context.stopRequested
            ? "Session stopped"
            : `Gemini ACP exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
          exitKind: context.stopRequested ? "graceful" : "error",
          recoverable: !context.stopRequested,
        },
      }),
    );
    if (!context.stopRequested) {
      emit(
        baseEvent(context, {
          type: "runtime.error",
          payload: {
            message: `Gemini ACP exited unexpectedly (code=${input.code ?? "null"}, signal=${input.signal ?? "null"})`,
            class: "transport_error",
          },
        }),
      );
    }
    sessions.delete(context.threadId);
  };

  const startSession: GeminiAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    Effect.tryPromise({
      try: async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected Gemini model selection, received '${input.modelSelection.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.closed) {
          return existing.session;
        }

        const settings = await runPromise(serverSettingsService.getSettings);
        const cwd = input.cwd ?? serverConfig.cwd;
        const { client, metadata: initializedMetadata } = await startInitializedGeminiClient(
          settings.providers.gemini.binaryPath,
          cwd,
        );

        let contextRef: GeminiSessionContext | null = null;
        client.setNotificationHandler((notification) => {
          if (contextRef) {
            handleGeminiNotification(contextRef, notification);
          }
        });
        client.setRequestHandler((request) => {
          if (!contextRef) {
            client.respondError(request.id, -32000, "Gemini session is not ready.");
            return;
          }
          if (request.method === "session/request_permission") {
            void handleGeminiPermissionRequest(contextRef, request).catch((cause) => {
              client.respondError(
                request.id,
                -32000,
                toMessage(cause, "Failed to handle Gemini permission request"),
              );
            });
            return;
          }
          client.respondError(
            request.id,
            -32601,
            `Unsupported ACP client request: ${request.method}`,
          );
        });
        client.setProtocolErrorHandler((error) => {
          if (contextRef) {
            emit(
              baseEvent(contextRef, {
                type: "runtime.error",
                payload: {
                  message: error.message,
                  class: "transport_error",
                },
              }),
            );
          }
        });

        try {
          const started = await startOrLoadGeminiSession(client, initializedMetadata, input, cwd);

          const createdAt = isoNow();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model:
              input.modelSelection?.provider === PROVIDER
                ? input.modelSelection.model
                : DEFAULT_MODEL_BY_PROVIDER.gemini,
            threadId: input.threadId,
            resumeCursor: {
              sessionId: started.sessionId,
            },
            createdAt,
            updatedAt: createdAt,
          };

          const context: GeminiSessionContext = {
            threadId: input.threadId,
            client,
            sessionId: started.sessionId,
            session,
            metadata: started.metadata,
            turns: [],
            replayTurns: cloneReplayTurns(input.replayTurns),
            sequenceTieBreakersByTimestampMs: new Map(),
            nextFallbackSessionSequence: 0,
            activeTurn: null,
            pendingPermissions: new Map(),
            totalProcessedTokens: 0,
            pendingBootstrapReset: false,
            closed: false,
            stopRequested: false,
          };
          context.pendingBootstrapReset =
            context.replayTurns.length > 0 && started.method === "session/new";
          contextRef = context;
          client.setCloseHandler((close) => finalizeContextOnClose(context, close));

          sessions.set(input.threadId, context);

          emit(
            baseEvent(context, {
              type: "session.started",
              payload: {
                resume: context.session.resumeCursor,
              },
            }),
          );
          emit(
            baseEvent(context, {
              type: "thread.started",
              payload: {
                providerThreadId: context.sessionId,
              },
            }),
          );

          await syncGeminiSessionState(context, {
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: input.modelSelection,
          });

          return context.session;
        } catch (cause) {
          try {
            await client.close();
          } catch (closeCause) {
            reportClientCloseFailure(closeCause, { phase: "startSession" });
          }
          throw cause;
        }
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) || isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: toMessage(cause, "Gemini session start failed"),
              cause,
            }),
    });

  const sendTurn: GeminiAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.tryPromise({
      try: async () => {
        const context = sessions.get(input.threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected Gemini model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (context.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Gemini session is already running turn '${context.activeTurn.id}'. Wait for it to finish or interrupt it before starting another turn.`,
          });
        }

        const turnId = TurnId.makeUnsafe(`gemini-turn:${randomUUID()}`);
        const assistantItemId = RuntimeItemId.makeUnsafe(`gemini-assistant:${randomUUID()}`);
        const reasoningItemId = RuntimeItemId.makeUnsafe(`gemini-reasoning:${randomUUID()}`);
        const previousSessionStatus = context.session.status;
        const previousSessionActiveTurnId = context.session.activeTurnId;
        const previousSessionLastError = context.session.lastError;

        context.activeTurn = {
          id: turnId,
          started: false,
          inputText: input.input ?? "",
          attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
          assistantText: "",
          items: [],
          assistantItemId,
          assistantStarted: false,
          reasoningItemId,
          reasoningStarted: false,
          toolItems: new Map(),
          interruptedRequested: false,
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: isoNow(),
        };

        try {
          await syncGeminiSessionState(context, {
            runtimeMode: context.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection: input.modelSelection,
          });

          const promptInput = context.pendingBootstrapReset
            ? {
                ...input,
                input: buildBootstrapPromptFromReplayTurns(
                  context.replayTurns,
                  input.input ?? "Please analyze the attached files.",
                  ROLLBACK_BOOTSTRAP_MAX_CHARS,
                ).text,
              }
            : input;
          const promptContent = buildPromptContent(promptInput, serverConfig.attachmentsDir);
          if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "Gemini session closed before the reserved turn could start.",
            });
          }

          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: isoNow(),
            model:
              input.modelSelection?.provider === PROVIDER
                ? input.modelSelection.model
                : (context.session.model ?? DEFAULT_MODEL_BY_PROVIDER.gemini),
          };
          context.activeTurn.started = true;

          emit(
            baseEvent(context, {
              type: "turn.started",
              turnId,
              payload: context.session.model ? { model: context.session.model } : {},
            }),
          );

          void context.client
            .request("session/prompt", {
              sessionId: context.sessionId,
              prompt: promptContent,
            })
            .then((result) => {
              context.pendingBootstrapReset = false;
              if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
                return;
              }
              const resultRecord = asObject(result);
              const stopReason = asString(resultRecord?.stopReason) ?? null;
              const resultUsage =
                asObject(resultRecord?.usage) ??
                asObject(resultRecord?.usageMetadata) ??
                asObject(resultRecord?.usage_metadata);
              const resultQuota =
                asObject(asObject(resultRecord?._meta)?.quota) ?? asObject(resultRecord?.quota);
              const rawUsage =
                resultUsage && resultQuota
                  ? {
                      ...resultQuota,
                      ...resultUsage,
                    }
                  : (resultUsage ?? resultQuota);
              if (stopReason === "cancelled" || context.activeTurn.interruptedRequested) {
                completeTurn(context, {
                  state: "interrupted",
                  stopReason,
                  ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
                });
                return;
              }
              completeTurn(context, {
                state: "completed",
                stopReason,
                ...(rawUsage !== undefined ? { usage: rawUsage } : {}),
              });
            })
            .catch((cause) => {
              if (context.closed || !context.activeTurn || context.activeTurn.id !== turnId) {
                return;
              }
              if (context.activeTurn.interruptedRequested && cause instanceof AcpRequestError) {
                completeTurn(context, {
                  state: "interrupted",
                  stopReason: "cancelled",
                });
                return;
              }
              completeTurn(context, {
                state: "failed",
                errorMessage: toMessage(cause, "Gemini prompt failed"),
              });
              emit(
                baseEvent(context, {
                  type: "runtime.error",
                  turnId,
                  payload: {
                    message: toMessage(cause, "Gemini prompt failed"),
                    class: "provider_error",
                  },
                }),
              );
            });
        } catch (cause) {
          if (context.activeTurn?.id === turnId) {
            context.activeTurn = null;
            context.session = {
              ...context.session,
              status: previousSessionStatus,
              activeTurnId: previousSessionActiveTurnId,
              updatedAt: isoNow(),
              ...(previousSessionLastError !== undefined
                ? { lastError: previousSessionLastError }
                : { lastError: undefined }),
            };
          }
          throw cause;
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) ||
        isProviderAdapterRequestError(cause) ||
        isProviderAdapterSessionNotFoundError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: toMessage(cause, "Gemini sendTurn failed"),
              cause,
            }),
    });

  const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (!context.activeTurn) {
          return;
        }
        if (turnId && context.activeTurn.id !== turnId) {
          return;
        }
        const activeTurnId = context.activeTurn.id;
        context.activeTurn.interruptedRequested = true;
        context.client.notify("session/cancel", {
          sessionId: context.sessionId,
        });
        cancelPendingPermissionsForTurn(context, activeTurnId);
        completeTurn(context, {
          state: "interrupted",
          stopReason: "cancelled",
        });
      },
      catch: (cause) =>
        isProviderAdapterSessionNotFoundError(cause) || isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/cancel",
              detail: toMessage(cause, "Gemini turn interrupt failed"),
              cause,
            }),
    });

  const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const pending = context.pendingPermissions.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending Gemini approval request: ${requestId}`,
        });
      }

      const selectedOption = selectPermissionOption(pending.options, decision);
      if (!selectedOption) {
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "cancelled",
          },
        });
        resolvePendingPermission(context, pending, {
          decision: "cancel",
        });
        return;
      }

      context.client.respond(pending.jsonRpcId, {
        outcome: {
          outcome: "selected",
          optionId: selectedOption.optionId,
        },
      });
      resolvePendingPermission(context, pending, {
        decision,
        optionId: selectedOption.optionId,
        kind: selectedOption.kind,
      });
    });

  const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
    threadId: ThreadId,
    _requestId: string,
    _answers: ProviderUserInputAnswers,
  ) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      throw new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: "Gemini ACP user-input requests are not implemented by this adapter.",
      });
    });

  const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      context.stopRequested = true;
      if (context.activeTurn) {
        cancelPendingPermissionsForTurn(context, context.activeTurn.id);
      }
      await context.client.close();
    });

  const listSessions: GeminiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));

  const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const rollbackThread: GeminiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.activeTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Gemini cannot roll back while a turn is still running.",
        });
      }

      const nextLength = Math.max(0, context.turns.length - numTurns);
      const trimmedTurns = context.turns.slice(0, nextLength).map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      }));
      const trimmedReplayTurns = context.replayTurns.slice(0, nextLength).map((turn) => {
        if (turn.assistantResponse !== undefined) {
          return {
            prompt: turn.prompt,
            attachmentNames: [...turn.attachmentNames],
            assistantResponse: turn.assistantResponse,
          };
        }

        return {
          prompt: turn.prompt,
          attachmentNames: [...turn.attachmentNames],
        };
      });

      const restartInput = {
        provider: PROVIDER,
        threadId,
        runtimeMode: context.session.runtimeMode,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        ...(context.session.model
          ? {
              modelSelection: {
                provider: PROVIDER,
                model: context.session.model,
              } as const,
            }
          : {}),
      };

      yield* stopSession(threadId);
      sessions.delete(threadId);
      yield* startSession(restartInput);

      const restarted = sessions.get(threadId);
      if (!restarted) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Gemini rollback failed to recreate the session.",
        });
      }

      restarted.turns.push(...trimmedTurns);
      restarted.replayTurns.push(...trimmedReplayTurns);
      restarted.pendingBootstrapReset = trimmedReplayTurns.length > 0;

      return {
        threadId,
        turns: restarted.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const stopAll: GeminiAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      for (const context of sessions.values()) {
        context.stopRequested = true;
        if (context.activeTurn) {
          cancelPendingPermissionsForTurn(context, context.activeTurn.id);
        }
        try {
          await context.client.close();
        } catch (cause) {
          reportClientCloseFailure(cause, {
            phase: "stopAll",
            threadId: context.session.threadId,
          });
        }
      }
      sessions.clear();
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies GeminiAdapterShape;
});

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter);
