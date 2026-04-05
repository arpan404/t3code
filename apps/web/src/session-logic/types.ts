import type {
  ApprovalRequestId,
  OrchestrationProposedPlanId,
  ProviderKind,
  ThreadId,
  ToolLifecycleItemType,
  TurnId,
  UserInputQuestion,
} from "@ace/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "../types";

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
  { value: "githubCopilot", label: "Copilot", available: true },
  { value: "cursor", label: "Cursor", available: true },
  { value: "gemini", label: "Gemini", available: true },
  { value: "opencode", label: "OpenCode", available: true },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  sequence?: number;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  intentText?: string;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "intent";
      createdAt: string;
      text: string;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export type { ChatMessage, ProposedPlan, SessionPhase, Thread, ThreadSession, TurnDiffSummary };
