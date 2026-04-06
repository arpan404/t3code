import { randomUUID } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CursorModelOptions,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeItemStatus,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { inferModelContextWindowTokens } from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, PubSub, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { startCursorAcpClient, type CursorAcpClient, type CursorAcpJsonRpcId } from "../cursorAcp";
import { type CursorAdapterShape, CursorAdapter } from "../Services/CursorAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import { resolveCursorCliModelId } from "./CursorProvider.ts";
import {
  describeCursorAdapterCause,
  findKnownCursorAdapterError,
  isMissingCursorSessionError,
  isProviderAdapterProcessError,
  isProviderAdapterRequestError,
  isProviderAdapterSessionNotFoundError,
  isProviderAdapterValidationError,
} from "./CursorAdapterErrors.ts";
import {
  type CursorPermissionOption,
  type CursorSessionConfigOption,
  type CursorSessionConfigOptionValue,
  type CursorSessionMetadata,
  EMPTY_CURSOR_SESSION_METADATA,
  buildCursorSessionMetadata,
  cursorSessionMetadataSnapshot,
  findCursorConfigOption,
  parseCursorAvailableCommands,
  parseCursorConfigOptions,
  parseCursorInitializeState,
  parseCursorSessionModeState,
  parseCursorSessionModelState,
} from "./CursorAdapterSessionMetadata.ts";
import {
  buildCursorToolData,
  classifyCursorToolItemType,
  cursorPermissionKindsForDecision,
  cursorPermissionKindsForRuntimeMode,
  defaultCursorToolTitle,
  describePermissionRequest,
  extractCursorStreamText,
  extractCursorToolCommand,
  extractCursorToolContentText,
  extractCursorToolPath,
  isFinalCursorToolStatus,
  parseCursorPermissionOptions,
  permissionOptionKindForRuntimeMode,
  requestTypeForCursorTool,
  resolveCursorToolTitle,
  runtimeItemStatusFromCursorStatus,
  selectCursorPermissionOption,
  streamKindFromUpdateKind,
} from "./CursorAdapterToolHelpers.ts";
import {
  type CursorUsageSnapshot,
  buildCursorTurnUsageSnapshot,
  buildCursorUsageSnapshot,
} from "./CursorAdapterUsageParsing.ts";
import { asObject, asTrimmedNonEmptyString as asString } from "../unknown.ts";

const PROVIDER = "cursor" as const;
const ACP_CONTROL_TIMEOUT_MS = 15_000;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;

type CursorResumeCursor = {
  readonly sessionId: string;
};

type PendingApproval = {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: CursorAcpJsonRpcId;
  readonly requestType: CanonicalRequestType;
  readonly options: ReadonlyArray<CursorPermissionOption>;
  readonly turnId?: TurnId;
};

type PendingUserInput =
  | {
      readonly requestId: ApprovalRequestId;
      readonly jsonRpcId: CursorAcpJsonRpcId;
      readonly turnId?: TurnId;
      readonly kind: "ask-question";
      readonly optionIdsByQuestionAndLabel: ReadonlyMap<string, ReadonlyMap<string, string>>;
      readonly questions: ReadonlyArray<UserInputQuestion>;
    }
  | {
      readonly requestId: ApprovalRequestId;
      readonly jsonRpcId: CursorAcpJsonRpcId;
      readonly turnId?: TurnId;
      readonly kind: "create-plan";
      readonly questions: ReadonlyArray<UserInputQuestion>;
    };

type CursorContentItemState = {
  readonly itemId: RuntimeItemId;
  text: string;
};

type TurnSnapshot = {
  readonly id: TurnId;
  readonly startedAtMs: number;
  readonly inputText: string;
  readonly attachmentNames: ReadonlyArray<string>;
  readonly items: Array<unknown>;
  assistantText: string;
  interruptRequested: boolean;
  reasoningText: string;
  assistantItem: CursorContentItemState | undefined;
  reasoningItem: CursorContentItemState | undefined;
  readonly toolCalls: Map<string, CursorToolState>;
};

type CursorSessionContext = {
  session: ProviderSession;
  readonly client: CursorAcpClient;
  metadata: CursorSessionMetadata;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<TurnSnapshot>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  activeTurn: TurnSnapshot | undefined;
  lastUsageSnapshot?: CursorUsageSnapshot;
  lastUsageTurnId?: TurnId;
  pendingBootstrapReset: boolean;
  stopping: boolean;
  startPromise: Promise<ProviderSession> | undefined;
};

type CursorToolState = {
  readonly toolCallId: string;
  readonly itemId: RuntimeItemId;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly status: RuntimeItemStatus;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
};

function isoNow(): string {
  return new Date().toISOString();
}

function readResumeSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sessionId = (value as { readonly sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
}

function contentItemType(kind: "assistant" | "reasoning"): CanonicalItemType {
  return kind === "assistant" ? "assistant_message" : "reasoning";
}

function contentItemTitle(kind: "assistant" | "reasoning") {
  return kind === "assistant" ? "Assistant response" : "Reasoning";
}

function getContentItemState(
  turn: TurnSnapshot,
  kind: "assistant" | "reasoning",
): CursorContentItemState | undefined {
  return kind === "assistant" ? turn.assistantItem : turn.reasoningItem;
}

function setContentItemState(
  turn: TurnSnapshot,
  kind: "assistant" | "reasoning",
  state: CursorContentItemState | undefined,
) {
  if (kind === "assistant") {
    turn.assistantItem = state;
    return;
  }
  turn.reasoningItem = state;
}

function cursorToolLookupInput(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}) {
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.subagentType ? { subagentType: input.subagentType } : {}),
  };
}

function requestIdFromApprovalRequest(requestId: ApprovalRequestId) {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function cursorTaskSubagentType(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) {
    return direct;
  }
  const record = asObject(value);
  return asString(record?.custom);
}

function cursorModelTokens(value: string): ReadonlySet<string> {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\[|\]|=|,/g, "-")
    .split(/[^a-z0-9]+/g)
    .filter((entry): entry is string => entry.length > 0);
  const tokens = new Set<string>();
  for (const entry of normalized) {
    if (entry === "default" || entry === "auto") {
      tokens.add("default");
      tokens.add("auto");
      continue;
    }
    if (entry === "false") {
      continue;
    }
    if (entry === "reasoning" || entry === "effort" || entry === "context") {
      continue;
    }
    tokens.add(entry);
  }
  return tokens;
}

const CURSOR_MODEL_VARIANT_TOKENS = new Set<string>([
  "auto",
  "default",
  "fast",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
  "think",
  "none",
]);

function stripCursorVariantTokens(tokens: ReadonlySet<string>): ReadonlySet<string> {
  const filtered = new Set<string>();
  for (const token of tokens) {
    if (!CURSOR_MODEL_VARIANT_TOKENS.has(token)) {
      filtered.add(token);
    }
  }
  return filtered;
}

function sameCursorTokenSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const token of left) {
    if (!right.has(token)) {
      return false;
    }
  }
  return true;
}

function isCursorTokenSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const token of subset) {
    if (!superset.has(token)) {
      return false;
    }
  }
  return true;
}

function compatibleCursorCoreTokenSets(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size === 0 || right.size === 0) {
    return true;
  }
  return isCursorTokenSubset(left, right) || isCursorTokenSubset(right, left);
}

type ParsedCursorModelConfigChoice = {
  readonly choice: CursorSessionConfigOptionValue;
  readonly valuePrefix: string;
  readonly identityTokens: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
};

function parseCursorModelConfigChoice(
  choice: CursorSessionConfigOptionValue,
): ParsedCursorModelConfigChoice {
  const bracketIndex = choice.value.indexOf("[");
  const valuePrefix = bracketIndex === -1 ? choice.value : choice.value.slice(0, bracketIndex);
  const identityTokens = cursorModelTokens(valuePrefix);
  return {
    choice,
    valuePrefix,
    identityTokens,
    tokens: new Set<string>([
      ...identityTokens,
      ...cursorModelTokens(choice.value),
      ...cursorModelTokens(choice.name),
      ...cursorModelTokens(choice.description ?? ""),
    ]),
  };
}

function resolveCursorModelConfigValue(input: {
  readonly model: string;
  readonly options?: CursorModelOptions | null | undefined;
  readonly modelOption: CursorSessionConfigOption;
}): string | undefined {
  const requestedModelId = input.model.trim();
  const cliModelId = resolveCursorCliModelId({
    model: input.model,
    options: input.options,
  });
  const exactModelIds = [requestedModelId, cliModelId].filter(
    (value, index, values): value is string =>
      value.length > 0 &&
      values.findIndex((entry) => entry.toLowerCase() === value.toLowerCase()) === index,
  );
  const targetTokens = cursorModelTokens(cliModelId);
  const targetIdentityTokens = cursorModelTokens(input.model);
  const targetCoreTokens = stripCursorVariantTokens(
    targetIdentityTokens.size > 0 ? targetIdentityTokens : targetTokens,
  );
  let best:
    | {
        readonly value: string;
        readonly score: number;
      }
    | undefined;
  for (const choice of input.modelOption.options) {
    const parsed = parseCursorModelConfigChoice(choice);
    const valuePrefix = parsed.valuePrefix.toLowerCase();
    if (exactModelIds.some((modelId) => valuePrefix === modelId.toLowerCase())) {
      return choice.value;
    }
    const choiceCoreTokens = stripCursorVariantTokens(parsed.identityTokens);
    if (
      targetCoreTokens.size > 0 &&
      !compatibleCursorCoreTokenSets(choiceCoreTokens, targetCoreTokens)
    ) {
      continue;
    }
    let score = 0;
    if (sameCursorTokenSet(choiceCoreTokens, targetCoreTokens)) {
      score += 24;
    }
    for (const token of targetCoreTokens) {
      if (parsed.tokens.has(token)) {
        score += 12;
      }
    }
    for (const token of targetTokens) {
      if (parsed.tokens.has(token)) {
        score += 6;
      }
    }
    for (const token of targetIdentityTokens) {
      if (parsed.tokens.has(token)) {
        score += 3;
      }
    }
    score -= Math.max(0, parsed.tokens.size - targetTokens.size);
    if (!best || score > best.score) {
      best = {
        value: choice.value,
        score,
      };
    }
  }
  return best?.value;
}

