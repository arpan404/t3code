import { randomUUID } from "node:crypto";

import {
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createGitHubCopilotClient,
  type GitHubCopilotClientLike,
  type GitHubCopilotSessionClient,
  normalizeGitHubCopilotModelOptionsForModel,
} from "../githubCopilotSdk";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterShape,
} from "../Services/GitHubCopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "githubCopilot" as const;

type UserInputRequest = {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
};

type UserInputResponse = {
  readonly answer: string;
  readonly wasFreeform: boolean;
};

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly fingerprint?: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
  readonly promise: Promise<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly choices: ReadonlyArray<string>;
  readonly allowFreeform: boolean;
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
  readonly promise: Promise<ProviderUserInputAnswers>;
}

interface ToolItemState {
  readonly itemId: string;
  itemType: CanonicalItemType;
  toolName: string;
  title: string;
  detail?: string;
  data: Record<string, unknown>;
  completed: boolean;
}

interface ToolRequestMetadata {
  readonly toolName: string;
  readonly toolTitle?: string;
  readonly intentionSummary?: string;
  readonly arguments?: Record<string, unknown>;
}

interface TurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantItemIdsByMessageId: Map<string, string>;
  readonly reasoningItemIdsByReasoningId: Map<string, string>;
  toolItems: Map<string, ToolItemState>;
  lastIntentText?: string;
  reasoningOutputSeen: boolean;
  abortRequested: boolean;
}

interface GitHubCopilotSessionContext {
  session: ProviderSession;
  readonly sharedClientKey: string;
  readonly sdkSession: GitHubCopilotSessionClient;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  readonly approvalFingerprints: Set<string>;
  readonly toolRequestMetadata: Map<string, ToolRequestMetadata>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly unsubscribers: Array<() => void>;
  readonly sequenceTieBreakersByTimestampMs: Map<number, number>;
  nextFallbackSessionSequence: number;
  turnState: TurnState | undefined;
  lastKnownTokenUsage?: ThreadTokenUsageSnapshot;
  stopped: boolean;
}

export interface GitHubCopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface SharedClientContext {
  readonly key: string;
  readonly client: GitHubCopilotClientLike;
  refCount: number;
}

function sharedClientKey(input: { readonly binaryPath: string; readonly cliUrl: string }): string {
  return `binary:${input.binaryPath}|cliUrl:${input.cliUrl}`;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function makeDeferredDecision<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function summarizePermissionRequest(request: PermissionRequest): string | undefined {
  if (typeof request.fullCommandText === "string" && request.fullCommandText.trim().length > 0) {
    return request.fullCommandText.trim();
  }
  if (typeof request.fileName === "string" && request.fileName.trim().length > 0) {
    return request.fileName.trim();
  }
  if (typeof request.toolName === "string" && request.toolName.trim().length > 0) {
    return request.toolName.trim();
  }
  if (typeof request.url === "string" && request.url.trim().length > 0) {
    return request.url.trim();
  }
  return undefined;
}

function classifyPermissionRequest(request: PermissionRequest): CanonicalRequestType {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    case "mcp":
    case "custom-tool":
    case "url":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function mapApprovalDecision(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
      return { kind: "denied-interactively-by-user" };
    case "cancel":
    default:
      return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
  }
}

function permissionRequestFingerprint(request: PermissionRequest): string | undefined {
  const detail = summarizePermissionRequest(request);
  if (!detail) {
    return undefined;
  }
  return `${request.kind}:${detail}`;
}

function classifyToolItemType(toolName: string | undefined): CanonicalItemType {
  const normalized = toolName?.toLowerCase() ?? "";
  if (
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("terminal") ||
    normalized === "bash"
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("web") || normalized.includes("search") || normalized.includes("url")) {
    return "web_search";
  }
  if (normalized.includes("image") || normalized.includes("view")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncatePreview(value: string, limit = 240): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractEmbeddedTextValue(value: string, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const match = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "i").exec(value);
    const extracted = stringValue(match?.[1]);
    if (extracted) {
      return truncatePreview(normalizeWhitespace(extracted), 160);
    }
  }
  return undefined;
}

function sanitizeToolDisplayText(value: string | undefined): string | undefined {
  const normalized = value ? normalizeWhitespace(value) : undefined;
  if (!normalized) {
    return undefined;
  }

  const embedded = extractEmbeddedTextValue(normalized, [
    "intent",
    "goal",
    "explanation",
    "summary",
  ]);
  if (embedded) {
    return embedded;
  }

  const payloadBoundary = normalized.indexOf(" - {");
  if (payloadBoundary > 0) {
    return truncatePreview(normalized.slice(0, payloadBoundary).trim(), 160);
  }

  return truncatePreview(normalized, 160);
}

function jsonPreview(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === "{}" || serialized === "[]") {
      return undefined;
    }
    return truncatePreview(serialized);
  } catch {
    return undefined;
  }
}

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function humanizeToolName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const spaced = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.length > 0 ? titleCaseWords(spaced) : undefined;
}

function commandPreviewValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" ? normalizeWhitespace(entry) : ""))
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function shouldSuppressCommandPreview(value: unknown): boolean {
  const rawCommand =
    typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "";
  const normalized = commandPreviewValue(value) ?? "";
  return (
    normalized.length > 160 ||
    /[\r\n]/.test(rawCommand) ||
    /\|\||&&|;/.test(rawCommand) ||
    /\b(?:node|python|ruby)\s+-[ce]\b/.test(rawCommand)
  );
}

