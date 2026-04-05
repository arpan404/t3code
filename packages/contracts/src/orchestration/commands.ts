import { Schema } from "effect";
import {
  ApprovalRequestId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../baseSchemas";
import {
  ChatAttachment,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  QueuedComposerMessage,
  QueuedSteerRequest,
  RuntimeMode,
  UploadChatAttachment,
} from "./provider";
import {
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ProjectScript,
  SourceProposedPlanReference,
} from "./readModel";
import { CheckpointRef } from "../baseSchemas";

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

export const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

export const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

export const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

export const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  queuedComposerMessages: Schema.optional(Schema.Array(QueuedComposerMessage)),
  queuedSteerRequest: Schema.optional(Schema.NullOr(QueuedSteerRequest)),
});

export const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

export const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

export const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

export const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

export const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

export const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

export const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;
