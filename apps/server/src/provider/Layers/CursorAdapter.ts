import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeContentStreamKind,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { startCursorAcpClient, type CursorAcpClient, type CursorAcpJsonRpcId } from "../cursorAcp";
import { type CursorAdapterShape, CursorAdapter } from "../Services/CursorAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "cursor" as const;
const ACP_CONTROL_TIMEOUT_MS = 15_000;

type CursorResumeCursor = {
  readonly sessionId: string;
};

type PendingApproval = {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: CursorAcpJsonRpcId;
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

type TurnSnapshot = {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  assistantText: string;
};

type CursorSessionContext = {
  session: ProviderSession;
  readonly client: CursorAcpClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<TurnSnapshot>;
  activeTurn: TurnSnapshot | undefined;
  stopping: boolean;
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

function requestIdFromApprovalRequest(requestId: ApprovalRequestId) {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function toDecisionOptionId(
  decision: ProviderApprovalDecision,
): "allow-once" | "allow-always" | "reject-once" {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    case "cancel":
    default:
      return "reject-once";
  }
}

function streamKindFromUpdateKind(updateKind: string): RuntimeContentStreamKind {
  const normalized = updateKind.toLowerCase();
  if (normalized.includes("summary")) {
    return "reasoning_summary_text";
  }
  if (normalized.includes("reason")) {
    return "reasoning_text";
  }
  if (normalized.includes("plan")) {
    return "plan_text";
  }
  return "assistant_text";
}

function describePermissionRequest(params: unknown): string | undefined {
  const record = asObject(params);
  if (!record) {
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

    const baseEvent = (
      context: CursorSessionContext,
      input: {
        readonly turnId?: TurnId;
        readonly requestId?: ApprovalRequestId;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
      } = {},
    ) => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: isoNow(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.requestId ? { requestId: requestIdFromApprovalRequest(input.requestId) } : {}),
      ...(input.rawMethod
        ? {
            raw: {
              source: input.requestId
                ? ("cursor.acp.request" as const)
                : ("cursor.acp.notification" as const),
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

    const handleSessionUpdate = (context: CursorSessionContext, params: unknown) => {
      const record = asObject(params);
      const update = asObject(record?.update);
      const updateKind = asString(update?.sessionUpdate);
      const content = asObject(update?.content);
      const text = asString(content?.text) ?? asString(update?.text);
      const turnId = context.activeTurn?.id;

      if (!updateKind || !turnId || !text) {
        return;
      }

      if (updateKind.toLowerCase().includes("plan")) {
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

      activeTurn.assistantText += text;
      activeTurn.items.push({ kind: "assistant_text", text });
      emit({
        ...baseEvent(context, { turnId, rawMethod: "session/update", rawPayload: params }),
        type: "content.delta",
        payload: {
          streamKind: streamKindFromUpdateKind(updateKind),
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
        const requestId = ApprovalRequestId.makeUnsafe(`cursor-permission:${randomUUID()}`);
        context.pendingApprovals.set(requestId, {
          requestId,
          jsonRpcId: request.id,
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
            requestType: "command_execution_approval",
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
        emit({
          ...baseEvent(context, {
            ...(context.activeTurn?.id ? { turnId: context.activeTurn.id } : {}),
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
      Effect.tryPromise(async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
          });
        }

        const settings = await runPromise(settingsService.getSettings);
        const existing = sessions.get(input.threadId);
        if (existing) {
          return existing.session;
        }

        const client = startCursorAcpClient({
          binaryPath: settings.providers.cursor.binaryPath,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        });
        const createdAt = isoNow();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const context: CursorSessionContext = {
          session,
          client,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeTurn: undefined,
          stopping: false,
        };
        sessions.set(input.threadId, context);

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
        client.setNotificationHandler((notification) => handleNotification(context, notification));
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
        );
        await client.request(
          "authenticate",
          { methodId: "cursor_login" },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        );

        const resumeSessionId = readResumeSessionId(input.resumeCursor);
        const sessionResult = (await client.request(
          resumeSessionId ? "session/load" : "session/new",
          resumeSessionId
            ? { sessionId: resumeSessionId }
            : {
                cwd: input.cwd ?? serverConfig.cwd,
                mode: "agent",
                mcpServers: [],
              },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        )) as { readonly sessionId?: unknown };
        const sessionId =
          asString(sessionResult?.sessionId) ?? resumeSessionId ?? `cursor-session:${randomUUID()}`;

        updateSession(context, {
          status: "ready",
          ...((input.cwd ?? serverConfig.cwd) ? { cwd: input.cwd ?? serverConfig.cwd } : {}),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          resumeCursor: {
            sessionId,
          } satisfies CursorResumeCursor,
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
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterProcessError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
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
            issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cursor ACP image attachments are not implemented yet.",
          });
        }
        if (context.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Cursor session already has an active turn.",
          });
        }
        const sessionId = readResumeSessionId(context.session.resumeCursor);
        if (!sessionId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Cursor session is missing a resumable session id.",
          });
        }

        const turnId = TurnId.makeUnsafe(`cursor-turn:${randomUUID()}`);
        const activeTurn: TurnSnapshot = {
          id: turnId,
          items: [],
          assistantText: "",
        };
        context.activeTurn = activeTurn;
        updateSession(context, {
          status: "running",
          activeTurnId: turnId,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        });
        emit({
          ...baseEvent(context, { turnId }),
          type: "turn.started",
          payload: {
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(input.interactionMode === "plan" ? { effort: "plan" } : {}),
          },
        });

        void context.client
          .request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.input ?? "" }],
          })
          .then((result) => {
            const record = asObject(result);
            settleTurn(context, turnId, {
              type: "completed",
              stopReason: asString(record?.stopReason) ?? null,
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
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise(async () => {
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
        const sessionId = readResumeSessionId(context.session.resumeCursor);
        if (!sessionId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/cancel",
            detail: "Cursor session is missing a resumable session id.",
          });
        }
        await context.client.request(
          "session/cancel",
          { sessionId },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        );
        settleTurn(context, context.activeTurn.id, {
          type: "aborted",
          reason: "Turn cancelled",
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/cancel",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise(async () => {
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
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "selected",
            optionId: toDecisionOptionId(decision),
          },
        });
        emit({
          ...baseEvent(context, {
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId,
          }),
          type: "request.resolved",
          payload: {
            requestType: "command_execution_approval",
            decision,
            resolution: {
              optionId: toDecisionOptionId(decision),
            },
          },
        });
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise(async () => {
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
            const label = typeof answer === "string" ? answer : "";
            const optionId = pending.optionIdsByQuestionAndLabel.get(question.id)?.get(label);
            return {
              questionId: question.id,
              selectedOptionIds: optionId ? [optionId] : [],
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
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToUserInput",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise(async () => {
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
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause)
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

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
