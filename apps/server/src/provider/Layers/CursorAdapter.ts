import { randomUUID } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CursorModelOptions,
  EventId,
  type ProviderSendTurnInput,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeContentStreamKind,
  type RuntimeItemStatus,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, PubSub, Schema, Stream } from "effect";

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
import { resolveCursorCliModelId } from "./CursorProvider.ts";

const PROVIDER = "cursor" as const;
const ACP_CONTROL_TIMEOUT_MS = 15_000;

type CursorResumeCursor = {
  readonly sessionId: string;
};

type CursorPromptCapabilities = {
  readonly image: boolean;
  readonly audio: boolean;
  readonly embeddedContext: boolean;
};

type CursorPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

type CursorPermissionOption = {
  readonly optionId: string;
  readonly kind?: CursorPermissionOptionKind;
  readonly name?: string;
};

type CursorAuthMethod = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

type CursorInitializeState = {
  readonly protocolVersion?: number;
  readonly agentCapabilities: {
    readonly loadSession: boolean;
    readonly promptCapabilities: CursorPromptCapabilities;
  };
  readonly authMethods: ReadonlyArray<CursorAuthMethod>;
};

type CursorSessionModeDefinition = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
};

type CursorSessionModeState = {
  readonly currentModeId?: string;
  readonly availableModes: ReadonlyArray<CursorSessionModeDefinition>;
};

type CursorSessionModelDefinition = {
  readonly modelId: string;
  readonly name?: string;
};

type CursorSessionModelState = {
  readonly currentModelId?: string;
  readonly availableModels: ReadonlyArray<CursorSessionModelDefinition>;
};

type CursorSessionConfigOptionValue = {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
};

type CursorSessionConfigOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly currentValue: string;
  readonly options: ReadonlyArray<CursorSessionConfigOptionValue>;
};

type CursorAvailableCommand = {
  readonly name: string;
  readonly description?: string;
};

type CursorSessionMetadata = {
  readonly initialize: CursorInitializeState;
  readonly configOptions: ReadonlyArray<CursorSessionConfigOption>;
  readonly modes?: CursorSessionModeState;
  readonly models?: CursorSessionModelState;
  readonly availableCommands: ReadonlyArray<CursorAvailableCommand>;
  readonly defaultModeId?: string;
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
  activeTurn: TurnSnapshot | undefined;
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

const EMPTY_CURSOR_PROMPT_CAPABILITIES: CursorPromptCapabilities = {
  image: false,
  audio: false,
  embeddedContext: false,
};

const EMPTY_CURSOR_INITIALIZE_STATE: CursorInitializeState = {
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: EMPTY_CURSOR_PROMPT_CAPABILITIES,
  },
  authMethods: [],
};