function buildToolArgumentsPreview(value: unknown): string | undefined {
  const record = recordValue(value);
  if (!record) {
    return jsonPreview(value);
  }

  const detailParts: string[] = [];
  const pushUnique = (nextValue: string | undefined) => {
    const normalized = nextValue ? truncatePreview(normalizeWhitespace(nextValue)) : undefined;
    if (!normalized || detailParts.includes(normalized)) {
      return;
    }
    detailParts.push(normalized);
  };

  pushUnique(
    sanitizeToolDisplayText(
      stringValue(record.intent) ??
        stringValue(record.goal) ??
        stringValue(record.explanation) ??
        stringValue(record.summary),
    ),
  );
  pushUnique(sanitizeToolDisplayText(stringValue(record.query)));
  pushUnique(sanitizeToolDisplayText(stringValue(record.header)));

  for (const key of [
    "filePath",
    "path",
    "dirPath",
    "cwd",
    "workingDirectory",
    "resourcePath",
  ] as const) {
    pushUnique(stringValue(record[key]));
  }

  const urlList = Array.isArray(record.urls)
    ? record.urls
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  if (urlList.length > 0) {
    pushUnique(urlList.length === 1 ? urlList[0] : `${urlList[0]} +${urlList.length - 1} more`);
  } else {
    pushUnique(stringValue(record.url));
  }

  const packageList = Array.isArray(record.packageList)
    ? record.packageList
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
  if (packageList.length > 0) {
    pushUnique(`Packages: ${packageList.join(", ")}`);
  }

  const commandPreview = commandPreviewValue(record.command);
  if (commandPreview && !shouldSuppressCommandPreview(record.command)) {
    pushUnique(commandPreview);
  }

  return detailParts.length > 0 ? detailParts.join("\n") : jsonPreview(value);
}

function extractToolResultDetail(value: unknown): string | undefined {
  const result = recordValue(value);
  if (!result) {
    return undefined;
  }
  const detailedContent = stringValue(result.detailedContent);
  if (detailedContent) {
    return (
      sanitizeToolDisplayText(truncatePreview(detailedContent)) ?? truncatePreview(detailedContent)
    );
  }
  const content = stringValue(result.content);
  if (content) {
    return sanitizeToolDisplayText(truncatePreview(content)) ?? truncatePreview(content);
  }
  const contents = getObjectProperty(result, "contents");
  if (!Array.isArray(contents)) {
    return undefined;
  }
  for (const entry of contents) {
    const block = recordValue(entry);
    if (!block) {
      continue;
    }
    const text = stringValue(getObjectProperty(block, "text"));
    if (text) {
      return truncatePreview(text);
    }
    const title = stringValue(getObjectProperty(block, "title"));
    const uri = stringValue(getObjectProperty(block, "uri"));
    if (title && uri) {
      return truncatePreview(`${title} (${uri})`);
    }
  }
  return undefined;
}

function buildToolExecutionTitle(input: {
  readonly toolName?: string;
  readonly toolTitle?: string;
  readonly intentionSummary?: string;
  readonly mcpToolName?: string;
}): string {
  return (
    sanitizeToolDisplayText(input.toolTitle) ||
    sanitizeToolDisplayText(input.intentionSummary) ||
    humanizeToolName(input.mcpToolName) ||
    humanizeToolName(input.toolName) ||
    "Tool"
  );
}

function buildToolExecutionDetail(input: {
  readonly arguments?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
}): string | undefined {
  const detailParts: string[] = [];
  const argumentsPreview = buildToolArgumentsPreview(input.arguments);
  if (argumentsPreview) {
    detailParts.push(argumentsPreview);
  }
  if (input.mcpServerName && input.mcpToolName) {
    detailParts.push(`MCP ${input.mcpServerName}.${input.mcpToolName}`);
  }
  const resultDetail = extractToolResultDetail(input.result);
  if (resultDetail) {
    detailParts.push(resultDetail);
  }
  const errorMessage = getErrorMessage(input.error);
  if (errorMessage) {
    detailParts.push(truncatePreview(errorMessage));
  }
  return detailParts.length > 0 ? detailParts.join("\n") : undefined;
}

function rememberToolRequestMetadata(context: GitHubCopilotSessionContext, data: object): void {
  const toolRequests = getObjectProperty(data, "toolRequests");
  if (!Array.isArray(toolRequests)) {
    return;
  }
  for (const request of toolRequests) {
    const record = recordValue(request);
    const toolCallId = stringValue(record?.toolCallId);
    const toolName = stringValue(record?.name);
    const toolArguments = recordValue(record?.arguments);
    if (!toolCallId || !toolName) {
      continue;
    }
    context.toolRequestMetadata.set(toolCallId, {
      toolName,
      ...(typeof record?.toolTitle === "string" && record.toolTitle.length > 0
        ? { toolTitle: record.toolTitle }
        : {}),
      ...(typeof record?.intentionSummary === "string" && record.intentionSummary.length > 0
        ? { intentionSummary: record.intentionSummary }
        : {}),
      ...(toolArguments ? { arguments: toolArguments } : {}),
    });
  }
}

function normalizeGitHubCopilotUsageInfo(
  data: object,
  previous?: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = numberValue(getObjectProperty(data, "currentTokens"));
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = numberValue(getObjectProperty(data, "tokenLimit"));

  return {
    ...previous,
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
  };
}

