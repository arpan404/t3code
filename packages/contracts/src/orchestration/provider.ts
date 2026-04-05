import { Option, Schema, SchemaIssue } from "effect";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  GeminiModelOptions,
  GitHubCopilotModelOptions,
  OpenCodeModelOptions,
} from "../model";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderItemId,
  TrimmedNonEmptyString,
} from "../baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
} as const;

export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "githubCopilot",
  "cursor",
  "gemini",
  "opencode",
]);
export type ProviderKind = typeof ProviderKind.Type;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const GitHubCopilotModelSelection = Schema.Struct({
  provider: Schema.Literal("githubCopilot"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(GitHubCopilotModelOptions),
});
export type GitHubCopilotModelSelection = typeof GitHubCopilotModelSelection.Type;

export const CursorModelSelection = Schema.Struct({
  provider: Schema.Literal("cursor"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CursorModelOptions),
});
export type CursorModelSelection = typeof CursorModelSelection.Type;

export const GeminiModelSelection = Schema.Struct({
  provider: Schema.Literal("gemini"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(GeminiModelOptions),
});
export type GeminiModelSelection = typeof GeminiModelSelection.Type;

export const OpenCodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(OpenCodeModelOptions),
});
export type OpenCodeModelSelection = typeof OpenCodeModelSelection.Type;

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  GitHubCopilotModelSelection,
  CursorModelSelection,
  GeminiModelSelection,
  OpenCodeModelSelection,
]);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
export const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

export const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;

export const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const QUEUED_TERMINAL_CONTEXT_ID_MAX_CHARS = 128;
export const QUEUED_TERMINAL_LABEL_MAX_CHARS = 255;

export const QueuedTerminalContextId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(QUEUED_TERMINAL_CONTEXT_ID_MAX_CHARS),
);

export const QueuedTerminalLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(QUEUED_TERMINAL_LABEL_MAX_CHARS),
);

export const QueuedComposerImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type QueuedComposerImageAttachment = typeof QueuedComposerImageAttachment.Type;

export const QueuedComposerTerminalContext = Schema.Struct({
  id: QueuedTerminalContextId,
  createdAt: IsoDateTime,
  terminalId: TrimmedNonEmptyString,
  terminalLabel: QueuedTerminalLabel,
  lineStart: NonNegativeInt,
  lineEnd: NonNegativeInt,
  text: Schema.String,
}).check(
  Schema.makeFilter(
    (input) =>
      input.lineEnd >= input.lineStart ||
      new SchemaIssue.InvalidValue(Option.some(input.lineEnd), {
        message: "lineEnd must be greater than or equal to lineStart",
      }),
  ),
);
export type QueuedComposerTerminalContext = typeof QueuedComposerTerminalContext.Type;

export const QueuedComposerMessage = Schema.Struct({
  id: MessageId,
  prompt: Schema.String,
  images: Schema.Array(QueuedComposerImageAttachment),
  terminalContexts: Schema.Array(QueuedComposerTerminalContext),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
});
export type QueuedComposerMessage = typeof QueuedComposerMessage.Type;

export const QueuedSteerRequest = Schema.Struct({
  messageId: MessageId,
  baselineWorkLogEntryCount: NonNegativeInt,
  interruptRequested: Schema.Boolean,
});
export type QueuedSteerRequest = typeof QueuedSteerRequest.Type;

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);
export type TurnCountRange = typeof TurnCountRange.Type;

export const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;