const EMPTY_CURSOR_SESSION_METADATA: CursorSessionMetadata = {
  initialize: EMPTY_CURSOR_INITIALIZE_STATE,
  configOptions: [],
  availableCommands: [],
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStreamText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCursorPromptCapabilities(value: unknown): CursorPromptCapabilities {
  const record = asObject(value);
  return {
    image: record?.image === true,
    audio: record?.audio === true,
    embeddedContext: record?.embeddedContext === true,
  };
}

function parseCursorAuthMethods(value: unknown): ReadonlyArray<CursorAuthMethod> {
  const methods = asArray(value);
  if (!methods) {
    return [];
  }
  const parsed: Array<CursorAuthMethod> = [];
  for (const method of methods) {
    const entry = asObject(method);
    if (!entry) {
      continue;
    }
    const id = asString(entry.id);
    if (!id) {
      continue;
    }
    const normalized: { id: string; name?: string; description?: string } = { id };
    const name = asString(entry.name);
    if (name) {
      normalized.name = name;
    }
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function parseCursorInitializeState(value: unknown): CursorInitializeState {
  const record = asObject(value);
  const agentCapabilities = asObject(record?.agentCapabilities);
  return {
    ...(typeof record?.protocolVersion === "number"
      ? { protocolVersion: record.protocolVersion }
      : {}),
    agentCapabilities: {
      loadSession: agentCapabilities?.loadSession === true,
      promptCapabilities: parseCursorPromptCapabilities(agentCapabilities?.promptCapabilities),
    },
    authMethods: parseCursorAuthMethods(record?.authMethods),
  };
}

function parseCursorSessionModeState(value: unknown): CursorSessionModeState | undefined {
  const record = asObject(value);
  const availableModesRaw = asArray(record?.availableModes);
  const availableModes: Array<CursorSessionModeDefinition> = [];
  if (availableModesRaw) {
    for (const mode of availableModesRaw) {
      const entry = asObject(mode);
      if (!entry) {
        continue;
      }
      const id = asString(entry.id);
      if (!id) {
        continue;
      }
      const normalized: { id: string; name?: string; description?: string } = { id };
      const name = asString(entry.name);
      if (name) {
        normalized.name = name;
      }
      const description = asString(entry.description);
      if (description) {
        normalized.description = description;
      }
      availableModes.push(normalized);
    }
  }
  const currentModeId = asString(record?.currentModeId);
  if (!currentModeId && availableModes.length === 0) {
    return undefined;
  }
  return {
    ...(currentModeId ? { currentModeId } : {}),
    availableModes,
  };
}

function parseCursorSessionModelState(value: unknown): CursorSessionModelState | undefined {
  const record = asObject(value);
  const availableModelsRaw = asArray(record?.availableModels);
  const availableModels: Array<CursorSessionModelDefinition> = [];
  if (availableModelsRaw) {
    for (const model of availableModelsRaw) {
      const entry = asObject(model);
      if (!entry) {
        continue;
      }
      const modelId = asString(entry.modelId);
      if (!modelId) {
        continue;
      }
      const normalized: { modelId: string; name?: string } = { modelId };
      const name = asString(entry.name);
      if (name) {
        normalized.name = name;
      }
      availableModels.push(normalized);
    }
  }
  const currentModelId = asString(record?.currentModelId);
  if (!currentModelId && availableModels.length === 0) {
    return undefined;
  }
  return {
    ...(currentModelId ? { currentModelId } : {}),
    availableModels,
  };
}

function parseCursorConfigOptionValues(
  value: unknown,
): ReadonlyArray<CursorSessionConfigOptionValue> {
  const options = asArray(value);
  if (!options) {
    return [];
  }
  const parsed: Array<CursorSessionConfigOptionValue> = [];
  for (const option of options) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const optionValue = asString(entry.value);
    const name = asString(entry.name) ?? optionValue;
    if (!optionValue || !name) {
      continue;
    }
    const normalized: { value: string; name: string; description?: string } = {
      value: optionValue,
      name,
    };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function parseCursorConfigOptions(value: unknown): ReadonlyArray<CursorSessionConfigOption> {
  const configOptions = asArray(value);
  if (!configOptions) {
    return [];
  }
  const parsed: Array<CursorSessionConfigOption> = [];
  for (const option of configOptions) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const id = asString(entry.id);
    const name = asString(entry.name);
    const currentValue = asString(entry.currentValue);
    if (!id || !name || !currentValue) {
      continue;
    }
    const normalized: {
      id: string;
      name: string;
      currentValue: string;
      options: ReadonlyArray<CursorSessionConfigOptionValue>;
      description?: string;
      category?: string;
    } = {
      id,
      name,
      currentValue,
      options: parseCursorConfigOptionValues(entry.options),
    };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    const category = asString(entry.category);
    if (category) {
      normalized.category = category;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function parseCursorAvailableCommands(value: unknown): ReadonlyArray<CursorAvailableCommand> {
  const commands = asArray(value);
  if (!commands) {
    return [];
  }
  const parsed: Array<CursorAvailableCommand> = [];
  for (const command of commands) {
    const entry = asObject(command);
    if (!entry) {
      continue;
    }
    const name = asString(entry.name);
    if (!name) {
      continue;
    }
    const normalized: { name: string; description?: string } = { name };
    const description = asString(entry.description);
    if (description) {
      normalized.description = description;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function findCursorConfigOption(
  configOptions: ReadonlyArray<CursorSessionConfigOption>,
  input: { readonly category?: string; readonly id?: string },
): CursorSessionConfigOption | undefined {
  const normalizedCategory = input.category?.trim().toLowerCase();
  const normalizedId = input.id?.trim().toLowerCase();
  return configOptions.find((option) => {
    if (normalizedCategory && option.category?.trim().toLowerCase() === normalizedCategory) {
      return true;
    }
    return normalizedId !== undefined && option.id.trim().toLowerCase() === normalizedId;
  });
}

function replaceCursorConfigOptionCurrentValue(
  configOptions: ReadonlyArray<CursorSessionConfigOption>,
  optionId: string | undefined,
  currentValue: string | undefined,
): ReadonlyArray<CursorSessionConfigOption> {
  if (!optionId || !currentValue) {
    return configOptions;
  }
  return configOptions.map((option) =>
    option.id === optionId && option.currentValue !== currentValue
      ? { ...option, currentValue }
      : option,
  );
}

function cursorModeStateFromConfigOption(
  option: CursorSessionConfigOption | undefined,
): CursorSessionModeState | undefined {
  if (!option) {
    return undefined;
  }
  return {
    currentModeId: option.currentValue,
    availableModes: option.options.map((entry) => ({
      id: entry.value,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
    })),
  };
}

function cursorModelStateFromConfigOption(
  option: CursorSessionConfigOption | undefined,
): CursorSessionModelState | undefined {
  if (!option) {
    return undefined;
  }
  return {
    currentModelId: option.currentValue,
    availableModels: option.options.map((entry) => ({
      modelId: entry.value,
      name: entry.name,
    })),
  };
}

function mergeCursorModeStates(
  primary: CursorSessionModeState | undefined,
  secondary: CursorSessionModeState | undefined,
): CursorSessionModeState | undefined {
  const currentModeId = primary?.currentModeId ?? secondary?.currentModeId;
  const availableModes =
    primary?.availableModes && primary.availableModes.length > 0
      ? primary.availableModes
      : (secondary?.availableModes ?? []);
  if (!currentModeId && availableModes.length === 0) {
    return undefined;
  }
  return {
    ...(currentModeId ? { currentModeId } : {}),
    availableModes,
  };
}

function mergeCursorModelStates(
  primary: CursorSessionModelState | undefined,
  secondary: CursorSessionModelState | undefined,
): CursorSessionModelState | undefined {
  const currentModelId = primary?.currentModelId ?? secondary?.currentModelId;
  const availableModels =
    primary?.availableModels && primary.availableModels.length > 0
      ? primary.availableModels
      : (secondary?.availableModels ?? []);
  if (!currentModelId && availableModels.length === 0) {
    return undefined;
  }
  return {
    ...(currentModelId ? { currentModelId } : {}),
    availableModels,
  };
}

function buildCursorSessionMetadata(input: {
  readonly previous?: CursorSessionMetadata | undefined;
  readonly initialize?: CursorInitializeState | undefined;
  readonly configOptions?: ReadonlyArray<CursorSessionConfigOption> | undefined;
  readonly modes?: CursorSessionModeState | undefined;
  readonly models?: CursorSessionModelState | undefined;
  readonly availableCommands?: ReadonlyArray<CursorAvailableCommand> | undefined;
  readonly currentModeId?: string | undefined;
  readonly currentModelId?: string | undefined;
}): CursorSessionMetadata {
  const previous = input.previous ?? EMPTY_CURSOR_SESSION_METADATA;
  let configOptions = input.configOptions ?? previous.configOptions;
  const requestedModeOption = findCursorConfigOption(configOptions, {
    category: "mode",
    id: "mode",
  });
  configOptions = replaceCursorConfigOptionCurrentValue(
    configOptions,
    requestedModeOption?.id,
    input.currentModeId,
  );
  const requestedModelOption = findCursorConfigOption(configOptions, {
    category: "model",
    id: "model",
  });
  configOptions = replaceCursorConfigOptionCurrentValue(
    configOptions,
    requestedModelOption?.id,
    input.currentModelId,
  );
  const modeConfigState = cursorModeStateFromConfigOption(
    findCursorConfigOption(configOptions, { category: "mode", id: "mode" }),
  );
  const modelConfigState = cursorModelStateFromConfigOption(
    findCursorConfigOption(configOptions, { category: "model", id: "model" }),
  );
  const explicitModes = input.modes ?? previous.modes;
  const explicitModels = input.models ?? previous.models;
  let modes =
    input.configOptions !== undefined
      ? mergeCursorModeStates(modeConfigState, explicitModes)
      : mergeCursorModeStates(explicitModes, modeConfigState);
  let models =
    input.configOptions !== undefined
      ? mergeCursorModelStates(modelConfigState, explicitModels)
      : mergeCursorModelStates(explicitModels, modelConfigState);
  if (input.currentModeId) {
    modes = {
      currentModeId: input.currentModeId,
      availableModes: modes?.availableModes ?? [],
    };
  }
  if (input.currentModelId) {
    models = {
      currentModelId: input.currentModelId,
      availableModels: models?.availableModels ?? [],
    };
  }
  const currentModeId = modes?.currentModeId;
  const defaultModeId =
    (input.currentModeId && input.currentModeId !== "plan" ? input.currentModeId : undefined) ??
    (currentModeId && currentModeId !== "plan" ? currentModeId : undefined) ??
    previous.defaultModeId ??
    currentModeId;
  return {
    initialize: input.initialize ?? previous.initialize,
    configOptions,
    ...(modes ? { modes } : {}),
    ...(models ? { models } : {}),
    availableCommands: input.availableCommands ?? previous.availableCommands,
    ...(defaultModeId ? { defaultModeId } : {}),
  };
}

function cursorSessionMetadataSnapshot(metadata: CursorSessionMetadata): Record<string, unknown> {
  return {
    initialize: metadata.initialize,
    configOptions: metadata.configOptions,
    ...(metadata.modes ? { modes: metadata.modes } : {}),
    ...(metadata.models ? { models: metadata.models } : {}),
    ...(metadata.availableCommands.length > 0
      ? { availableCommands: metadata.availableCommands }
      : {}),
    ...(metadata.defaultModeId ? { defaultModeId: metadata.defaultModeId } : {}),
  };
}

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);

function nextCause(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || !("cause" in value)) {
    return undefined;
  }
  const cause = (value as { readonly cause?: unknown }).cause;
  return cause === value ? undefined : cause;
}

function causeChain(cause: unknown): ReadonlyArray<unknown> {
  const chain: Array<unknown> = [];
  let current: unknown = cause;
  let depth = 0;
  while (current !== undefined && depth < 8) {
    chain.push(current);
    current = nextCause(current);
    depth += 1;
  }
  return chain;
}

function findKnownCursorAdapterError(
  cause: unknown,
):
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError
  | undefined {
  for (const candidate of causeChain(cause)) {
    if (
      isProviderAdapterValidationError(candidate) ||
      isProviderAdapterSessionNotFoundError(candidate) ||
      isProviderAdapterRequestError(candidate) ||
      isProviderAdapterProcessError(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function describeCursorAdapterCause(cause: unknown): string {
  for (const candidate of causeChain(cause)) {
    if (!(candidate instanceof Error)) {
      continue;
    }
    if (
      candidate.message !== "An error occurred in Effect.try" &&
      candidate.message !== "An error occurred in Effect.tryPromise"
    ) {
      return candidate.message;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function extractCursorStreamText(
  update: Record<string, unknown> | undefined,
): string | undefined {
  const content = asObject(update?.content);
  return asStreamText(content?.text) ?? asStreamText(update?.text);
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

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function requestIdFromApprovalRequest(requestId: ApprovalRequestId) {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function parseCursorPermissionOptions(value: unknown): ReadonlyArray<CursorPermissionOption> {
  const options = asArray(value);
  if (!options) {
    return [];
  }
  const parsed: Array<CursorPermissionOption> = [];
  for (const option of options) {
    const entry = asObject(option);
    if (!entry) {
      continue;
    }
    const optionId = asString(entry.optionId);
    if (!optionId) {
      continue;
    }
    const normalized: {
      optionId: string;
      kind?: CursorPermissionOptionKind;
      name?: string;
    } = { optionId };
    const kind = asString(entry.kind)?.toLowerCase();
    if (
      kind === "allow_once" ||
      kind === "allow_always" ||
      kind === "reject_once" ||
      kind === "reject_always"
    ) {
      normalized.kind = kind;
    }
    const name = asString(entry.name);
    if (name) {
      normalized.name = name;
    }
    parsed.push(normalized);
  }
  return parsed;
}

function cursorPermissionKindsForDecision(
  decision: ProviderApprovalDecision,
): ReadonlyArray<CursorPermissionOptionKind> {
  switch (decision) {
    case "acceptForSession":
      return ["allow_always", "allow_once"];
    case "accept":
      return ["allow_once", "allow_always"];
    case "decline":
    case "cancel":
    default:
      return ["reject_once", "reject_always"];
  }
}

function cursorPermissionKindsForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): ReadonlyArray<CursorPermissionOptionKind> {
  return runtimeMode === "full-access"
    ? ["allow_always", "allow_once"]
    : ["allow_once", "allow_always"];
}

function permissionOptionMatchesKind(
  option: CursorPermissionOption,
  kind: CursorPermissionOptionKind,
): boolean {
  if (option.kind === kind) {
    return true;
  }
  const normalizedOptionId = option.optionId.toLowerCase();
  const normalizedName = option.name?.toLowerCase() ?? "";
  switch (kind) {
    case "allow_once":
      return (
        (normalizedOptionId.includes("allow") || normalizedName.includes("allow")) &&
        (normalizedOptionId.includes("once") || normalizedName.includes("once"))
      );
    case "allow_always":
      return (
        (normalizedOptionId.includes("allow") || normalizedName.includes("allow")) &&
        (normalizedOptionId.includes("always") ||
          normalizedOptionId.includes("session") ||
          normalizedName.includes("always") ||
          normalizedName.includes("session"))
      );
    case "reject_once":
      return (
        normalizedOptionId.includes("reject") ||
        normalizedOptionId.includes("deny") ||
        normalizedName.includes("reject") ||
        normalizedName.includes("deny")
      );
    case "reject_always":
      return (
        (normalizedOptionId.includes("reject") ||
          normalizedOptionId.includes("deny") ||
          normalizedName.includes("reject") ||
          normalizedName.includes("deny")) &&
        (normalizedOptionId.includes("always") ||
          normalizedOptionId.includes("session") ||
          normalizedName.includes("always") ||
          normalizedName.includes("session"))
      );
  }
}

function selectCursorPermissionOption(
  options: ReadonlyArray<CursorPermissionOption>,
  preferredKinds: ReadonlyArray<CursorPermissionOptionKind>,
): CursorPermissionOption | undefined {
  for (const kind of preferredKinds) {
    const matched = options.find((option) => permissionOptionMatchesKind(option, kind));
    if (matched) {
      return matched;
    }
  }
  return options[0];
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1).trim() : trimmed;
}

function looksLikeShellCommand(value: string): boolean {
  const normalized = stripWrappingBackticks(value);
  return (
    normalized.includes(" ") ||
    normalized.includes("/") ||
    normalized.includes("&&") ||
    normalized.includes("||") ||
    normalized.includes("|") ||
    normalized.includes("$") ||
    normalized.includes("=")
  );
}

function defaultCursorToolTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Terminal";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image";
    case "collab_agent_tool_call":
      return "Subagent task";
    default:
      return "Tool call";
  }
}

export function classifyCursorToolItemType(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}): CanonicalItemType {
  const normalized = [input.kind, input.title, input.subagentType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent") ||
    normalized.includes("explore") ||
    normalized.includes("browser_use") ||
    normalized.includes("browser use") ||
    normalized.includes("computer_use") ||
    normalized.includes("computer use") ||
    normalized.includes("video_review") ||
    normalized.includes("video review") ||
    normalized.includes("vm_setup_helper") ||
    normalized.includes("vm setup helper")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("execute") ||
    normalized.includes("terminal") ||
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("url") ||
    normalized.includes("browser")
  ) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): boolean {
  const normalized = [input.kind, input.title]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  return (
    normalized.includes("read") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function requestTypeForCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): CanonicalRequestType {
  if (isReadOnlyCursorTool(input)) {
    return "file_read_approval";
  }
  const itemType = classifyCursorToolItemType(input);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function runtimeItemStatusFromCursorStatus(status: string | undefined): RuntimeItemStatus {
  switch (status?.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "rejected":
    case "declined":
      return "declined";
    default:
      return "inProgress";
  }
}

function isFinalCursorToolStatus(status: RuntimeItemStatus): boolean {
  return status !== "inProgress";
}

function cursorTaskSubagentType(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) {
    return direct;
  }
  const record = asObject(value);
  return asString(record?.custom);
}

function extractCursorToolContentText(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const content = asArray(record?.content);
  if (!content) {
    return undefined;
  }
  for (const entry of content) {
    const contentRecord = asObject(entry);
    const nested = asObject(contentRecord?.content);
    const text = asString(nested?.text) ?? asString(contentRecord?.text);
    if (text) {
      return stripWrappingBackticks(text);
    }
  }
  return undefined;
}

function extractCursorToolCommand(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.command),
    asString(rawInput?.command),
    asString(rawInput?.cmd),
    asString(rawOutput?.command),
  ]) {
    if (candidate) {
      return stripWrappingBackticks(candidate);
    }
  }
  const title = asString(record.title);
  const kind = asString(record.kind);
  if (title && ((kind && kind.toLowerCase().includes("execute")) || looksLikeShellCommand(title))) {
    return stripWrappingBackticks(title);
  }
  return undefined;
}

function extractCursorToolPath(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.filePath),
    asString(record.path),
    asString(record.relativePath),
    asString(rawInput?.filePath),
    asString(rawInput?.path),
    asString(rawOutput?.filePath),
    asString(rawOutput?.path),
  ]) {
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCursorToolTitle(
  itemType: CanonicalItemType,
  rawTitle: string | undefined,
  previousTitle?: string,
): string {
  const titleCandidate = rawTitle ? stripWrappingBackticks(rawTitle) : undefined;
  if (titleCandidate && !looksLikeShellCommand(titleCandidate)) {
    return titleCandidate;
  }
  return previousTitle ?? defaultCursorToolTitle(itemType);
}

function buildCursorToolData(
  existingData: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  const command = extractCursorToolCommand(record);
  const path = extractCursorToolPath(record);
  const previousItem = asObject(existingData?.item);
  return {
    ...existingData,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(rawInput ? { input: rawInput } : {}),
    ...(rawOutput ? { result: rawOutput } : {}),
    item: {
      ...previousItem,
      ...(asString(record.title)
        ? { title: stripWrappingBackticks(asString(record.title) ?? "") }
        : {}),
      ...(asString(record.kind) ? { kind: asString(record.kind) } : {}),
      ...(asString(record.status) ? { status: asString(record.status) } : {}),
      ...(asString(record.toolCallId) ? { toolCallId: asString(record.toolCallId) } : {}),
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(rawInput ? { input: rawInput } : {}),
      ...(rawOutput ? { result: rawOutput } : {}),
    },
  };
}

export function describePermissionRequest(params: unknown): string | undefined {
  const record = asObject(params);
  if (!record) {
    return undefined;
  }

  const toolCall = asObject(record.toolCall);
  if (toolCall) {
    const itemType = classifyCursorToolItemType(
      cursorToolLookupInput({
        kind: asString(toolCall.kind),
        title: asString(toolCall.title),
      }),
    );
    const detail = extractCursorToolCommand(toolCall) ?? extractCursorToolPath(toolCall);
    if (detail) {
      return detail;
    }
    const toolDetail = extractCursorToolContentText(toolCall);
    if (toolDetail) {
      return toolDetail;
    }
    const title = resolveCursorToolTitle(itemType, asString(toolCall.title));
    if (title.length > 0 && title !== defaultCursorToolTitle(itemType)) {
      return title;
    }
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }

  const request = asObject(record.request);
  if (!request) {
    return undefined;
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(request[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function streamKindFromUpdateKind(updateKind: string): RuntimeContentStreamKind {
  const normalized = updateKind.toLowerCase();
  if (normalized.includes("summary")) {
    return "reasoning_summary_text";
  }
  if (
    normalized.includes("reason") ||
    normalized.includes("thought") ||
    normalized.includes("thinking")
  ) {
    return "reasoning_text";
  }
  if (normalized.includes("plan")) {
    return "plan_text";
  }
  return "assistant_text";
}

export function permissionOptionKindForRuntimeMode(runtimeMode: ProviderSession["runtimeMode"]): {
  readonly primary: CursorPermissionOptionKind;
  readonly fallback: CursorPermissionOptionKind;
  readonly decision: ProviderApprovalDecision;
} {
  if (runtimeMode === "full-access") {
    return {
      primary: "allow_always",
      fallback: "allow_once",
      decision: "acceptForSession",
    };
  }

  return {
    primary: "allow_once",
    fallback: "allow_always",
    decision: "accept",
  };
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

type ParsedCursorModelConfigChoice = {
  readonly choice: CursorSessionConfigOptionValue;
  readonly valuePrefix: string;
  readonly tokens: ReadonlySet<string>;
};

function parseCursorModelConfigChoice(
  choice: CursorSessionConfigOptionValue,
): ParsedCursorModelConfigChoice {
  const bracketIndex = choice.value.indexOf("[");
  const valuePrefix = bracketIndex === -1 ? choice.value : choice.value.slice(0, bracketIndex);
  return {
    choice,
    valuePrefix,
    tokens: new Set<string>([
      ...cursorModelTokens(valuePrefix),
      ...cursorModelTokens(choice.value),
      ...cursorModelTokens(choice.name),
    ]),
  };
}

function resolveCursorModelConfigValue(input: {
  readonly model: string;
  readonly options?: CursorModelOptions | null | undefined;
  readonly modelOption: CursorSessionConfigOption;
}): string | undefined {
  const cliModelId = resolveCursorCliModelId({
    model: input.model,
    options: input.options,
  });
  const targetTokens = cursorModelTokens(cliModelId);
  const targetIdentityTokens = cursorModelTokens(input.model);
  let best:
    | {
        readonly value: string;
        readonly score: number;
      }
    | undefined;
  for (const choice of input.modelOption.options) {
    const parsed = parseCursorModelConfigChoice(choice);
    if (parsed.valuePrefix.toLowerCase() === cliModelId.toLowerCase()) {
      return choice.value;
    }
    let score = 0;
    let missingToken = false;
    for (const token of targetTokens) {
      if (!parsed.tokens.has(token)) {
        missingToken = true;
        break;
      }
      score += 10;
    }
    if (missingToken) {
      continue;
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
          }
        | { readonly type: "aborted"; readonly reason: string },
    ) => {
      if (!context.activeTurn || context.activeTurn.id !== turnId) {
        return;
      }

      completeActiveContentItems(context, turnId);
      context.turns.push(context.activeTurn);
      context.activeTurn = undefined;
      updateSession(context, {
        activeTurnId: undefined,
        status: outcome.type === "completed" && outcome.errorMessage ? "error" : "ready",
        ...(outcome.type === "completed" && outcome.errorMessage
          ? { lastError: outcome.errorMessage }
          : {}),
      });

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
          const cursorCliModel = input.modelSelection
            ? resolveCursorCliModelId({
                model: selectedModel,
                options: input.modelSelection.options,
              })
            : selectedModel;

          const client = startCursorAcpClient({
            binaryPath: settings.providers.cursor.binaryPath,
            model: cursorCliModel,
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
            activeTurn: undefined,
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
                      version: "1.0.17",
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
              const sessionMethod = canLoadSession ? "session/load" : "session/new";
              const sessionResult = asObject(
                await client.request(
                  sessionMethod,
                  {
                    cwd: input.cwd ?? serverConfig.cwd,
                    mcpServers: [],
                    ...(canLoadSession ? { sessionId: resumeSessionId } : {}),
                  },
                  { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
                ),
              );
              const sessionId = asString(sessionResult?.sessionId) ?? resumeSessionId;
              if (!sessionId) {
                throw new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: sessionMethod,
                  detail: "Cursor ACP did not return a session id.",
                });
              }

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
          const prompt = await runPromise(buildCursorPromptContent(context, input));
          if (input.modelSelection?.provider === PROVIDER) {
            await syncCursorModelSelection(context, input.modelSelection);
          }
          await syncCursorInteractionMode(context, input.interactionMode);

          const turnId = TurnId.makeUnsafe(`cursor-turn:${randomUUID()}`);
          const selectedModel = resolveSelectedModel(input.modelSelection);
          const activeTurn: TurnSnapshot = {
            id: turnId,
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

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail:
            "Cursor ACP session rollback is not supported by the current adapter implementation.",
        }),
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
