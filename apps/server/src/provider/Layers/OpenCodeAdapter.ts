/**
 * OpenCode adapter — HTTP SDK (`opencode serve`) + SSE event subscription.
 *
 * @module OpenCodeAdapter
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ModelSelection,
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
  type UserInputQuestion,
} from "@ace/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { meaningfulErrorMessage } from "../errorCause.ts";
import { runLoggedEffect } from "../fireAndForget.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { startOpenCodeServer, type OpenCodeServerHandle } from "../opencodeRuntime.ts";
import {
  createOpenCodeSdkClient,
  parseOpenCodeModelSlug,
  resolveOpenCodeModelForPrompt,
} from "../opencodeSdk.ts";
import { asFiniteNumber as asNumber, asObject as asRecord, asString } from "../unknown.ts";
import { type OpenCodeAdapterShape, OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";

const PROVIDER = "opencode" as const;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

type OpenCodeSessionContext = {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly cwd: string;
  readonly server: OpenCodeServerHandle;
  readonly client: OpencodeClient;
  readonly opencodeSessionId: string;
  defaultModels: Record<string, string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  totalProcessedTokens: number;
  readonly sequenceTieBreakersByTimestampMs: Map<number, number>;
  nextFallbackSessionSequence: number;
  activeTurn: {
    id: TurnId;
    startedAtMs: number;
    inputText: string;
    attachmentNames: ReadonlyArray<string>;
    assistantText: string;
    assistantItemId: RuntimeItemId;
    assistantStarted: boolean;
    toolItems: Map<string, OpenCodeToolItemState>;
    reasoningItems: Map<string, OpenCodeReasoningItemState>;
    usage?: unknown;
    totalCostUsd?: number;
  } | null;
  pendingApprovals: Map<
    string,
    {
      readonly requestId: RuntimeRequestId;
      readonly requestType: ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"];
      readonly turnId?: TurnId;
    }
  >;
  pendingUserInputs: Map<
    string,
    {
      readonly requestId: RuntimeRequestId;
      readonly turnId?: TurnId;
    }
  >;
  sseAbort: AbortController | null;
  pendingBootstrapReset: boolean;
  stopped: boolean;
};

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

type OpenCodeToolItemType = Extract<
  ProviderRuntimeEventByType<"item.started">["payload"]["itemType"],
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
>;

type OpenCodeToolItemState = {
  readonly itemId: RuntimeItemId;
  readonly itemType: OpenCodeToolItemType;
  completed: boolean;
  detail?: string;
};

type OpenCodeReasoningItemState = {
  readonly itemId: RuntimeItemId;
  lastText: string;
  completed: boolean;
};

type OpenCodeDeltaStreamKind = Extract<
  ProviderRuntimeEventByType<"content.delta">["payload"]["streamKind"],
  "assistant_text" | "reasoning_text" | "reasoning_summary_text"
>;

function asRoundedPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : undefined;
}

function sumPositiveInts(values: ReadonlyArray<number | undefined>): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
  }
  return total > 0 ? total : undefined;
}

export function buildOpenCodeThreadUsageSnapshot(
  value: unknown,
  toolUses?: number,
  durationMs?: number,
): ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const inputTokens = asRoundedPositiveInt(record.input);
  const outputTokens = asRoundedPositiveInt(record.output);
  const reasoningOutputTokens = asRoundedPositiveInt(record.reasoning);
  const cache = asRecord(record.cache);
  const cachedInputTokens = sumPositiveInts([
    asRoundedPositiveInt(cache?.read),
    asRoundedPositiveInt(cache?.write),
  ]);
  const usedTokens =
    asRoundedPositiveInt(record.total) ??
    sumPositiveInts([inputTokens, outputTokens, reasoningOutputTokens, cachedInputTokens]);

  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(toolUses !== undefined && toolUses > 0 ? { toolUses: Math.round(toolUses) } : {}),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs: Math.round(durationMs) } : {}),
    compactsAutomatically: true,
  };
}

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

export function openCodeTimestampToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) < 1_000_000_000) {
      return undefined;
    }
    const timestampMs = Math.abs(value) >= 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(timestampMs);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return openCodeTimestampToIso(Number(trimmed));
  }

  const parsedMs = Date.parse(trimmed);
  return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : undefined;
}

export function resolveOpenCodePartTimestamp(
  part: Record<string, unknown>,
  boundary: "start" | "end",
): string | undefined {
  const time = asRecord(part.time);
  if (!time) {
    return undefined;
  }
  return openCodeTimestampToIso(time[boundary]);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function unwrapOpenCodeSseEvent(
  raw: unknown,
): { type: string; properties?: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type === "string" && "properties" in r && r.properties) {
    return { type: r.type, properties: r.properties as Record<string, unknown> };
  }
  const globalPayload = r.payload;
  if (globalPayload && typeof globalPayload === "object") {
    const p = globalPayload as Record<string, unknown>;
    if (typeof p.type === "string") {
      if ("properties" in p && p.properties && typeof p.properties === "object") {
        return { type: p.type, properties: p.properties as Record<string, unknown> };
      }
      return { type: p.type };
    }
  }
  return null;
}

function classifyOpenCodePermission(
  permission: string,
): ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"] {
  const lower = permission.toLowerCase();
  if (lower.includes("shell") || lower.includes("command") || lower.includes("bash")) {
    return "command_execution_approval";
  }
  if (lower.includes("write") || lower.includes("patch") || lower.includes("edit")) {
    return "file_change_approval";
  }
  if (lower.includes("read") || lower.includes("file")) {
    return "file_read_approval";
  }
  return "dynamic_tool_call";
}

export function classifyOpenCodeToolItemType(toolName: string): OpenCodeToolItemType {
  const lower = toolName.toLowerCase();
  if (
    lower.includes("shell") ||
    lower.includes("bash") ||
    lower.includes("command") ||
    lower.includes("terminal") ||
    lower === "exec"
  ) {
    return "command_execution";
  }
  if (
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("patch") ||
    lower.includes("delete") ||
    lower.includes("rename") ||
    lower.includes("move")
  ) {
    return "file_change";
  }
  if (lower.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (lower.includes("web") || lower.includes("search")) {
    return "web_search";
  }
  if (lower.includes("image") || lower.includes("screenshot") || lower.includes("view")) {
    return "image_view";
  }
  if (lower.includes("collab") || lower.includes("subagent") || lower.includes("sub-agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

export function mapOpenCodeTodoStatus(
  status: unknown,
): ProviderRuntimeEventByType<"turn.plan.updated">["payload"]["plan"][number]["status"] {
  switch (status) {
    case "completed":
    case "cancelled":
      return "completed";
    case "in_progress":
      return "inProgress";
    case "pending":
    default:
      return "pending";
  }
}

function buildOpenCodeToolDetail(
  state: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!state) {
    return undefined;
  }
  const title = nonEmptyString(state.title);
  if (title) {
    return title;
  }
  const output = nonEmptyString(state.output);
  if (output) {
    return output;
  }
  const error = nonEmptyString(state.error);
  if (error) {
    return error;
  }
  return undefined;
}

export function appendOnlyDelta(previous: string, next: string): string | undefined {
  if (next.length === 0 || next === previous) {
    return undefined;
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
}

export function classifyOpenCodeDeltaStreamKind(field: unknown): OpenCodeDeltaStreamKind {
  switch (field) {
    case "reasoning_content":
      return "reasoning_text";
    case "reasoning_details":
      return "reasoning_summary_text";
    default:
      return "assistant_text";
  }
}

export function resolveOpenCodeDeltaStreamKind(input: {
  field: unknown;
  isReasoningPart: boolean;
}): OpenCodeDeltaStreamKind {
  const streamKind = classifyOpenCodeDeltaStreamKind(input.field);
  if (streamKind !== "assistant_text") {
    return streamKind;
  }
  return input.isReasoningPart ? "reasoning_text" : "assistant_text";
}

function mapApprovalDecision(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

function mapQuestions(questions: ReadonlyArray<Record<string, unknown>>): UserInputQuestion[] {
  return questions.map((q, index) => {
    const header = typeof q.header === "string" ? q.header : `Question ${String(index + 1)}`;
    const question = typeof q.question === "string" ? q.question : header;
    const options = Array.isArray(q.options)
      ? q.options.map((opt) => {
          const o = opt as Record<string, unknown>;
          return {
            label: typeof o.label === "string" ? o.label : "Option",
            description: typeof o.description === "string" ? o.description : "",
          };
        })
      : [];
    return {
      id: `q-${String(index)}`,
      header,
      question,
      options,
      ...(q.multiple === true ? { multiSelect: true } : {}),
    };
  });
}

function resolveOpenCodeModel(
  modelSelection: ModelSelection | undefined,
  fallbackSlug: string,
  defaults: Record<string, string>,
): { providerID: string; modelID: string } {
  if (modelSelection && modelSelection.provider === PROVIDER) {
    return resolveOpenCodeModelForPrompt({
      modelSlug: modelSelection.model,
      defaults,
    });
  }
  const parsed = parseOpenCodeModelSlug(fallbackSlug);
  if (parsed) return parsed;
  return resolveOpenCodeModelForPrompt({ modelSlug: fallbackSlug, defaults });
}

const makeOpenCodeAdapter = Effect.fn("makeOpenCodeAdapter")(function* () {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const sessions = new Map<ThreadId, OpenCodeSessionContext>();

  const emit = (event: ProviderRuntimeEvent): void => {
    runLoggedEffect({
      runPromise,
      effect: Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      message: "Failed to emit OpenCode runtime event.",
      metadata: { eventId: event.eventId, threadId: event.threadId, type: event.type },
    });
  };

  const baseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    ctx: OpenCodeSessionContext,
    input: {
      readonly type: TType;
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
    },
  ): ProviderRuntimeEventByType<TType> => {
    const createdAt = input.createdAt ?? isoNow();
    const timestampMs = parseIsoTimestampMs(createdAt);
    const sessionSequence = (() => {
      if (timestampMs !== undefined) {
        const nextTieBreaker = (ctx.sequenceTieBreakersByTimestampMs.get(timestampMs) ?? 0) + 1;
        ctx.sequenceTieBreakersByTimestampMs.set(timestampMs, nextTieBreaker);
        return timestampMs * 1_000 + nextTieBreaker;
      }
      ctx.nextFallbackSessionSequence += 1;
      return ctx.nextFallbackSessionSequence;
    })();

    return {
      type: input.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: ctx.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      sessionSequence,
      payload: input.payload,
    } as unknown as ProviderRuntimeEventByType<TType>;
  };

  const completeTurn = (
    ctx: OpenCodeSessionContext,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => {
    const activeTurn = ctx.activeTurn;
    const turnId = activeTurn?.id;
    ctx.activeTurn = null;
    ctx.session = {
      ...ctx.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: isoNow(),
      ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
    };
    if (turnId) {
      ctx.replayTurns.push({
        prompt: activeTurn?.inputText ?? "",
        attachmentNames: [...(activeTurn?.attachmentNames ?? [])],
        ...(activeTurn && activeTurn.assistantText.trim().length > 0
          ? { assistantResponse: activeTurn.assistantText }
          : {}),
      });
      for (const reasoningItem of activeTurn?.reasoningItems.values() ?? []) {
        if (reasoningItem.completed) {
          continue;
        }
        reasoningItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: reasoningItem.itemId,
            payload: {
              itemType: "reasoning",
              status: state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      for (const toolItem of activeTurn?.toolItems.values() ?? []) {
        if (toolItem.completed) {
          continue;
        }
        toolItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: toolItem.itemId,
            payload: {
              itemType: toolItem.itemType,
              status:
                state === "failed" ? "failed" : state === "interrupted" ? "declined" : "completed",
              ...(toolItem.detail ? { detail: toolItem.detail } : {}),
            },
          }),
        );
      }
      if (activeTurn?.assistantStarted) {
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: activeTurn.assistantItemId,
            payload: {
              itemType: "assistant_message",
              status: state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      const turnUsageSnapshot = buildOpenCodeThreadUsageSnapshot(
        activeTurn?.usage,
        activeTurn?.toolItems.size,
        activeTurn ? Math.max(0, Date.now() - activeTurn.startedAtMs) : undefined,
      );
      const processedTokens = turnUsageSnapshot?.lastUsedTokens ?? turnUsageSnapshot?.usedTokens;
      if (processedTokens !== undefined && processedTokens > 0) {
        ctx.totalProcessedTokens += processedTokens;
      }
      const usageSnapshot =
        turnUsageSnapshot !== undefined
          ? {
              ...turnUsageSnapshot,
              ...(ctx.totalProcessedTokens > turnUsageSnapshot.usedTokens
                ? { totalProcessedTokens: ctx.totalProcessedTokens }
                : {}),
            }
          : undefined;
      if (usageSnapshot) {
        emit(
          baseEvent(ctx, {
            type: "thread.token-usage.updated",
            turnId,
            payload: {
              usage: usageSnapshot,
            },
          }),
        );
      }
      emit(
        baseEvent(ctx, {
          type: "turn.completed",
          turnId,
          payload: {
            state,
            ...(activeTurn?.usage !== undefined ? { usage: activeTurn.usage } : {}),
            ...(activeTurn?.totalCostUsd !== undefined
              ? { totalCostUsd: activeTurn.totalCostUsd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
        }),
      );
    }
    emit(
      baseEvent(ctx, {
        type: "session.state.changed",
        payload: { state: "ready" },
      }),
    );
  };

  const ensureAssistantStarted = (ctx: OpenCodeSessionContext) => {
    const turn = ctx.activeTurn;
    if (!turn || turn.assistantStarted) {
      return;
    }
    turn.assistantStarted = true;
    emit(
      baseEvent(ctx, {
        type: "item.started",
        turnId: turn.id,
        itemId: turn.assistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
        },
      }),
    );
  };

  const ensureReasoningItem = (
    ctx: OpenCodeSessionContext,
    partId: string,
    createdAt?: string | undefined,
  ): {
    turn: NonNullable<OpenCodeSessionContext["activeTurn"]>;
    reasoning: OpenCodeReasoningItemState;
  } | null => {
    const turn = ctx.activeTurn;
    if (!turn) {
      return null;
    }

    let reasoning = turn.reasoningItems.get(partId);
    if (!reasoning) {
      reasoning = {
        itemId: RuntimeItemId.makeUnsafe(`opencode-reasoning:${partId}`),
        lastText: "",
        completed: false,
      };
      turn.reasoningItems.set(partId, reasoning);
      emit(
        baseEvent(ctx, {
          type: "item.started",
          ...(createdAt ? { createdAt } : {}),
          turnId: turn.id,
          itemId: reasoning.itemId,
          payload: {
            itemType: "reasoning",
            status: "inProgress",
          },
        }),
      );
    }

    return { turn, reasoning };
  };

  const emitReasoningDelta = (
    ctx: OpenCodeSessionContext,
    partId: string,
    input: {
      text: string;
      streamKind: Extract<OpenCodeDeltaStreamKind, "reasoning_text" | "reasoning_summary_text">;
      isSnapshot?: boolean;
      createdAt?: string | undefined;
    },
  ) => {
    const state = ensureReasoningItem(ctx, partId, input.createdAt);
    if (!state) {
      return;
    }

    const nextText =
      input.isSnapshot === true ? input.text : `${state.reasoning.lastText}${input.text}`;
    const delta = input.isSnapshot
      ? appendOnlyDelta(state.reasoning.lastText, nextText)
      : input.text.length > 0
        ? input.text
        : undefined;
    state.reasoning.lastText = nextText;
    if (!delta || delta.length === 0) {
      return;
    }

    emit(
      baseEvent(ctx, {
        type: "content.delta",
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        turnId: state.turn.id,
        itemId: state.reasoning.itemId,
        payload: {
          streamKind: input.streamKind,
          delta,
        },
      }),
    );
  };

  const handleOpenCodeReasoningPart = (
    ctx: OpenCodeSessionContext,
    part: Record<string, unknown>,
    partId: string,
  ) => {
    const text = asString(part.text) ?? "";
    const time = asRecord(part.time);
    const reasoningStartedAt =
      resolveOpenCodePartTimestamp(part, "start") ?? resolveOpenCodePartTimestamp(part, "end");
    const reasoningCompletedAt = resolveOpenCodePartTimestamp(part, "end");
    const state = ensureReasoningItem(ctx, partId, reasoningStartedAt);
    if (!state) {
      return;
    }
    const reasoningDeltaInput: Parameters<typeof emitReasoningDelta>[2] = {
      text,
      streamKind: "reasoning_text",
      isSnapshot: true,
    };
    const reasoningDeltaCreatedAt = reasoningStartedAt ?? reasoningCompletedAt;
    if (reasoningDeltaCreatedAt) {
      reasoningDeltaInput.createdAt = reasoningDeltaCreatedAt;
    }
    emitReasoningDelta(ctx, partId, reasoningDeltaInput);

    if (time && "end" in time && !state.reasoning.completed) {
      state.reasoning.completed = true;
      emit(
        baseEvent(ctx, {
          type: "item.completed",
          ...(reasoningCompletedAt ? { createdAt: reasoningCompletedAt } : {}),
          turnId: state.turn.id,
          itemId: state.reasoning.itemId,
          payload: {
            itemType: "reasoning",
            status: "completed",
          },
        }),
      );
    }
  };

  const handleOpenCodeToolPart = (
    ctx: OpenCodeSessionContext,
    part: Record<string, unknown>,
    partId: string,
  ) => {
    const turn = ctx.activeTurn;
    if (!turn) {
      return;
    }
    const toolName = nonEmptyString(part.tool) ?? "Tool";
    const state = asRecord(part.state);
    const stateStatus = asString(state?.status) ?? "pending";
    const itemType = classifyOpenCodeToolItemType(toolName);
    const detail = buildOpenCodeToolDetail(state);
    const data = {
      partId,
      tool: toolName,
      ...(asString(part.messageID) ? { messageId: asString(part.messageID) } : {}),
      ...(asString(part.callID) ? { callId: asString(part.callID) } : {}),
      ...(state ? { state } : {}),
      ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
    };

    let toolItem = turn.toolItems.get(partId);
    if (!toolItem) {
      toolItem = {
        itemId: RuntimeItemId.makeUnsafe(`opencode-tool:${partId}`),
        itemType,
        completed: false,
        ...(detail ? { detail } : {}),
      };
      turn.toolItems.set(partId, toolItem);
      emit(
        baseEvent(ctx, {
          type: "item.started",
          turnId: turn.id,
          itemId: toolItem.itemId,
          payload: {
            itemType,
            status: "inProgress",
            title: toolName,
            ...(detail ? { detail } : {}),
            data,
          },
        }),
      );
    } else {
      if (detail) {
        toolItem.detail = detail;
      } else {
        delete toolItem.detail;
      }
    }

    if (stateStatus === "completed" || stateStatus === "error") {
      if (!toolItem.completed) {
        toolItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId: turn.id,
            itemId: toolItem.itemId,
            payload: {
              itemType,
              status: stateStatus === "error" ? "failed" : "completed",
              title: toolName,
              ...(detail ? { detail } : {}),
              data,
            },
          }),
        );
      }
      return;
    }

    emit(
      baseEvent(ctx, {
        type: "item.updated",
        turnId: turn.id,
        itemId: toolItem.itemId,
        payload: {
          itemType,
          status: "inProgress",
          title: toolName,
          ...(detail ? { detail } : {}),
          data,
        },
      }),
    );
  };

  const handleSsePayload = (ctx: OpenCodeSessionContext, raw: unknown) => {
    if (ctx.stopped) return;
    const event = unwrapOpenCodeSseEvent(raw);
    if (!event) return;
    const props = event.properties ?? {};
    const sessionId =
      typeof props.sessionID === "string"
        ? props.sessionID
        : typeof props.sessionId === "string"
          ? props.sessionId
          : undefined;
    if (sessionId && sessionId !== ctx.opencodeSessionId) {
      return;
    }

    switch (event.type) {
      case "message.part.delta": {
        const delta = typeof props.delta === "string" ? props.delta : "";
        const turnId = ctx.activeTurn?.id;
        if (!turnId || !ctx.activeTurn) return;
        if (delta.length > 0) {
          const partId = asString(props.partID);
          const streamKind = resolveOpenCodeDeltaStreamKind({
            field: props.field,
            isReasoningPart: partId ? ctx.activeTurn.reasoningItems.has(partId) : false,
          });
          if (streamKind === "assistant_text") {
            ensureAssistantStarted(ctx);
            ctx.activeTurn.assistantText += delta;
            emit(
              baseEvent(ctx, {
                type: "content.delta",
                turnId,
                itemId: ctx.activeTurn.assistantItemId,
                payload: {
                  streamKind,
                  delta,
                },
              }),
            );
            return;
          }

          emitReasoningDelta(ctx, partId ?? `delta:${randomUUID()}`, {
            text: delta,
            streamKind,
          });
        }
        return;
      }
      case "message.part.updated": {
        const part = asRecord(props.part);
        const partType = asString(part?.type);
        const partId = asString(part?.id);
        if (!part || !partType || !partId) {
          return;
        }
        switch (partType) {
          case "reasoning":
            handleOpenCodeReasoningPart(ctx, part, partId);
            return;
          case "tool":
            handleOpenCodeToolPart(ctx, part, partId);
            return;
          case "step-finish": {
            if (!ctx.activeTurn) {
              return;
            }
            ctx.activeTurn.usage = part.tokens;
            const totalCostUsd = asNumber(part.cost);
            if (totalCostUsd !== undefined) {
              ctx.activeTurn.totalCostUsd = totalCostUsd;
            }
            return;
          }
          default:
            return;
        }
      }
      case "todo.updated": {
        const turnId = ctx.activeTurn?.id;
        if (!turnId) {
          return;
        }
        const todos = Array.isArray(props.todos)
          ? props.todos
              .map((entry) => {
                const todo = asRecord(entry);
                const step = nonEmptyString(todo?.content);
                if (!step) {
                  return null;
                }
                return {
                  step,
                  status: mapOpenCodeTodoStatus(todo?.status),
                };
              })
              .filter(
                (
                  entry,
                ): entry is {
                  readonly step: string;
                  readonly status: "pending" | "inProgress" | "completed";
                } => entry !== null,
              )
          : [];
        emit(
          baseEvent(ctx, {
            type: "turn.plan.updated",
            turnId,
            payload: {
              plan: todos,
            },
          }),
        );
        return;
      }
      case "session.status": {
        const status = asRecord(props.status);
        if (asString(status?.type) !== "retry") {
          return;
        }
        emit(
          baseEvent(ctx, {
            type: "runtime.warning",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            payload: {
              message: nonEmptyString(status?.message) ?? "OpenCode is retrying the request.",
              ...(safeJsonStringify(status) ? { detail: safeJsonStringify(status) } : {}),
            },
          }),
        );
        return;
      }
      case "session.compacted": {
        emit(
          baseEvent(ctx, {
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: props,
            },
          }),
        );
        return;
      }
      case "session.updated": {
        const info = asRecord(props.info);
        const title = nonEmptyString(info?.title);
        if (!title) {
          return;
        }
        emit(
          baseEvent(ctx, {
            type: "thread.metadata.updated",
            payload: {
              name: title,
              ...(info ? { metadata: info } : {}),
            },
          }),
        );
        return;
      }
      case "session.idle": {
        completeTurn(ctx, "completed");
        return;
      }
      case "session.error": {
        const err = props.error;
        const msg =
          err &&
          typeof err === "object" &&
          "message" in err &&
          typeof (err as { message?: string }).message === "string"
            ? String((err as { message: string }).message)
            : "OpenCode session error";
        completeTurn(ctx, "failed", msg);
        emit(
          baseEvent(ctx, {
            type: "runtime.error",
            payload: {
              message: msg,
              class: "provider_error",
            },
          }),
        );
        return;
      }
      case "permission.asked": {
        const requestId =
          typeof props.id === "string"
            ? props.id
            : typeof props.requestID === "string"
              ? props.requestID
              : undefined;
        if (!requestId) return;
        const permission = typeof props.permission === "string" ? props.permission : "permission";
        const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
        ctx.pendingApprovals.set(requestId, {
          requestId: runtimeRequestId,
          requestType: classifyOpenCodePermission(permission),
          ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
        });
        emit(
          baseEvent(ctx, {
            type: "request.opened",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            requestId: runtimeRequestId,
            payload: {
              requestType: classifyOpenCodePermission(permission),
              detail: permission,
              args: props,
            },
          }),
        );
        return;
      }
      case "question.asked": {
        const requestId =
          typeof props.id === "string"
            ? props.id
            : typeof props.requestID === "string"
              ? props.requestID
              : undefined;
        if (!requestId) return;
        const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
        ctx.pendingUserInputs.set(requestId, {
          requestId: runtimeRequestId,
          ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
        });
        const qs = Array.isArray(props.questions)
          ? props.questions.map((q) => q as Record<string, unknown>)
          : [];
        emit(
          baseEvent(ctx, {
            type: "user-input.requested",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            requestId: runtimeRequestId,
            payload: {
              questions: mapQuestions(qs),
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  };

  const startSse = (ctx: OpenCodeSessionContext) => {
    const ac = new AbortController();
    ctx.sseAbort = ac;
    void (async () => {
      try {
        const sub = await ctx.client.event.subscribe({
          directory: ctx.cwd,
        });
        for await (const raw of sub.stream) {
          if (ac.signal.aborted || ctx.stopped) break;
          handleSsePayload(ctx, raw);
        }
      } catch (cause) {
        if (!ctx.stopped) {
          emit(
            baseEvent(ctx, {
              type: "runtime.error",
              payload: {
                message: toMessage(cause, "OpenCode event stream failed"),
                class: "transport_error",
              },
            }),
          );
        }
      }
    })();
  };

  const stopContext = async (ctx: OpenCodeSessionContext): Promise<void> => {
    if (ctx.stopped) {
      return;
    }
    ctx.stopped = true;
    ctx.sseAbort?.abort();

    const cleanupErrors: Array<Error> = [];
    try {
      await ctx.client.session.delete({
        sessionID: ctx.opencodeSessionId,
        directory: ctx.cwd,
      });
    } catch (cause) {
      cleanupErrors.push(
        cause instanceof Error
          ? cause
          : new Error(`Failed to delete OpenCode session: ${String(cause)}`),
      );
    }
    try {
      await ctx.server.close();
    } catch (cause) {
      cleanupErrors.push(
        cause instanceof Error
          ? cause
          : new Error(`Failed to stop OpenCode server: ${String(cause)}`),
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to fully stop OpenCode session.");
    }
  };

  const startSession: OpenCodeAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    Effect.tryPromise({
      try: async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected OpenCode model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) {
          return existing.session;
        }

        const settings = await runPromise(serverSettingsService.getSettings);
        const binaryPath = settings.providers.opencode.binaryPath;
        const server = await startOpenCodeServer(binaryPath);
        const cwd = input.cwd ?? serverConfig.cwd;
        const client = createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: cwd,
        });
        try {
          const listed = await client.provider.list();
          if (listed.error) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "provider.list",
              detail: toMessage(listed.error, "Failed to list OpenCode providers"),
            });
          }
          const body = listed.data as { default?: Record<string, string> } | undefined;
          const defaultModels = body?.default ?? {};

          const created = await client.session.create({
            directory: cwd,
            title: "ace",
          });
          if (created.error || !created.data) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.create",
              detail: toMessage(created.error, "Failed to create OpenCode session"),
            });
          }
          const opencodeSessionId = created.data.id;

          const createdAt = isoNow();
          const model =
            input.modelSelection && input.modelSelection.provider === PROVIDER
              ? input.modelSelection.model
              : DEFAULT_MODEL_BY_PROVIDER.opencode;

          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model,
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          };

          const ctx: OpenCodeSessionContext = {
            threadId: input.threadId,
            session,
            cwd,
            server,
            client,
            opencodeSessionId,
            defaultModels,
            turns: [],
            replayTurns: cloneReplayTurns(input.replayTurns),
            totalProcessedTokens: 0,
            sequenceTieBreakersByTimestampMs: new Map(),
            nextFallbackSessionSequence: 0,
            activeTurn: null,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            sseAbort: null,
            pendingBootstrapReset: (input.replayTurns?.length ?? 0) > 0,
            stopped: false,
          };
          sessions.set(input.threadId, ctx);
          startSse(ctx);

          emit(
            baseEvent(ctx, {
              type: "session.started",
              payload: {},
            }),
          );
          emit(
            baseEvent(ctx, {
              type: "thread.started",
              payload: { providerThreadId: opencodeSessionId },
            }),
          );
          return ctx.session;
        } catch (cause) {
          try {
            await server.close();
          } catch (cleanupCause) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: `${toMessage(cause, "OpenCode session start failed")} Cleanup also failed: ${toMessage(
                cleanupCause,
                "Failed to stop OpenCode server",
              )}`,
              cause: new AggregateError([cause, cleanupCause]),
            });
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
              detail: toMessage(cause, "OpenCode session start failed"),
              cause,
            }),
    });

  const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.tryPromise({
      try: async () => {
        const ctx = sessions.get(input.threadId);
        if (!ctx) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected OpenCode model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (ctx.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt_async",
            detail: "OpenCode session already has an active turn.",
          });
        }

        const turnId = TurnId.makeUnsafe(`opencode-turn:${randomUUID()}`);
        const assistantItemId = RuntimeItemId.makeUnsafe(`opencode-assistant:${randomUUID()}`);
        const selectedModelSlug =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : (ctx.session.model ?? DEFAULT_MODEL_BY_PROVIDER.opencode);
        const modelIds = resolveOpenCodeModel(
          input.modelSelection,
          selectedModelSlug,
          ctx.defaultModels,
        );

        ctx.activeTurn = {
          id: turnId,
          startedAtMs: Date.now(),
          inputText: input.input ?? "",
          attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
          assistantText: "",
          assistantItemId,
          assistantStarted: false,
          toolItems: new Map(),
          reasoningItems: new Map(),
        };
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: isoNow(),
          model: selectedModelSlug,
        };

        emit(
          baseEvent(ctx, {
            type: "turn.started",
            turnId,
            payload: { model: selectedModelSlug },
          }),
        );

        const parts: Array<
          | { type: "text"; text: string }
          | { type: "file"; mime: string; url: string; filename?: string }
        > = [];

        const promptText = ctx.pendingBootstrapReset
          ? buildBootstrapPromptFromReplayTurns(
              ctx.replayTurns,
              input.input ?? "Please analyze the attached files.",
              ROLLBACK_BOOTSTRAP_MAX_CHARS,
            ).text
          : input.input;

        if (promptText && promptText.trim().length > 0) {
          parts.push({ type: "text", text: promptText });
        }

        const attachments = (input.attachments ?? [])
          .map((attachment) => {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) return null;
            return { path, name: attachment.name };
          })
          .filter((a): a is { path: string; name: string } => a !== null);

        for (const attachment of attachments) {
          parts.push({
            type: "file",
            mime: "application/octet-stream",
            url: pathToFileURL(attachment.path).href,
            filename: attachment.name,
          });
        }

        if (parts.length === 0) {
          parts.push({ type: "text", text: " " });
        }

        const prompt = await ctx.client.session.promptAsync({
          sessionID: ctx.opencodeSessionId,
          directory: ctx.cwd,
          model: modelIds,
          parts,
        });

        if (prompt.error) {
          completeTurn(ctx, "failed", toMessage(prompt.error, "OpenCode prompt failed"));
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt_async",
            detail: toMessage(prompt.error, "OpenCode prompt failed"),
          });
        }

        ctx.pendingBootstrapReset = false;
        ctx.turns.push({ id: turnId, items: [] });
        return {
          threadId: input.threadId,
          turnId,
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
              detail: toMessage(cause, "OpenCode sendTurn failed"),
              cause,
            }),
    });

  const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId: ThreadId) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const result = await ctx.client.session.abort({
        sessionID: ctx.opencodeSessionId,
        directory: ctx.cwd,
      });
      if (result.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.abort",
          detail: toMessage(result.error, "OpenCode abort failed"),
        });
      }
      completeTurn(ctx, "interrupted");
    });

  const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const reply = mapApprovalDecision(decision);
      const res = await ctx.client.permission.reply({
        requestID: requestId,
        directory: ctx.cwd,
        reply,
      });
      if (res.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: toMessage(res.error, "OpenCode permission reply failed"),
        });
      }
      const pending = ctx.pendingApprovals.get(requestId);
      ctx.pendingApprovals.delete(requestId);
      emit(
        baseEvent(ctx, {
          type: "request.resolved",
          ...(pending?.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending?.requestId ?? RuntimeRequestId.makeUnsafe(requestId),
          payload: {
            requestType: pending?.requestType ?? "dynamic_tool_call",
            decision,
          },
        }),
      );
    });

  const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const sortedKeys = Object.keys(answers).toSorted((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      const answerArrays: string[][] = sortedKeys.map((key) => {
        const v = answers[key];
        if (Array.isArray(v)) return v.map((x) => String(x));
        return [String(v ?? "")];
      });
      const res = await ctx.client.question.reply({
        requestID: requestId,
        directory: ctx.cwd,
        answers: answerArrays,
      });
      if (res.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: toMessage(res.error, "OpenCode question reply failed"),
        });
      }
      const pending = ctx.pendingUserInputs.get(requestId);
      ctx.pendingUserInputs.delete(requestId);
      emit(
        baseEvent(ctx, {
          type: "user-input.resolved",
          ...(pending?.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending?.requestId ?? RuntimeRequestId.makeUnsafe(requestId),
          payload: {
            answers,
          },
        }),
      );
    });

  const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId: ThreadId) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      sessions.delete(threadId);
      await stopContext(ctx);
    });

  const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: OpenCodeAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return {
        threadId,
        turns: ctx.turns.map((t) => ({ id: t.id, items: [...t.items] })),
      };
    });

  const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const ctx = sessions.get(threadId);
      if (!ctx) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (ctx.activeTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenCode cannot roll back while a turn is still running.",
        });
      }

      const nextLength = Math.max(0, ctx.turns.length - numTurns);
      const trimmedTurns = ctx.turns.slice(0, nextLength).map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      }));
      const trimmedReplayTurns = ctx.replayTurns.slice(0, nextLength).map((turn) => {
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
        runtimeMode: ctx.session.runtimeMode,
        ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        ...(ctx.session.model
          ? {
              modelSelection: {
                provider: PROVIDER,
                model: ctx.session.model,
              } as const,
            }
          : {}),
      };

      yield* stopSession(threadId);
      yield* startSession(restartInput);

      const restarted = sessions.get(threadId);
      if (!restarted) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenCode rollback failed to recreate the session.",
        });
      }

      restarted.turns.push(...trimmedTurns);
      restarted.replayTurns.push(...trimmedReplayTurns);
      restarted.pendingBootstrapReset = trimmedReplayTurns.length > 0;

      return {
        threadId,
        turns: restarted.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    },
  );

  const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      for (const [threadId, ctx] of sessions) {
        sessions.delete(threadId);
        await stopContext(ctx);
      }
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
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
  } satisfies OpenCodeAdapterShape;
});

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter());