function mergeGitHubCopilotAssistantUsage(
  data: object,
  previous?: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot | undefined {
  if (!previous) {
    return undefined;
  }

  const inputTokens = numberValue(getObjectProperty(data, "inputTokens"));
  const cachedInputTokens = numberValue(getObjectProperty(data, "cacheReadTokens"));
  const outputTokens = numberValue(getObjectProperty(data, "outputTokens"));
  const durationMs = numberValue(getObjectProperty(data, "duration"));

  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    durationMs === undefined
  ) {
    return undefined;
  }

  return {
    ...previous,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function cloneSession(session: ProviderSession): ProviderSession {
  return { ...session };
}

function withoutActiveTurn(session: ProviderSession): ProviderSession {
  const { activeTurnId: _discarded, ...rest } = session;
  return { ...rest };
}

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

function getObjectProperty(value: object, key: string): unknown {
  return key in value ? (value as { readonly [property: string]: unknown })[key] : undefined;
}

function getSessionEventData(event: SessionEvent): object {
  if (!("data" in event)) {
    return {};
  }
  return typeof event.data === "object" && event.data !== null ? event.data : {};
}

function getSessionEventTimestamp(event: SessionEvent): string | undefined {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : undefined;
}

function messageIdFromSessionEventData(data: object, fallbackEventId: string): string {
  return stringValue(getObjectProperty(data, "messageId")) ?? `assistant:${fallbackEventId}`;
}

function reasoningIdFromSessionEventData(data: object, fallbackEventId: string): string {
  return stringValue(getObjectProperty(data, "reasoningId")) ?? `reasoning:${fallbackEventId}`;
}

function toolRequestsFromSessionEventData(data: object): ReadonlyArray<Record<string, unknown>> {
  const toolRequests = getObjectProperty(data, "toolRequests");
  if (!Array.isArray(toolRequests)) {
    return [];
  }
  return toolRequests.flatMap((entry) => {
    const record = recordValue(entry);
    return record ? [record] : [];
  });
}

function normalizeAnnouncementComparisonText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeWhitespace(value)
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function assistantMessageLooksLikeToolAnnouncement(input: {
  readonly content: string | undefined;
  readonly toolRequests: ReadonlyArray<Record<string, unknown>>;
  readonly turnState: TurnState;
}): boolean {
  const normalizedContent = normalizeAnnouncementComparisonText(input.content);
  if (!normalizedContent || input.toolRequests.length === 0) {
    return false;
  }

  const normalizedIntentText = normalizeAnnouncementComparisonText(input.turnState.lastIntentText);
  if (normalizedIntentText === normalizedContent) {
    return true;
  }

  return input.toolRequests.some((toolRequest) => {
    const toolName = stringValue(getObjectProperty(toolRequest, "name"));
    const toolTitle = sanitizeToolDisplayText(
      stringValue(getObjectProperty(toolRequest, "toolTitle")),
    );
    const intentionSummary = sanitizeToolDisplayText(
      stringValue(getObjectProperty(toolRequest, "intentionSummary")),
    );
    const toolArguments = recordValue(getObjectProperty(toolRequest, "arguments"));
    const argumentIntent = sanitizeToolDisplayText(
      stringValue(toolArguments?.intent) ??
        stringValue(toolArguments?.goal) ??
        stringValue(toolArguments?.explanation) ??
        stringValue(toolArguments?.summary),
    );
    const generatedTitle = buildToolExecutionTitle({
      ...(toolName ? { toolName } : {}),
      ...(toolTitle ? { toolTitle } : {}),
      ...(intentionSummary ? { intentionSummary } : {}),
    });

    return [toolTitle, intentionSummary, generatedTitle, argumentIntent]
      .map(normalizeAnnouncementComparisonText)
      .some((candidate) => candidate === normalizedContent);
  });
}

function contentItemRegistry(
  turnState: TurnState,
  kind: "assistant" | "reasoning",
): Map<string, string> {
  return kind === "assistant"
    ? turnState.assistantItemIdsByMessageId
    : turnState.reasoningItemIdsByReasoningId;
}

function parseIsoTimestampMs(value: string): number | undefined {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function summarizePermissionRequestData(data: object): string | undefined {
  return (
    stringValue(getObjectProperty(data, "fullCommandText")) ??
    stringValue(getObjectProperty(data, "fileName")) ??
    stringValue(getObjectProperty(data, "toolName")) ??
    stringValue(getObjectProperty(data, "url"))
  );
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("message" in value)) {
    return undefined;
  }
  return stringValue(value.message);
}

const makeGitHubCopilotAdapter = Effect.fn("makeGitHubCopilotAdapter")(function* (
  options?: GitHubCopilotAdapterLiveOptions,
) {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, GitHubCopilotSessionContext>();
  const sharedClientsByKey = new Map<string, SharedClientContext>();

  const acquireSharedClient = async (input: {
    readonly binaryPath: string;
    readonly cliUrl: string;
  }): Promise<SharedClientContext> => {
    const key = sharedClientKey(input);
    const existing = sharedClientsByKey.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const client = await createGitHubCopilotClient(
      input.binaryPath,
      input.cliUrl.length > 0 ? { cliUrl: input.cliUrl } : undefined,
    );
    const context: SharedClientContext = {
      key,
      client,
      refCount: 1,
    };
    sharedClientsByKey.set(key, context);
    return context;
  };

  const releaseSharedClientByKey = async (sharedClientKey: string): Promise<void> => {
    const tracked = sharedClientsByKey.get(sharedClientKey);
    if (!tracked) {
      return;
    }
    tracked.refCount = Math.max(0, tracked.refCount - 1);
    if (tracked.refCount > 0) {
      return;
    }
    sharedClientsByKey.delete(sharedClientKey);
    await tracked.client.stop();
  };

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (nativeEventLogger) {
        yield* nativeEventLogger.write(event.raw?.payload ?? event, event.threadId);
      }
      yield* Queue.offer(runtimeEventQueue, event);
    });

  const emitRuntimeEvent = (event: ProviderRuntimeEvent): void => {
    void runPromise(offerRuntimeEvent(event)).catch(() => undefined);
  };

  const makeBaseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    context: GitHubCopilotSessionContext,
    input: {
      readonly type: TType;
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
      readonly rawMethod: string;
      readonly rawSource: "github-copilot.sdk.event" | "github-copilot.sdk.permission";
      readonly rawPayload: unknown;
      readonly providerItemId?: string | undefined;
    },
  ): ProviderRuntimeEventByType<TType> => {
    const createdAt = input.createdAt ?? new Date().toISOString();
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
      threadId: context.session.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
      ...(input.providerItemId
        ? { providerRefs: { providerItemId: ProviderItemId.makeUnsafe(input.providerItemId) } }
        : {}),
      sessionSequence,
      payload: input.payload,
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    } as unknown as ProviderRuntimeEventByType<TType>;
  };

  const completeTurn = (
    context: GitHubCopilotSessionContext,
    state: "completed" | "interrupted" | "failed",
    reason?: string,
  ) => {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const completedAt = new Date().toISOString();
    if (state === "interrupted") {
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.aborted",
          createdAt: completedAt,
          turnId: turnState.turnId,
          payload: { reason: reason ?? "Turn interrupted." },
          rawMethod: "turn.aborted",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state, reason },
        }),
      );
    } else {
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.completed",
          createdAt: completedAt,
          turnId: turnState.turnId,
          payload: {
            state,
            ...(reason ? { errorMessage: reason } : {}),
          },
          rawMethod: "turn.completed",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state, reason },
        }),
      );
    }
    context.turns.push({ id: turnState.turnId, items: [...turnState.items] });
    context.turnState = undefined;
    context.session = {
      ...withoutActiveTurn(context.session),
      status: "ready",
      updatedAt: completedAt,
      ...(state === "failed" && reason ? { lastError: reason } : {}),
    };
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "session.state.changed",
        createdAt: completedAt,
        payload: {
          state: "ready",
          ...(reason ? { reason } : {}),
        },
        rawMethod: "session.state.changed",
        rawSource: "github-copilot.sdk.event",
        rawPayload: { state: "ready", reason },
      }),
    );
  };

  const ensureContentItem = (
    context: GitHubCopilotSessionContext,
    input: {
      readonly kind: "assistant" | "reasoning";
      readonly providerContentId: string;
      readonly createdAt?: string | undefined;
      readonly rawMethod: string;
      readonly rawSource: "github-copilot.sdk.event" | "github-copilot.sdk.permission";
      readonly rawPayload: unknown;
    },
  ): string | undefined => {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }
    const registry = contentItemRegistry(turnState, input.kind);
    const existing = registry.get(input.providerContentId);
    if (existing) {
      return existing;
    }
    const itemId = randomUUID();
    registry.set(input.providerContentId, itemId);
    const itemType: CanonicalItemType =
      input.kind === "assistant" ? "assistant_message" : "reasoning";
    const event = makeBaseEvent(context, {
      type: "item.started",
      createdAt: input.createdAt,
      turnId: turnState.turnId,
      itemId,
      payload: {
        itemType,
        title: input.kind === "assistant" ? "Assistant response" : "Reasoning",
        status: "inProgress",
      },
      rawMethod: input.rawMethod,
      rawSource: input.rawSource,
      rawPayload: input.rawPayload,
      providerItemId: input.providerContentId,
    });
    turnState.items.push(event);
    emitRuntimeEvent(event);
    return itemId;
  };

  const releaseContentItem = (
    turnState: TurnState,
    kind: "assistant" | "reasoning",
    providerContentId: string,
  ) => {
    contentItemRegistry(turnState, kind).delete(providerContentId);
  };

  const syncAnnouncedToolRequest = (
    context: GitHubCopilotSessionContext,
    event: SessionEvent,
    request: Record<string, unknown>,
  ): void => {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const providerItemId = stringValue(getObjectProperty(request, "toolCallId"));
    const toolName = stringValue(getObjectProperty(request, "name"));
    if (!providerItemId || !toolName) {
      return;
    }

    const requestMetadata = context.toolRequestMetadata.get(providerItemId);
    const toolArguments =
      recordValue(getObjectProperty(request, "arguments")) ?? requestMetadata?.arguments;
    const toolTitle =
      stringValue(getObjectProperty(request, "toolTitle")) ?? requestMetadata?.toolTitle;
    const intentionSummary =
      stringValue(getObjectProperty(request, "intentionSummary")) ??
      requestMetadata?.intentionSummary;
    const existing = turnState.toolItems.get(providerItemId);
    const itemType = existing?.itemType ?? classifyToolItemType(toolName);
    const title = buildToolExecutionTitle({
      toolName,
      ...(toolTitle ? { toolTitle } : {}),
      ...(intentionSummary ? { intentionSummary } : {}),
    });
    const detail = buildToolExecutionDetail(toolArguments ? { arguments: toolArguments } : {});
    const data = {
      toolName,
      ...(toolArguments ? { arguments: toolArguments } : {}),
      ...(toolTitle ? { toolTitle } : {}),
      ...(intentionSummary ? { intentionSummary } : {}),
    };

    const toolItem: ToolItemState =
      existing ??
      ({
        itemId: randomUUID(),
        itemType,
        toolName,
        title,
        ...(detail ? { detail } : {}),
        data,
        completed: false,
      } satisfies ToolItemState);

    toolItem.itemType = itemType;
    toolItem.toolName = toolName;
    toolItem.title = title;
    toolItem.data = data;
    toolItem.completed = false;
    if (detail) {
      toolItem.detail = detail;
    } else {
      delete toolItem.detail;
    }
    turnState.toolItems.set(providerItemId, toolItem);

    const runtimeEvent = makeBaseEvent(context, {
      type: existing ? "item.updated" : "item.started",
      createdAt: getSessionEventTimestamp(event),
      turnId: turnState.turnId,
      itemId: toolItem.itemId,
      providerItemId,
      payload: {
        itemType: toolItem.itemType,
        status: "inProgress",
        title: toolItem.title,
        ...(toolItem.detail ? { detail: toolItem.detail } : {}),
        data: toolItem.data,
      },
      rawMethod: event.type,
      rawSource: "github-copilot.sdk.event",
      rawPayload: event,
    });
    turnState.items.push(runtimeEvent);
    emitRuntimeEvent(runtimeEvent);
  };

  const emitAssistantIntentAsReasoning = (
    context: GitHubCopilotSessionContext,
    event: SessionEvent,
    data: object,
  ): void => {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const intent = stringValue(getObjectProperty(data, "intent"));
    if (!intent) {
      return;
    }
    turnState.lastIntentText = intent;
    turnState.reasoningOutputSeen = true;
    const providerContentId = `intent:${event.id}`;
    const itemId = ensureContentItem(context, {
      kind: "reasoning",
      providerContentId,
      createdAt: getSessionEventTimestamp(event),
      rawMethod: event.type,
      rawSource: "github-copilot.sdk.event",
      rawPayload: event,
    });
    if (!itemId) {
      return;
    }

    const runtimeEvent = makeBaseEvent(context, {
      type: "item.completed",
      createdAt: getSessionEventTimestamp(event),
      turnId: turnState.turnId,
      itemId,
      providerItemId: providerContentId,
      payload: {
        itemType: "reasoning",
        status: "completed",
        detail: intent,
        data: {
          content: intent,
          source: "assistant.intent",
        },
      },
      rawMethod: event.type,
      rawSource: "github-copilot.sdk.event",
      rawPayload: event,
    });
    turnState.items.push(runtimeEvent);
    emitRuntimeEvent(runtimeEvent);
    releaseContentItem(turnState, "reasoning", providerContentId);
  };

  const emitAssistantMessageReasoningFallback = (
    context: GitHubCopilotSessionContext,
    event: SessionEvent,
    messageId: string,
    data: object,
  ): void => {
    const turnState = context.turnState;
    if (!turnState || turnState.reasoningOutputSeen) {
      return;
    }
    const reasoningText = stringValue(getObjectProperty(data, "reasoningText"));
    if (!reasoningText) {
      return;
    }

    turnState.reasoningOutputSeen = true;
    const providerContentId = `message-reasoning:${messageId}`;
    const itemId = ensureContentItem(context, {
      kind: "reasoning",
      providerContentId,
      createdAt: getSessionEventTimestamp(event),
      rawMethod: event.type,
      rawSource: "github-copilot.sdk.event",
      rawPayload: event,
    });
    if (!itemId) {
      return;
    }

    const runtimeEvent = makeBaseEvent(context, {
      type: "item.completed",
      createdAt: getSessionEventTimestamp(event),
      turnId: turnState.turnId,
      itemId,
      providerItemId: providerContentId,
      payload: {
        itemType: "reasoning",
        status: "completed",
        detail: reasoningText,
        data: {
          content: reasoningText,
          source: "assistant.message.reasoningText",
        },
      },
      rawMethod: event.type,
      rawSource: "github-copilot.sdk.event",
      rawPayload: event,
    });
    turnState.items.push(runtimeEvent);
    emitRuntimeEvent(runtimeEvent);
    releaseContentItem(turnState, "reasoning", providerContentId);
  };

  const handleSessionEvent = (context: GitHubCopilotSessionContext, event: SessionEvent): void => {
    const turnState = context.turnState;
    const data = getSessionEventData(event);
    switch (event.type) {
      case "assistant.intent": {
        emitAssistantIntentAsReasoning(context, event, data);
        return;
      }
      case "assistant.message_delta": {
        const delta = stringValue(getObjectProperty(data, "deltaContent"));
        const messageId = messageIdFromSessionEventData(data, event.id);
        const itemId = ensureContentItem(context, {
          kind: "assistant",
          providerContentId: messageId,
          createdAt: getSessionEventTimestamp(event),
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        if (!turnState || !itemId || !delta) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "content.delta",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          providerItemId: messageId,
          payload: {
            streamKind: "assistant_text",
            delta,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "assistant.reasoning_delta": {
        const delta = stringValue(getObjectProperty(data, "deltaContent"));
        const reasoningId = reasoningIdFromSessionEventData(data, event.id);
        const itemId = ensureContentItem(context, {
          kind: "reasoning",
          providerContentId: reasoningId,
          createdAt: getSessionEventTimestamp(event),
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        if (!turnState || !itemId || !delta) {
          return;
        }
        turnState.reasoningOutputSeen = true;
        const runtimeEvent = makeBaseEvent(context, {
          type: "content.delta",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          providerItemId: reasoningId,
          payload: {
            streamKind: "reasoning_text",
            delta,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "assistant.message": {
        rememberToolRequestMetadata(context, data);
        const toolRequests = toolRequestsFromSessionEventData(data);
        for (const toolRequest of toolRequests) {
          syncAnnouncedToolRequest(context, event, toolRequest);
        }
        const content = stringValue(getObjectProperty(data, "content"));
        const messageId = messageIdFromSessionEventData(data, event.id);
        emitAssistantMessageReasoningFallback(context, event, messageId, data);
        const hasStreamingItem = turnState?.assistantItemIdsByMessageId.has(messageId) ?? false;
        const shouldSuppressAnnouncementMessage =
          !!turnState &&
          !hasStreamingItem &&
          assistantMessageLooksLikeToolAnnouncement({
            content,
            toolRequests,
            turnState,
          });
        if ((!content && !hasStreamingItem) || shouldSuppressAnnouncementMessage) {
          return;
        }
        const itemId = ensureContentItem(context, {
          kind: "assistant",
          providerContentId: messageId,
          createdAt: getSessionEventTimestamp(event),
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        if (!turnState || !itemId) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          providerItemId: messageId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            ...(content ? { detail: content } : {}),
            ...(content ? { data: { content } } : {}),
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        releaseContentItem(turnState, "assistant", messageId);
        return;
      }
      case "assistant.reasoning": {
        const content = stringValue(getObjectProperty(data, "content"));
        const reasoningId = reasoningIdFromSessionEventData(data, event.id);
        const hasStreamingItem = turnState?.reasoningItemIdsByReasoningId.has(reasoningId) ?? false;
        if (!content && !hasStreamingItem) {
          return;
        }
        if (turnState) {
          turnState.reasoningOutputSeen = true;
        }
        const itemId = ensureContentItem(context, {
          kind: "reasoning",
          providerContentId: reasoningId,
          createdAt: getSessionEventTimestamp(event),
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        if (!turnState || !itemId) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          providerItemId: reasoningId,
          payload: {
            itemType: "reasoning",
            status: "completed",
            ...(content ? { detail: content } : {}),
            ...(content ? { data: { content } } : {}),
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        releaseContentItem(turnState, "reasoning", reasoningId);
        return;
      }
      case "session.usage_info": {
        const usage = normalizeGitHubCopilotUsageInfo(data, context.lastKnownTokenUsage);
        if (!usage) {
          return;
        }
        context.lastKnownTokenUsage = usage;
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "thread.token-usage.updated",
            createdAt: getSessionEventTimestamp(event),
            turnId: turnState?.turnId,
            payload: {
              usage,
            },
            rawMethod: event.type,
            rawSource: "github-copilot.sdk.event",
            rawPayload: event,
          }),
        );
        return;
      }
      case "assistant.usage": {
        const usage = mergeGitHubCopilotAssistantUsage(data, context.lastKnownTokenUsage);
        if (!usage) {
          return;
        }
        context.lastKnownTokenUsage = usage;
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "thread.token-usage.updated",
            createdAt: getSessionEventTimestamp(event),
            turnId: turnState?.turnId,
            payload: {
              usage,
            },
            rawMethod: event.type,
            rawSource: "github-copilot.sdk.event",
            rawPayload: event,
          }),
        );
        return;
      }
      case "tool.execution_start": {
        if (!turnState) {
          return;
        }
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId")) ?? randomUUID();
        const requestMetadata = context.toolRequestMetadata.get(providerItemId);
        const toolName =
          stringValue(getObjectProperty(data, "toolName")) ?? requestMetadata?.toolName ?? "Tool";
        const toolArguments =
          recordValue(getObjectProperty(data, "arguments")) ?? requestMetadata?.arguments;
        const mcpServerName = stringValue(getObjectProperty(data, "mcpServerName"));
        const mcpToolName = stringValue(getObjectProperty(data, "mcpToolName"));
        const existing = turnState.toolItems.get(providerItemId);
        const toolExecutionTitle = buildToolExecutionTitle({
          toolName,
          ...(requestMetadata?.toolTitle ? { toolTitle: requestMetadata.toolTitle } : {}),
          ...(requestMetadata?.intentionSummary
            ? { intentionSummary: requestMetadata.intentionSummary }
            : {}),
          ...(mcpToolName ? { mcpToolName } : {}),
        });
        const toolExecutionDetail = buildToolExecutionDetail({
          ...(toolArguments ? { arguments: toolArguments } : {}),
          ...(mcpServerName ? { mcpServerName } : {}),
          ...(mcpToolName ? { mcpToolName } : {}),
        });
        const toolData = {
          toolName,
          ...(toolArguments ? { arguments: toolArguments } : {}),
          ...(mcpServerName ? { mcpServerName } : {}),
          ...(mcpToolName ? { mcpToolName } : {}),
        };
        const toolItem: ToolItemState =
          existing ??
          ({
            itemId: randomUUID(),
            itemType: classifyToolItemType(toolName),
            toolName,
            title: toolExecutionTitle,
            ...(toolExecutionDetail ? { detail: toolExecutionDetail } : {}),
            data: toolData,
            completed: false,
          } satisfies ToolItemState);
        toolItem.itemType = existing?.itemType ?? classifyToolItemType(toolName);
        toolItem.toolName = toolName;
        toolItem.title = toolExecutionTitle;
        toolItem.data = toolData;
        toolItem.completed = false;
        if (toolExecutionDetail) {
          toolItem.detail = toolExecutionDetail;
        } else {
          delete toolItem.detail;
        }
        turnState.toolItems.set(providerItemId, toolItem);
        const runtimeEvent = makeBaseEvent(context, {
          type: existing ? "item.updated" : "item.started",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          providerItemId,
          payload: {
            itemType: toolItem.itemType,
            status: "inProgress",
            title: toolItem.title,
            ...(toolItem.detail
              ? {
                  detail: toolItem.detail,
                }
              : summarizePermissionRequestData(data)
                ? { detail: summarizePermissionRequestData(data) }
                : {}),
            data: toolItem.data,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "tool.execution_progress": {
        if (!turnState) {
          return;
        }
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId"));
        const toolItem = providerItemId ? turnState.toolItems.get(providerItemId) : undefined;
        if (!providerItemId || !toolItem || toolItem.completed) {
          return;
        }
        const progressMessage = stringValue(getObjectProperty(data, "progressMessage"));
        if (progressMessage) {
          toolItem.detail = progressMessage;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.updated",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          providerItemId,
          payload: {
            itemType: toolItem.itemType,
            status: "inProgress",
            title: toolItem.title,
            ...(toolItem.detail ? { detail: toolItem.detail } : {}),
            data: toolItem.data,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "tool.execution_partial_result": {
        if (!turnState) {
          return;
        }
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId"));
        const toolItem = providerItemId ? turnState.toolItems.get(providerItemId) : undefined;
        if (!providerItemId || !toolItem || toolItem.completed) {
          return;
        }
        const partialOutput = stringValue(getObjectProperty(data, "partialOutput"));
        if (partialOutput) {
          toolItem.detail = partialOutput;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.updated",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          providerItemId,
          payload: {
            itemType: toolItem.itemType,
            status: "inProgress",
            title: toolItem.title,
            ...(toolItem.detail ? { detail: toolItem.detail } : {}),
            data: toolItem.data,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "tool.execution_complete": {
        if (!turnState) {
          return;
        }
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId"));
        const requestMetadata = providerItemId
          ? context.toolRequestMetadata.get(providerItemId)
          : undefined;
        const completedToolName =
          stringValue(getObjectProperty(data, "toolName")) ?? requestMetadata?.toolName ?? "Tool";
        const toolItem =
          (providerItemId ? turnState.toolItems.get(providerItemId) : undefined) ??
          ({
            itemId: randomUUID(),
            itemType: classifyToolItemType(completedToolName),
            toolName: completedToolName,
            title: buildToolExecutionTitle({
              toolName: completedToolName,
              ...(requestMetadata?.toolTitle ? { toolTitle: requestMetadata.toolTitle } : {}),
              ...(requestMetadata?.intentionSummary
                ? { intentionSummary: requestMetadata.intentionSummary }
                : {}),
            }),
            data: {},
            completed: false,
          } satisfies ToolItemState);
        if (providerItemId) {
          turnState.toolItems.delete(providerItemId);
          context.toolRequestMetadata.delete(providerItemId);
        }
        const success = getObjectProperty(data, "success");
        const error = getObjectProperty(data, "error");
        const result = getObjectProperty(data, "result");
        const model = stringValue(getObjectProperty(data, "model"));
        const toolExecutionTitle = buildToolExecutionTitle({
          toolName: toolItem.toolName,
          ...(requestMetadata?.toolTitle ? { toolTitle: requestMetadata.toolTitle } : {}),
          ...(requestMetadata?.intentionSummary
            ? { intentionSummary: requestMetadata.intentionSummary }
            : {}),
        });
        const toolExecutionDetail = buildToolExecutionDetail({
          ...(requestMetadata?.arguments ? { arguments: requestMetadata.arguments } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {}),
        });
        toolItem.title = toolExecutionTitle;
        if (toolExecutionDetail) {
          toolItem.detail = toolExecutionDetail;
        }
        toolItem.data = {
          ...(requestMetadata?.toolName ? { toolName: requestMetadata.toolName } : {}),
          ...(requestMetadata?.arguments ? { arguments: requestMetadata.arguments } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(model ? { model } : {}),
          ...data,
        };
        toolItem.completed = true;
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          ...(providerItemId ? { providerItemId } : {}),
          payload: {
            itemType: toolItem.itemType,
            status: success === false ? "failed" : "completed",
            title: toolItem.title,
            ...(toolItem.detail
              ? {
                  detail: toolItem.detail,
                }
              : error
                ? { detail: getErrorMessage(error) }
                : {}),
            data: toolItem.data,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "session.idle": {
        completeTurn(context, turnState?.abortRequested ? "interrupted" : "completed");
        return;
      }
      default:
        return;
    }
  };

  const stopContext = async (context: GitHubCopilotSessionContext): Promise<void> => {
    if (context.stopped) {
      return;
    }
    context.stopped = true;
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve("cancel");
    }
    context.pendingApprovals.clear();
    for (const pending of context.pendingUserInputs.values()) {
      pending.resolve({});
    }
    context.pendingUserInputs.clear();
    for (const unsubscribe of context.unsubscribers) {
      unsubscribe();
    }
    context.unsubscribers.length = 0;
    try {
      await context.sdkSession.disconnect();
    } catch {
      // Preserve shutdown best-effort semantics.
    }
    try {
      await releaseSharedClientByKey(context.sharedClientKey);
    } catch {
      // Preserve shutdown best-effort semantics.
    }
    context.session = {
      ...withoutActiveTurn(context.session),
      status: "closed",
      updatedAt: new Date().toISOString(),
    };
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "session.exited",
        payload: {
          exitKind: "graceful",
          reason: "Session stopped.",
        },
        rawMethod: "session.exited",
        rawSource: "github-copilot.sdk.event",
        rawPayload: { reason: "Session stopped." },
      }),
    );
  };

  const startSession: GitHubCopilotAdapterShape["startSession"] = (input) =>
    Effect.tryPromise(async () => {
      if (input.provider !== PROVIDER) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected modelSelection.provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
        });
      }

      const settings = await runPromise(
        serverSettingsService.getSettings.pipe(
          Effect.map((value) => value.providers.githubCopilot),
        ),
      );
      const sharedClient = await acquireSharedClient({
        binaryPath: settings.binaryPath,
        cliUrl: settings.cliUrl.trim(),
      });

      const existing = sessions.get(input.threadId);
      if (existing) {
        await stopContext(existing);
        sessions.delete(input.threadId);
      }

      let context: GitHubCopilotSessionContext | undefined;
      const permissionHandler = async (
        request: PermissionRequest,
      ): Promise<PermissionRequestResult> => {
        if (!context) {
          return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
        }
        if (input.runtimeMode === "full-access") {
          return { kind: "approved" };
        }

        const fingerprint = permissionRequestFingerprint(request);
        if (fingerprint && context.approvalFingerprints.has(fingerprint)) {
          return { kind: "approved" };
        }

        const requestId = randomUUID();
        const deferred = makeDeferredDecision<ProviderApprovalDecision>();
        const detail = summarizePermissionRequest(request);
        context.pendingApprovals.set(requestId, {
          requestType: classifyPermissionRequest(request),
          ...(detail ? { detail } : {}),
          ...(fingerprint ? { fingerprint } : {}),
          resolve: deferred.resolve,
          promise: deferred.promise,
        });

        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "request.opened",
            turnId: context.turnState?.turnId,
            requestId,
            payload: {
              requestType: classifyPermissionRequest(request),
              ...(summarizePermissionRequest(request)
                ? { detail: summarizePermissionRequest(request) }
                : {}),
              args: request,
            },
            rawMethod: "permission.requested",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: request,
          }),
        );

        const decision = await deferred.promise;
        context.pendingApprovals.delete(requestId);
        if (decision === "acceptForSession" && fingerprint) {
          context.approvalFingerprints.add(fingerprint);
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "request.resolved",
            turnId: context.turnState?.turnId,
            requestId,
            payload: {
              requestType: classifyPermissionRequest(request),
              decision,
            },
            rawMethod: "permission.resolved",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: { request, decision },
          }),
        );
        return mapApprovalDecision(decision);
      };

      const userInputHandler = async (request: UserInputRequest): Promise<UserInputResponse> => {
        if (!context) {
          return { answer: "", wasFreeform: true };
        }
        const requestId = randomUUID();
        const deferred = makeDeferredDecision<ProviderUserInputAnswers>();
        const questionId = "response";
        const questions: ReadonlyArray<UserInputQuestion> = [
          {
            id: questionId,
            header: "GitHub Copilot question",
            question: request.question,
            options:
              request.choices?.map((choice: string) => ({ label: choice, description: "" })) ?? [],
            multiSelect: false,
          },
        ];
        context.pendingUserInputs.set(requestId, {
          questions,
          choices: request.choices ?? [],
          allowFreeform: request.allowFreeform ?? true,
          resolve: deferred.resolve,
          promise: deferred.promise,
        });

        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "user-input.requested",
            turnId: context.turnState?.turnId,
            requestId,
            payload: { questions },
            rawMethod: "user-input.requested",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: request,
          }),
        );

        const answers = await deferred.promise;
        context.pendingUserInputs.delete(requestId);
        const selected = answers[questionId] ?? Object.values(answers)[0] ?? "";
        const answer = typeof selected === "string" ? selected : JSON.stringify(selected);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "user-input.resolved",
            turnId: context.turnState?.turnId,
            requestId,
            payload: { answers },
            rawMethod: "user-input.resolved",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: answers,
          }),
        );
        return {
          answer,
          wasFreeform: !(request.choices ?? []).includes(answer),
        };
      };

      try {
        const availableModels = input.modelSelection?.model
          ? await sharedClient.client.listModels()
          : [];
        const normalizedModelOptions = normalizeGitHubCopilotModelOptionsForModel(
          availableModels.find((model) => model.id === input.modelSelection?.model),
          input.modelSelection?.options,
        );
        const sdkSession =
          typeof input.resumeCursor === "string"
            ? await sharedClient.client.resumeSession(input.resumeCursor, {
                onPermissionRequest: permissionHandler,
                onUserInputRequest: userInputHandler,
                ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
                ...(normalizedModelOptions?.reasoningEffort
                  ? { reasoningEffort: normalizedModelOptions.reasoningEffort }
                  : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                streaming: true,
              })
            : await sharedClient.client.createSession({
                onPermissionRequest: permissionHandler,
                onUserInputRequest: userInputHandler,
                ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
                ...(normalizedModelOptions?.reasoningEffort
                  ? { reasoningEffort: normalizedModelOptions.reasoningEffort }
                  : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                streaming: true,
              });

        const now = new Date().toISOString();
        const createdContext: GitHubCopilotSessionContext = {
          session: {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            resumeCursor: sdkSession.sessionId,
            createdAt: now,
            updatedAt: now,
          },
          sharedClientKey: sharedClient.key,
          sdkSession,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          approvalFingerprints: new Set(),
          toolRequestMetadata: new Map(),
          turns: [],
          unsubscribers: [],
          sequenceTieBreakersByTimestampMs: new Map(),
          nextFallbackSessionSequence: 0,
          turnState: undefined,
          stopped: false,
        };
        context = createdContext;
        createdContext.unsubscribers.push(
          sdkSession.on((event) => {
            handleSessionEvent(createdContext, event);
          }),
        );
        sessions.set(input.threadId, createdContext);

        emitRuntimeEvent(
          makeBaseEvent(createdContext, {
            type: "session.started",
            payload: {
              message:
                typeof input.resumeCursor === "string"
                  ? "Resumed GitHub Copilot session."
                  : "Started GitHub Copilot session.",
              resume: typeof input.resumeCursor === "string" ? input.resumeCursor : undefined,
            },
            rawMethod: "session.started",
            rawSource: "github-copilot.sdk.event",
            rawPayload: {
              sessionId: sdkSession.sessionId,
            },
          }),
        );
        emitRuntimeEvent(
          makeBaseEvent(createdContext, {
            type: "thread.started",
            payload: {
              providerThreadId: sdkSession.sessionId,
            },
            rawMethod: "thread.started",
            rawSource: "github-copilot.sdk.event",
            rawPayload: { sessionId: sdkSession.sessionId },
          }),
        );

        return cloneSession(createdContext.session);
      } catch (cause) {
        try {
          await releaseSharedClientByKey(sharedClient.key);
        } catch {
          // Ignore secondary shutdown failures.
        }
        throw new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to start GitHub Copilot session."),
          cause,
        });
      }
    });

  const sendTurn: GitHubCopilotAdapterShape["sendTurn"] = (input) =>
    Effect.tryPromise(async () => {
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
          issue: `Expected modelSelection.provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
        });
      }
      if (
        input.modelSelection?.model &&
        context.session.model &&
        input.modelSelection.model !== context.session.model
      ) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail:
            "GitHub Copilot model changes require a session restart. The orchestration layer should restart this provider session before sending the turn.",
        });
      }

      const turnId = TurnId.makeUnsafe(randomUUID());
      const createdAt = new Date().toISOString();
      context.turnState = {
        turnId,
        startedAt: createdAt,
        items: [],
        assistantItemIdsByMessageId: new Map(),
        reasoningItemIdsByReasoningId: new Map(),
        toolItems: new Map(),
        reasoningOutputSeen: false,
        abortRequested: false,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: createdAt,
      };

      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.started",
          createdAt,
          turnId,
          payload: context.session.model ? { model: context.session.model } : {},
          rawMethod: "turn.started",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { input },
        }),
      );
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "session.state.changed",
          createdAt,
          payload: {
            state: "running",
          },
          rawMethod: "session.state.changed",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state: "running" },
        }),
      );

      const attachments = (input.attachments ?? [])
        .map((attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return null;
          }
          return {
            type: "file" as const,
            path,
            displayName: attachment.name,
          };
        })
        .filter(
          (attachment): attachment is { type: "file"; path: string; displayName: string } =>
            attachment !== null,
        );

      try {
        await context.sdkSession.send({
          prompt: input.input ?? "Please analyze the attached files.",
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      } catch (cause) {
        completeTurn(context, "failed", toMessage(cause, "GitHub Copilot turn failed."));
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: toMessage(cause, "GitHub Copilot turn failed."),
          cause,
        });
      }

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.sdkSession.sessionId,
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: GitHubCopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.turnState) {
        context.turnState.abortRequested = true;
      }
      await context.sdkSession.abort();
    });

  const respondToRequest: GitHubCopilotAdapterShape["respondToRequest"] = (
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
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      pending.resolve(decision);
    });

  const respondToUserInput: GitHubCopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.sync(() => {
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
          method: "respondToUserInput",
          detail: `Unknown pending user input request: ${requestId}`,
        });
      }
      pending.resolve(answers);
    });

  const stopSession: GitHubCopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      sessions.delete(threadId);
      await stopContext(context);
    });

  const listSessions: GitHubCopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => cloneSession(context.session)));

  const hasSession: GitHubCopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: GitHubCopilotAdapterShape["readThread"] = (threadId) =>
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

  const rollbackThread: GitHubCopilotAdapterShape["rollbackThread"] = (_threadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "rollbackThread",
        detail:
          "GitHub Copilot session rollback is not supported by the current adapter implementation.",
      }),
    );

  const stopAll: GitHubCopilotAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      await Promise.all(
        Array.from(sessions.entries()).map(async ([threadId, context]) => {
          sessions.delete(threadId);
          await stopContext(context);
        }),
      );
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
  } satisfies GitHubCopilotAdapterShape;
});

export const GitHubCopilotAdapterLive = Layer.effect(
  GitHubCopilotAdapter,
  makeGitHubCopilotAdapter(),
);

export function makeGitHubCopilotAdapterLive(options?: GitHubCopilotAdapterLiveOptions) {
  return Layer.effect(GitHubCopilotAdapter, makeGitHubCopilotAdapter(options));
}