function planStepsFromTodos(
  todos: unknown,
): Array<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  if (!Array.isArray(todos)) {
    return [];
  }
  return todos
    .map((todo) => asObject(todo))
    .filter((todo): todo is Record<string, unknown> => todo !== undefined)
    .map((todo) => ({
      step: asString(todo.content) ?? "Todo",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

export const CursorAdapterLive = Layer.effect(
  CursorAdapter,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const services = yield* Effect.services();
    const runPromise = Effect.runPromiseWith(services);
    const eventsPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderRuntimeEvent>(),
      PubSub.shutdown,
    );
    const sessions = new Map<ThreadId, CursorSessionContext>();

    const emit = (event: ProviderRuntimeEvent) => {
      void runPromise(PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid));
    };

    const resolveSelectedModel = (modelSelection: { readonly model: string } | undefined) =>
      modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER.cursor;

    const baseEvent = (
      context: CursorSessionContext,
      input: {
        readonly turnId?: TurnId;
        readonly itemId?: RuntimeItemId;
        readonly requestId?: ApprovalRequestId;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      } = {},
    ) => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: isoNow(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: requestIdFromApprovalRequest(input.requestId) } : {}),
      ...(input.rawMethod
        ? {
            raw: {
              source:
                input.rawSource ??
                (input.requestId
                  ? ("cursor.acp.request" as const)
                  : ("cursor.acp.notification" as const)),
              method: input.rawMethod,
              payload: input.rawPayload ?? {},
            },
          }
        : {}),
    });

    const updateSession = (context: CursorSessionContext, patch: Partial<ProviderSession>) => {
      context.session = {
        ...context.session,
        ...patch,
        updatedAt: isoNow(),
      };
    };

    const updateMetadata = (
      context: CursorSessionContext,
      patch: Parameters<typeof buildCursorSessionMetadata>[0],
    ) => {
      context.metadata = buildCursorSessionMetadata({
        previous: context.metadata,
        ...patch,
      });
    };

    const emitSessionConfigured = (
      context: CursorSessionContext,
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      emit({
        ...baseEvent(context, {
          rawMethod: input.rawMethod,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: "session.configured",
        payload: {
          config: cursorSessionMetadataSnapshot(context.metadata),
        },
      });
    };

    const requireCursorSessionId = (context: CursorSessionContext, method: string) => {
      const sessionId = readResumeSessionId(context.session.resumeCursor);
      if (!sessionId) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Cursor session is missing a resumable session id.",
        });
      }
      return sessionId;
    };

    const currentCursorModeId = (context: CursorSessionContext) =>
      findCursorConfigOption(context.metadata.configOptions, { category: "mode", id: "mode" })
        ?.currentValue ?? context.metadata.modes?.currentModeId;

    const currentCursorModelConfigValue = (context: CursorSessionContext) =>
      findCursorConfigOption(context.metadata.configOptions, { category: "model", id: "model" })
        ?.currentValue ?? context.metadata.models?.currentModelId;

    const currentCursorContextWindowTokens = (context: CursorSessionContext) =>
      inferModelContextWindowTokens(
        PROVIDER,
        currentCursorModelConfigValue(context) ?? context.session.model,
      );

    const availableCursorModeIds = (context: CursorSessionContext) => {
      const modeOption = findCursorConfigOption(context.metadata.configOptions, {
        category: "mode",
        id: "mode",
      });
      if (modeOption) {
        return new Set(modeOption.options.map((option) => option.value));
      }
      return new Set(context.metadata.modes?.availableModes.map((mode) => mode.id) ?? []);
    };

    const cursorControlRequest = async (
      context: CursorSessionContext,
      method: string,
      params: unknown,
    ) =>
      context.client.request(method, params, {
        timeoutMs: ACP_CONTROL_TIMEOUT_MS,
      });

    const buildCursorPromptContent = Effect.fn("buildCursorPromptContent")(function* (
      context: CursorSessionContext,
      input: ProviderSendTurnInput,
    ) {
      const prompt: Array<Record<string, unknown>> = [];
      if (input.input !== undefined) {
        prompt.push({ type: "text", text: input.input });
      }

      const attachments = input.attachments ?? [];
      if (
        attachments.length > 0 &&
        !context.metadata.initialize.agentCapabilities.promptCapabilities.image
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Cursor ACP session does not advertise image prompt support.",
        });
      }

      for (const attachment of attachments) {
        if (attachment.type !== "image") {
          continue;
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: describeCursorAdapterCause(cause),
                cause,
              }),
          ),
        );
        prompt.push({
          type: "image",
          mimeType: attachment.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        });
      }

      if (prompt.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Cursor prompts require text or supported prompt attachments.",
        });
      }

      return prompt;
    });

    const syncCursorInteractionMode = async (
      context: CursorSessionContext,
      interactionMode: ProviderSendTurnInput["interactionMode"],
    ) => {
      if (interactionMode === undefined) {
        return;
      }
      const sessionId = requireCursorSessionId(context, "session/set_mode");
      const currentModeId = currentCursorModeId(context);
      const availableModeIds = availableCursorModeIds(context);
      const desiredModeId =
        interactionMode === "plan"
          ? availableModeIds.has("plan")
            ? "plan"
            : undefined
          : (context.metadata.defaultModeId ??
            currentModeId ??
            findCursorConfigOption(context.metadata.configOptions, { category: "mode", id: "mode" })
              ?.options[0]?.value ??
            context.metadata.modes?.availableModes[0]?.id);
      if (!desiredModeId) {
        if (interactionMode === "plan") {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/set_mode",
            detail: "Cursor ACP session does not expose a plan mode.",
          });
        }
        return;
      }
      if (currentModeId === desiredModeId) {
        return;
      }
      const modeOption = findCursorConfigOption(context.metadata.configOptions, {
        category: "mode",
        id: "mode",
      });
      if (modeOption?.options.some((option) => option.value === desiredModeId)) {
        const result = await cursorControlRequest(context, "session/set_config_option", {
          sessionId,
          configId: modeOption.id,
          value: desiredModeId,
        });
        const resultRecord = asObject(result);
        updateMetadata(context, {
          configOptions:
            resultRecord && "configOptions" in resultRecord
              ? parseCursorConfigOptions(resultRecord.configOptions)
              : context.metadata.configOptions,
          currentModeId: desiredModeId,
        });
        emitSessionConfigured(context, {
          rawMethod: "session/set_config_option",
          rawPayload: result,
          rawSource: "cursor.acp.request",
        });
        return;
      }
      if (!availableModeIds.has(desiredModeId)) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/set_mode",
          detail: `Cursor ACP session does not support mode '${desiredModeId}'.`,
        });
      }
      await cursorControlRequest(context, "session/set_mode", {
        sessionId,
        modeId: desiredModeId,
      });
      updateMetadata(context, {
        currentModeId: desiredModeId,
      });
      emitSessionConfigured(context, {
        rawMethod: "session/set_mode",
        rawPayload: { currentModeId: desiredModeId },
        rawSource: "cursor.acp.request",
      });
    };

    const syncCursorModelSelection = async (
      context: CursorSessionContext,
      modelSelection:
        | {
            readonly provider: "cursor";
            readonly model: string;
            readonly options?: CursorModelOptions | undefined;
          }
        | undefined,
    ) => {
      if (!modelSelection) {
        return;
      }
      const modelOption = findCursorConfigOption(context.metadata.configOptions, {
        category: "model",
        id: "model",
      });
      updateSession(context, {
        model: modelSelection.model,
      });
      if (!modelOption) {
        return;
      }
      const desiredValue = resolveCursorModelConfigValue({
        model: modelSelection.model,
        options: modelSelection.options,
        modelOption,
      });
      if (!desiredValue) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/set_config_option",
          detail: `Cursor ACP session does not expose model '${modelSelection.model}'.`,
        });
      }
      if (currentCursorModelConfigValue(context) === desiredValue) {
        return;
      }
      const sessionId = requireCursorSessionId(context, "session/set_config_option");
      const result = await cursorControlRequest(context, "session/set_config_option", {
        sessionId,
        configId: modelOption.id,
        value: desiredValue,
      });
      const resultRecord = asObject(result);
      updateMetadata(context, {
        configOptions:
          resultRecord && "configOptions" in resultRecord
            ? parseCursorConfigOptions(resultRecord.configOptions)
            : context.metadata.configOptions,
        currentModelId: desiredValue,
      });
      emitSessionConfigured(context, {
        rawMethod: "session/set_config_option",
        rawPayload: result,
        rawSource: "cursor.acp.request",
      });
    };

    const ensureContentItem = (
      context: CursorSessionContext,
      turnId: TurnId,
      kind: "assistant" | "reasoning",
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ): CursorContentItemState | undefined => {
      const activeTurn = context.activeTurn;
      if (!activeTurn || activeTurn.id !== turnId) {
        return undefined;
      }
      const existing = getContentItemState(activeTurn, kind);
      if (existing) {
        return existing;
      }
      const state: CursorContentItemState = {
        itemId: RuntimeItemId.makeUnsafe(`cursor-${kind}:${randomUUID()}`),
        text: "",
      };
      setContentItemState(activeTurn, kind, state);
      emit({
        ...baseEvent(context, {
          turnId,
          itemId: state.itemId,
          rawMethod: input.rawMethod,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: "item.started",
        payload: {
          itemType: contentItemType(kind),
          title: contentItemTitle(kind),
          status: "inProgress",
        },
      });
      return state;
    };

    const completeContentItem = (
      context: CursorSessionContext,
      turnId: TurnId,
      kind: "assistant" | "reasoning",
      input?: {
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      const activeTurn = context.activeTurn;
      if (!activeTurn || activeTurn.id !== turnId) {
        return;
      }
      const state = getContentItemState(activeTurn, kind);
      if (!state) {
        return;
      }
      setContentItemState(activeTurn, kind, undefined);
      emit({
        ...baseEvent(context, {
          turnId,
          itemId: state.itemId,
          ...(input?.rawMethod ? { rawMethod: input.rawMethod } : {}),
          ...(input?.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input?.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: "item.completed",
        payload: {
          itemType: contentItemType(kind),
          title: contentItemTitle(kind),
          status: "completed",
          ...(state.text.length > 0 ? { detail: state.text } : {}),
        },
      });
    };

    const completeActiveContentItems = (
      context: CursorSessionContext,
      turnId: TurnId,
      input?: {
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      completeContentItem(context, turnId, "assistant", input);
      completeContentItem(context, turnId, "reasoning", input);
    };

    const emitToolLifecycleEvent = (
      context: CursorSessionContext,
      input: {
        readonly turnId: TurnId;
        readonly tool: CursorToolState;
        readonly type: "item.started" | "item.updated" | "item.completed";
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      emit({
        ...baseEvent(context, {
          turnId: input.turnId,
          itemId: input.tool.itemId,
          rawMethod: input.rawMethod,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: input.type,
        payload: {
          itemType: input.tool.itemType,
          status: input.tool.status,
          title: input.tool.title,
          ...(input.tool.detail ? { detail: input.tool.detail } : {}),
          ...(Object.keys(input.tool.data).length > 0 ? { data: input.tool.data } : {}),
        },
      });
    };

    const syncCursorToolCall = (
      context: CursorSessionContext,
      turnId: TurnId,
      record: Record<string, unknown>,
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return undefined;
      }
      const toolCallId = asString(record.toolCallId);
      if (!toolCallId) {
        return undefined;
      }
      const existing = activeTurn.toolCalls.get(toolCallId);
      const detectedItemType = classifyCursorToolItemType(
        cursorToolLookupInput({
          kind: asString(record.kind),
          title: asString(record.title),
        }),
      );
      const itemType =
        existing && existing.itemType !== "dynamic_tool_call"
          ? existing.itemType
          : detectedItemType;
      const status = asString(record.status)
        ? runtimeItemStatusFromCursorStatus(asString(record.status))
        : (existing?.status ?? "inProgress");
      const title = resolveCursorToolTitle(itemType, asString(record.title), existing?.title);
      const detail =
        extractCursorToolCommand(record) ??
        extractCursorToolPath(record) ??
        extractCursorToolContentText(record) ??
        existing?.detail;
      const tool: CursorToolState = {
        toolCallId,
        itemId: existing?.itemId ?? RuntimeItemId.makeUnsafe(`cursor-tool:${randomUUID()}`),
        itemType,
        title,
        status,
        ...(detail ? { detail } : {}),
        data: buildCursorToolData(existing?.data, record),
      };
      activeTurn.toolCalls.set(toolCallId, tool);
      if (!existing) {
        activeTurn.items.push({
          kind: "tool_call",
          toolCallId,
          itemType,
          data: tool.data,
        });
      }
      emitToolLifecycleEvent(context, {
        turnId,
        tool,
        type:
          !existing && !isFinalCursorToolStatus(status)
            ? "item.started"
            : isFinalCursorToolStatus(status)
              ? "item.completed"
              : "item.updated",
        rawMethod: input.rawMethod,
        ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
        ...(input.rawSource ? { rawSource: input.rawSource } : {}),
      });
      return tool;
    };

    const settleTurn = (
      context: CursorSessionContext,
      turnId: TurnId,
      outcome:
        | {
            readonly type: "completed";
            readonly stopReason?: string | null;
            readonly errorMessage?: string;
            readonly usage?: unknown;
          }
        | { readonly type: "aborted"; readonly reason: string },
    ) => {
      if (!context.activeTurn || context.activeTurn.id !== turnId) {
        return;
      }

      const turnUsageSnapshot = buildCursorTurnUsageSnapshot(
        outcome.type === "completed" ? outcome.usage : undefined,
        context.activeTurn,
        context.lastUsageTurnId === turnId ? context.lastUsageSnapshot : undefined,
        currentCursorContextWindowTokens(context),
      );
      const finalUsageSnapshot =
        turnUsageSnapshot ??
        (context.lastUsageTurnId === turnId && context.lastUsageSnapshot
          ? context.lastUsageSnapshot
          : undefined);
      const finalizedUsageSnapshot =
        finalUsageSnapshot !== undefined
          ? {
              ...finalUsageSnapshot,
              ...(context.activeTurn.toolCalls.size > 0
                ? { toolUses: context.activeTurn.toolCalls.size }
                : {}),
              ...(Date.now() - context.activeTurn.startedAtMs > 0
                ? { durationMs: Math.round(Date.now() - context.activeTurn.startedAtMs) }
                : {}),
            }
          : undefined;

      completeActiveContentItems(context, turnId);
      context.turns.push(context.activeTurn);
      context.replayTurns.push({
        prompt: context.activeTurn.inputText,
        attachmentNames: [...context.activeTurn.attachmentNames],
        ...(context.activeTurn.assistantText.trim().length > 0
          ? { assistantResponse: context.activeTurn.assistantText }
          : {}),
      });
      context.activeTurn = undefined;
      updateSession(context, {
        activeTurnId: undefined,
        status: outcome.type === "completed" && outcome.errorMessage ? "error" : "ready",
        ...(outcome.type === "completed" && outcome.errorMessage
          ? { lastError: outcome.errorMessage }
          : {}),
      });

      if (finalizedUsageSnapshot) {
        context.lastUsageSnapshot = finalizedUsageSnapshot;
        context.lastUsageTurnId = turnId;
        emit({
          ...baseEvent(context, { turnId }),
          type: "thread.token-usage.updated",
          payload: {
            usage: finalizedUsageSnapshot,
          },
        });
      }

      if (outcome.type === "completed") {
        emit({
          ...baseEvent(context, { turnId }),
          type: "turn.completed",
          payload: {
            state: outcome.errorMessage ? "failed" : "completed",
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          },
        });
        return;
      }

      emit({
        ...baseEvent(context, { turnId }),
        type: "turn.aborted",
        payload: {
          reason: outcome.reason,
        },
      });
    };

    const cancelPendingApprovalsForTurn = (
      context: CursorSessionContext,
      turnId: TurnId,
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
      },
    ) => {
      for (const [requestId, pending] of context.pendingApprovals.entries()) {
        if (pending.turnId !== turnId) {
          continue;
        }
        context.pendingApprovals.delete(requestId);
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "cancelled",
          },
        });
        emit({
          ...baseEvent(context, {
            turnId,
            requestId,
            rawMethod: input.rawMethod,
            ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
            rawSource: "cursor.acp.notification",
          }),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision: "cancel",
            resolution: {
              outcome: "cancelled",
            },
          },
        });
      }
    };

    const cancelPendingUserInputsForTurn = (
      context: CursorSessionContext,
      turnId: TurnId,
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
      },
    ) => {
      for (const [requestId, pending] of context.pendingUserInputs.entries()) {
        if (pending.turnId !== turnId) {
          continue;
        }
        context.pendingUserInputs.delete(requestId);
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "cancelled",
          },
        });
        emit({
          ...baseEvent(context, {
            turnId,
            requestId,
            rawMethod: input.rawMethod,
            ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
            rawSource: "cursor.acp.notification",
          }),
          type: "user-input.resolved",
          payload: {
            answers: {},
          },
        });
      }
    };

    const handleSessionUpdate = (context: CursorSessionContext, params: unknown) => {
      const record = asObject(params);
      const update = asObject(record?.update);
      const updateKind = asString(update?.sessionUpdate);
      if (!updateKind || !update) {
        return;
      }

      if (updateKind === "current_mode_update") {
        updateMetadata(context, {
          currentModeId: asString(update.currentModeId),
        });
        emitSessionConfigured(context, {
          rawMethod: "session/update",
          rawPayload: params,
          rawSource: "cursor.acp.notification",
        });
        return;
      }

      if (updateKind === "config_option_update") {
        const configOptions = parseCursorConfigOptions(update.configOptions);
        if (configOptions.length > 0) {
          updateMetadata(context, {
            configOptions,
          });
        }
        emitSessionConfigured(context, {
          rawMethod: "session/update",
          rawPayload: params,
          rawSource: "cursor.acp.notification",
        });
        return;
      }

      if (updateKind === "available_commands_update") {
        updateMetadata(context, {
          availableCommands: parseCursorAvailableCommands(update.availableCommands),
        });
        emitSessionConfigured(context, {
          rawMethod: "session/update",
          rawPayload: params,
          rawSource: "cursor.acp.notification",
        });
        return;
      }

      if (updateKind === "usage_update") {
        const usage = buildCursorUsageSnapshot(
          update,
          context.activeTurn,
          currentCursorContextWindowTokens(context),
        );
        if (!usage) {
          return;
        }
        context.lastUsageSnapshot = usage;
        if (context.activeTurn) {
          context.lastUsageTurnId = context.activeTurn.id;
        } else {
          delete context.lastUsageTurnId;
        }
        emit({
          ...baseEvent(context, {
            ...(context.activeTurn ? { turnId: context.activeTurn.id } : {}),
            rawMethod: "session/update",
            rawPayload: params,
          }),
          type: "thread.token-usage.updated",
          payload: {
            usage,
          },
        });
        return;
      }

      const turnId = context.activeTurn?.id;
      if (!turnId) {
        return;
      }

      if (updateKind === "tool_call" || updateKind === "tool_call_update") {
        completeActiveContentItems(context, turnId, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        syncCursorToolCall(context, turnId, update, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        return;
      }

      const text = extractCursorStreamText(update);
      if (!text) {
        return;
      }

      if (updateKind.toLowerCase().includes("plan")) {
        completeActiveContentItems(context, turnId, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        emit({
          ...baseEvent(context, { turnId, rawMethod: "session/update", rawPayload: params }),
          type: "turn.proposed.delta",
          payload: { delta: text },
        });
        return;
      }

      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return;
      }

      const streamKind = streamKindFromUpdateKind(updateKind);
      const itemStateInput = { rawMethod: "session/update", rawPayload: params } as const;
      let itemId: RuntimeItemId | undefined;
      if (streamKind === "assistant_text") {
        completeContentItem(context, turnId, "reasoning", itemStateInput);
        const assistantItem = ensureContentItem(context, turnId, "assistant", itemStateInput);
        if (!assistantItem) {
          return;
        }
        assistantItem.text += text;
        itemId = assistantItem.itemId;
        activeTurn.assistantText += text;
      } else if (streamKind === "reasoning_text" || streamKind === "reasoning_summary_text") {
        completeContentItem(context, turnId, "assistant", itemStateInput);
        const reasoningItem = ensureContentItem(context, turnId, "reasoning", itemStateInput);
        if (!reasoningItem) {
          return;
        }
        reasoningItem.text += text;
        itemId = reasoningItem.itemId;
        activeTurn.reasoningText += text;
      } else {
        completeActiveContentItems(context, turnId, itemStateInput);
      }
      activeTurn.items.push({ kind: streamKind, text, ...(itemId ? { itemId } : {}) });
      emit({
        ...baseEvent(context, {
          turnId,
          ...(itemId ? { itemId } : {}),
          rawMethod: "session/update",
          rawPayload: params,
        }),
        type: "content.delta",
        payload: {
          streamKind,
          delta: text,
        },
      });
    };

    const handleRequest = (
      context: CursorSessionContext,
      request: {
        readonly id: CursorAcpJsonRpcId;
        readonly method: string;
        readonly params?: unknown;
      },
    ) => {
      const turnId = context.activeTurn?.id;

      if (request.method === "session/request_permission") {
        const params = asObject(request.params);
        const toolCall = asObject(params?.toolCall);
        if (toolCall && turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        if (toolCall && turnId) {
          syncCursorToolCall(context, turnId, toolCall, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const requestType = requestTypeForCursorTool(
          cursorToolLookupInput({
            kind: asString(toolCall?.kind),
            title: asString(toolCall?.title),
          }),
        );
        const permissionOptions = parseCursorPermissionOptions(params?.options);
        if (context.session.runtimeMode === "full-access") {
          const resolution = permissionOptionKindForRuntimeMode(context.session.runtimeMode);
          const selectedOption = selectCursorPermissionOption(
            permissionOptions,
            cursorPermissionKindsForRuntimeMode(context.session.runtimeMode),
          );
          if (selectedOption) {
            context.client.respond(request.id, {
              outcome: {
                outcome: "selected",
                optionId: selectedOption.optionId,
              },
            });
            emit({
              ...baseEvent(context, {
                ...(turnId ? { turnId } : {}),
                rawMethod: request.method,
                rawPayload: request.params,
                rawSource: "cursor.acp.request",
              }),
              type: "request.resolved",
              payload: {
                requestType,
                decision: resolution.decision,
                resolution: {
                  optionId: selectedOption.optionId,
                  kind: selectedOption.kind ?? resolution.primary,
                },
              },
            });
          } else {
            context.client.respond(request.id, {
              outcome: {
                outcome: "cancelled",
              },
            });
          }
          return;
        }

        const requestId = ApprovalRequestId.makeUnsafe(`cursor-permission:${randomUUID()}`);
        context.pendingApprovals.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          requestType,
          options: permissionOptions,
          ...(turnId ? { turnId } : {}),
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "request.opened",
          payload: {
            requestType,
            ...(describePermissionRequest(request.params)
              ? { detail: describePermissionRequest(request.params) }
              : {}),
            ...(request.params !== undefined ? { args: request.params } : {}),
          },
        });
        return;
      }

      if (request.method === "cursor/ask_question") {
        const params = asObject(request.params);
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const questions = Array.isArray(params?.questions) ? params.questions : [];
        const optionIdsByQuestionAndLabel = new Map<string, ReadonlyMap<string, string>>();
        const normalizedQuestions = questions
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .map((entry) => {
            const questionId = asString(entry.id) ?? `question-${randomUUID()}`;
            const options = Array.isArray(entry.options) ? entry.options : [];
            const labelMap = new Map<string, string>();
            const normalizedOptions = options
              .map((option) => asObject(option))
              .filter((option): option is Record<string, unknown> => option !== undefined)
              .map((option) => {
                const optionId = asString(option.id) ?? randomUUID();
                const label = asString(option.label) ?? optionId;
                labelMap.set(label, optionId);
                return {
                  label,
                  description: label,
                };
              });
            optionIdsByQuestionAndLabel.set(questionId, labelMap);
            const normalizedQuestion: {
              id: string;
              header: string;
              question: string;
              options: Array<{ label: string; description: string }>;
              multiSelect?: true;
            } = {
              id: questionId,
              header: asString(params?.title) ?? "Need input",
              question: asString(entry.prompt) ?? "Choose an option",
              options: normalizedOptions,
            };
            if (entry.allowMultiple === true) {
              normalizedQuestion.multiSelect = true;
            }
            return normalizedQuestion;
          });
        const requestId = ApprovalRequestId.makeUnsafe(`cursor-question:${randomUUID()}`);
        context.pendingUserInputs.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          ...(turnId ? { turnId } : {}),
          kind: "ask-question",
          optionIdsByQuestionAndLabel,
          questions: normalizedQuestions,
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "user-input.requested",
          payload: {
            questions: normalizedQuestions,
          },
        });
        return;
      }

      if (request.method === "cursor/create_plan") {
        const params = asObject(request.params);
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const requestId = ApprovalRequestId.makeUnsafe(`cursor-plan:${randomUUID()}`);
        const questionId = "plan_decision";
        const questions: ReadonlyArray<UserInputQuestion> = [
          {
            id: questionId,
            header: asString(params?.name) ?? "Plan approval",
            question: asString(params?.overview) ?? "Approve the proposed plan?",
            options: [
              { label: "Accept", description: "Approve the proposed plan" },
              { label: "Reject", description: "Reject the proposed plan" },
              { label: "Cancel", description: "Cancel plan approval" },
            ],
          },
        ];
        context.pendingUserInputs.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          ...(turnId ? { turnId } : {}),
          kind: "create-plan",
          questions,
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "turn.plan.updated",
          payload: {
            ...(asString(params?.overview) ? { explanation: asString(params?.overview) } : {}),
            plan: planStepsFromTodos(params?.todos),
          },
        });
        if (asString(params?.plan)) {
          emit({
            ...baseEvent(context, {
              ...(turnId ? { turnId } : {}),
              rawMethod: request.method,
              rawPayload: request.params,
            }),
            type: "turn.proposed.completed",
            payload: {
              planMarkdown: asString(params?.plan) ?? "",
            },
          });
        }
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "user-input.requested",
          payload: {
            questions,
          },
        });
        return;
      }

      context.client.respondError(
        request.id,
        -32601,
        `Unsupported Cursor ACP request: ${request.method}`,
      );
    };

    const handleNotification = (
      context: CursorSessionContext,
      notification: { readonly method: string; readonly params?: unknown },
    ) => {
      if (notification.method === "session/update") {
        handleSessionUpdate(context, notification.params);
        return;
      }

      if (notification.method === "cursor/update_todos") {
        const params = asObject(notification.params);
        if (context.activeTurn?.id) {
          completeActiveContentItems(context, context.activeTurn.id, {
            rawMethod: notification.method,
            rawPayload: notification.params,
          });
        }
        emit({
          ...baseEvent(context, {
            ...(context.activeTurn?.id ? { turnId: context.activeTurn.id } : {}),
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "turn.plan.updated",
          payload: {
            plan: planStepsFromTodos(params?.todos),
          },
        });
        return;
      }

      if (notification.method === "cursor/task") {
        const params = asObject(notification.params);
        const turnId = context.activeTurn?.id;
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: notification.method,
            rawPayload: notification.params,
          });
        }
        const subagentType = cursorTaskSubagentType(params?.subagentType);
        const itemType = classifyCursorToolItemType(
          cursorToolLookupInput({
            title: asString(params?.description),
            subagentType,
          }),
        );
        const prompt = asString(params?.prompt);
        const itemId = RuntimeItemId.makeUnsafe(
          asString(params?.agentId) ?? `cursor-task:${randomUUID()}`,
        );
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            itemId,
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "item.completed",
          payload: {
            itemType,
            status: "completed",
            title: asString(params?.description) ?? defaultCursorToolTitle(itemType),
            ...(prompt ? { detail: prompt } : {}),
            data: {
              ...(subagentType ? { subagentType } : {}),
              ...(prompt ? { prompt } : {}),
              ...(asString(params?.model) ? { model: asString(params?.model) } : {}),
              ...(asString(params?.agentId) ? { agentId: asString(params?.agentId) } : {}),
              ...(typeof params?.durationMs === "number" ? { durationMs: params.durationMs } : {}),
            },
          },
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(
              asString(params?.agentId) ?? `cursor-task:${randomUUID()}`,
            ),
            status: "completed",
            ...(asString(params?.description) ? { summary: asString(params?.description) } : {}),
            ...(params && "durationMs" in params
              ? { usage: { durationMs: params.durationMs } }
              : {}),
          },
        });
      }
    };

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing) {
            return existing.startPromise ? await existing.startPromise : existing.session;
          }
          const settings = await runPromise(settingsService.getSettings);
          const selectedModel = resolveSelectedModel(input.modelSelection);

          const client = startCursorAcpClient({
            binaryPath: settings.providers.cursor.binaryPath,
          });
          const createdAt = isoNow();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            model: selectedModel,
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          };
          const context: CursorSessionContext = {
            session,
            client,
            metadata: EMPTY_CURSOR_SESSION_METADATA,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            turns: [],
            replayTurns: cloneReplayTurns(input.replayTurns),
            activeTurn: undefined,
            pendingBootstrapReset: false,
            stopping: false,
            startPromise: undefined,
          };
          const startPromise = (async () => {
            try {
              client.setProtocolErrorHandler((error) => {
                emit({
                  ...baseEvent(context),
                  type: "runtime.error",
                  payload: {
                    message: error.message,
                    class: "transport_error",
                  },
                });
              });
              client.setNotificationHandler((notification) =>
                handleNotification(context, notification),
              );
              client.setRequestHandler((request) => handleRequest(context, request));
              client.setCloseHandler(({ code, signal }) => {
                const activeContext = sessions.get(input.threadId);
                if (!activeContext) {
                  return;
                }
                sessions.delete(input.threadId);
                if (activeContext.activeTurn) {
                  settleTurn(activeContext, activeContext.activeTurn.id, {
                    type: "completed",
                    errorMessage: `Cursor ACP exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
                  });
                }
                updateSession(activeContext, { status: "closed", activeTurnId: undefined });
                emit({
                  ...baseEvent(activeContext),
                  type: "session.exited",
                  payload: {
                    reason: activeContext.stopping
                      ? "Cursor session stopped"
                      : `Cursor ACP exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
                    exitKind: activeContext.stopping ? "graceful" : "error",
                  },
                });
              });

              emit({
                ...baseEvent(context),
                type: "session.state.changed",
                payload: {
                  state: "starting",
                  reason: "Starting Cursor ACP session",
                },
              });

              const initialized = parseCursorInitializeState(
                await client.request(
                  "initialize",
                  {
                    protocolVersion: 1,
                    clientCapabilities: {
                      fs: { readTextFile: false, writeTextFile: false },
                      terminal: false,
                    },
                    clientInfo: {
                      name: "t3code",
                      version: "0.0.0",
                    },
                  },
                  { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
                ),
              );
              updateMetadata(context, {
                initialize: initialized,
              });
              const authMethodId =
                initialized.authMethods.find((method) => method.id === "cursor_login")?.id ??
                initialized.authMethods[0]?.id;
              if (authMethodId) {
                await client.request(
                  "authenticate",
                  { methodId: authMethodId },
                  { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
                );
              }

              const resumeSessionId = readResumeSessionId(input.resumeCursor);
              const canLoadSession =
                resumeSessionId !== undefined &&
                context.metadata.initialize.agentCapabilities.loadSession;
              const newSessionParams = {
                cwd: input.cwd ?? serverConfig.cwd,
                mcpServers: [],
              };
              let sessionMethod: "session/load" | "session/new" = canLoadSession
                ? "session/load"
                : "session/new";
              let sessionResult: Record<string, unknown> | undefined;

              if (canLoadSession) {
                try {
                  sessionResult = asObject(
                    await client.request(
                      "session/load",
                      {
                        ...newSessionParams,
                        sessionId: resumeSessionId,
                      },
                      { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
                    ),
                  );
                } catch (cause) {
                  if (!isMissingCursorSessionError(cause)) {
                    throw cause;
                  }
                  sessionMethod = "session/new";
                  sessionResult = asObject(
                    await client.request("session/new", newSessionParams, {
                      timeoutMs: ACP_CONTROL_TIMEOUT_MS,
                    }),
                  );
                }
              } else {
                sessionResult = asObject(
                  await client.request("session/new", newSessionParams, {
                    timeoutMs: ACP_CONTROL_TIMEOUT_MS,
                  }),
                );
              }
              const sessionId =
                asString(sessionResult?.sessionId) ??
                (sessionMethod === "session/load" ? resumeSessionId : undefined);
              if (!sessionId) {
                throw new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: sessionMethod,
                  detail: "Cursor ACP did not return a session id.",
                });
              }
              context.pendingBootstrapReset =
                context.replayTurns.length > 0 && sessionMethod === "session/new";

              updateSession(context, {
                status: "ready",
                ...((input.cwd ?? serverConfig.cwd) ? { cwd: input.cwd ?? serverConfig.cwd } : {}),
                model: selectedModel,
                resumeCursor: {
                  sessionId,
                } satisfies CursorResumeCursor,
              });
              updateMetadata(context, {
                configOptions: parseCursorConfigOptions(sessionResult?.configOptions),
                modes: parseCursorSessionModeState(sessionResult?.modes),
                models: parseCursorSessionModelState(sessionResult?.models),
              });
              if (input.modelSelection?.provider === PROVIDER) {
                await syncCursorModelSelection(context, input.modelSelection);
              }
              emitSessionConfigured(context, {
                rawMethod: sessionMethod,
                rawPayload: sessionResult,
                rawSource: "cursor.acp.request",
              });

              emit({
                ...baseEvent(context),
                type: "session.started",
                payload: {
                  resume: context.session.resumeCursor,
                },
              });
              emit({
                ...baseEvent(context),
                type: "session.state.changed",
                payload: {
                  state: "ready",
                },
              });
              emit({
                ...baseEvent(context),
                type: "thread.started",
                payload: {
                  providerThreadId: sessionId,
                },
              });

              return context.session;
            } catch (cause) {
              context.stopping = true;
              sessions.delete(input.threadId);
              context.client.child.kill("SIGTERM");
              throw cause;
            } finally {
              context.startPromise = undefined;
            }
          })();
          context.startPromise = startPromise;
          sessions.set(input.threadId, context);
          return await startPromise;
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterValidationError(known) ||
            isProviderAdapterProcessError(known) ||
            isProviderAdapterRequestError(known)
            ? known
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(input.threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          if (context.startPromise) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "Cursor session is still starting.",
            });
          }
          if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
            });
          }
          if (context.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "Cursor session already has an active turn.",
            });
          }

          const sessionId = requireCursorSessionId(context, "session/prompt");
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
          const prompt = await runPromise(buildCursorPromptContent(context, promptInput));
          if (input.modelSelection?.provider === PROVIDER) {
            await syncCursorModelSelection(context, input.modelSelection);
          }
          await syncCursorInteractionMode(context, input.interactionMode);

          const turnId = TurnId.makeUnsafe(`cursor-turn:${randomUUID()}`);
          const selectedModel = resolveSelectedModel(input.modelSelection);
          const activeTurn: TurnSnapshot = {
            id: turnId,
            startedAtMs: Date.now(),
            inputText: input.input ?? "",
            attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
            items: [],
            assistantText: "",
            interruptRequested: false,
            reasoningText: "",
            assistantItem: undefined,
            reasoningItem: undefined,
            toolCalls: new Map(),
          };
          context.activeTurn = activeTurn;
          updateSession(context, {
            status: "running",
            activeTurnId: turnId,
            model: selectedModel,
          });
          emit({
            ...baseEvent(context, { turnId }),
            type: "turn.started",
            payload: {
              model: selectedModel,
              ...(input.interactionMode === "plan" ? { effort: "plan" } : {}),
            },
          });

          void context.client
            .request("session/prompt", {
              sessionId,
              prompt,
            })
            .then((result) => {
              context.pendingBootstrapReset = false;
              const record = asObject(result);
              const stopReason = asString(record?.stopReason) ?? null;
              if (
                context.activeTurn?.id === turnId &&
                (context.activeTurn.interruptRequested || stopReason === "cancelled")
              ) {
                settleTurn(context, turnId, {
                  type: "aborted",
                  reason: "Turn cancelled",
                });
                return;
              }
              settleTurn(context, turnId, {
                type: "completed",
                stopReason,
                usage: result,
              });
            })
            .catch((error) => {
              emit({
                ...baseEvent(context, { turnId }),
                type: "runtime.error",
                payload: {
                  message: error instanceof Error ? error.message : String(error),
                  class: "provider_error",
                },
              });
              if (context.activeTurn?.id === turnId && context.activeTurn.interruptRequested) {
                settleTurn(context, turnId, {
                  type: "aborted",
                  reason: "Turn cancelled",
                });
                return;
              }
              settleTurn(context, turnId, {
                type: "completed",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
            });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterSessionNotFoundError(known) ||
            isProviderAdapterValidationError(known) ||
            isProviderAdapterRequestError(known)
            ? known
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId, turnId) =>
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
          const sessionId = requireCursorSessionId(context, "session/cancel");
          context.client.notify("session/cancel", { sessionId });
          context.activeTurn.interruptRequested = true;
          cancelPendingApprovalsForTurn(context, activeTurnId, {
            rawMethod: "session/cancel",
            rawPayload: { sessionId },
          });
          cancelPendingUserInputsForTurn(context, activeTurnId, {
            rawMethod: "session/cancel",
            rawPayload: { sessionId },
          });
          settleTurn(context, activeTurnId, {
            type: "aborted",
            reason: "Turn cancelled",
          });
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterSessionNotFoundError(known) ||
            isProviderAdapterRequestError(known)
            ? known
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/cancel",
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const pending = context.pendingApprovals.get(requestId);
          if (!pending) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/request_permission",
              detail: `Unknown pending approval request '${requestId}'.`,
            });
          }
          context.pendingApprovals.delete(requestId);
          const selectedOption = selectCursorPermissionOption(
            pending.options,
            cursorPermissionKindsForDecision(decision),
          );
          if (selectedOption) {
            context.client.respond(pending.jsonRpcId, {
              outcome: {
                outcome: "selected",
                optionId: selectedOption.optionId,
              },
            });
          } else {
            context.client.respond(pending.jsonRpcId, {
              outcome: {
                outcome: "cancelled",
              },
            });
          }
          emit({
            ...baseEvent(context, {
              ...(pending.turnId ? { turnId: pending.turnId } : {}),
              requestId,
            }),
            type: "request.resolved",
            payload: {
              requestType: pending.requestType,
              decision,
              resolution: {
                ...(selectedOption ? { optionId: selectedOption.optionId } : {}),
                ...(selectedOption?.kind ? { kind: selectedOption.kind } : {}),
                ...(!selectedOption ? { outcome: "cancelled" } : {}),
              },
            },
          });
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterSessionNotFoundError(known) ||
            isProviderAdapterRequestError(known)
            ? known
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/request_permission",
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const pending = context.pendingUserInputs.get(requestId);
          if (!pending) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cursor/ask_question",
              detail: `Unknown pending user-input request '${requestId}'.`,
            });
          }

          context.pendingUserInputs.delete(requestId);

          if (pending.kind === "ask-question") {
            const selectedAnswers = pending.questions.map((question) => {
              const answer = answers[question.id];
              const labels =
                typeof answer === "string"
                  ? [answer]
                  : Array.isArray(answer)
                    ? answer.filter((entry): entry is string => typeof entry === "string")
                    : [];
              const optionIdsByLabel = pending.optionIdsByQuestionAndLabel.get(question.id);
              return {
                questionId: question.id,
                selectedOptionIds: [
                  ...new Set(
                    labels
                      .map((label) => optionIdsByLabel?.get(label))
                      .filter((optionId): optionId is string => typeof optionId === "string"),
                  ),
                ],
              };
            });
            context.client.respond(pending.jsonRpcId, {
              outcome: {
                outcome: "answered",
                answers: selectedAnswers,
              },
            });
          } else {
            const answer =
              typeof answers.plan_decision === "string" ? answers.plan_decision : "Cancel";
            context.client.respond(pending.jsonRpcId, {
              outcome:
                answer === "Accept"
                  ? { outcome: "accepted" }
                  : answer === "Reject"
                    ? { outcome: "rejected", reason: "Rejected in T3 Code" }
                    : { outcome: "cancelled" },
            });
          }

          emit({
            ...baseEvent(context, {
              ...(pending.turnId ? { turnId: pending.turnId } : {}),
              requestId,
            }),
            type: "user-input.resolved",
            payload: {
              answers,
            },
          });
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterSessionNotFoundError(known) ||
            isProviderAdapterRequestError(known)
            ? known
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToUserInput",
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const context = sessions.get(threadId);
          if (!context) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          context.stopping = true;
          await context.client.close();
          sessions.delete(threadId);
        },
        catch: (cause) => {
          const known = findKnownCursorAdapterError(cause);
          return isProviderAdapterSessionNotFoundError(known) ||
            isProviderAdapterProcessError(known)
            ? known
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: describeCursorAdapterCause(cause),
              });
        },
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => context.session));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
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

    const rollbackThread: CursorAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
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
            detail: "Cursor cannot roll back while a turn is still running.",
          });
        }

        const nextLength = Math.max(0, context.turns.length - numTurns);
        const trimmedTurns = context.turns.slice(0, nextLength).map((turn) => ({
          id: turn.id,
          startedAtMs: turn.startedAtMs,
          inputText: turn.inputText,
          attachmentNames: [...turn.attachmentNames],
          items: [...turn.items],
          assistantText: turn.assistantText,
          interruptRequested: turn.interruptRequested,
          reasoningText: turn.reasoningText,
          assistantItem: turn.assistantItem,
          reasoningItem: turn.reasoningItem,
          toolCalls: new Map(turn.toolCalls),
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
        yield* startSession(restartInput);

        const restarted = sessions.get(threadId);
        if (!restarted) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "Cursor rollback failed to recreate the session.",
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

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.promise(() =>
        Promise.all(
          Array.from(sessions.entries()).map(async ([threadId, context]) => {
            context.stopping = true;
            sessions.delete(threadId);
            await context.client.close();
          }),
        ).then(() => undefined),
      );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },
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
      get streamEvents() {
        return Stream.fromPubSub(eventsPubSub);
      },
    } satisfies CursorAdapterShape;
  }),
);

export function makeCursorAdapterLive() {
  return CursorAdapterLive;
}

export {
  buildCursorUsageSnapshot,
  buildCursorTurnUsageSnapshot,
} from "./CursorAdapterUsageParsing.ts";
export {
  classifyCursorToolItemType,
  describePermissionRequest,
  extractCursorStreamText,
  permissionOptionKindForRuntimeMode,
  requestTypeForCursorTool,
  runtimeItemStatusFromCursorStatus,
  streamKindFromUpdateKind,
} from "./CursorAdapterToolHelpers.ts";
