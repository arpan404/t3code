import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  hydrateThreadFromReadModel,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    sidebarThreadsById: {},
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelFromThreads(
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [...threads],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it.each([
    ["gemini", "gemini-2.5-pro"],
    ["opencode", "auto"],
  ] as const)("preserves %s session providers from the read model", (providerName, model) => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: providerName,
          model,
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.session?.provider).toBe(providerName);
    expect(next.threads[0]?.modelSelection.model).toBe(model);
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("maps queued composer state from the read model", () => {
    const initialState = makeState(makeThread());
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          queuedComposerMessages: [
            {
              id: MessageId.makeUnsafe("queued-message-1"),
              prompt: "Follow up after the current run",
              images: [
                {
                  type: "image",
                  id: "queued-image-1" as never,
                  name: "diagram.png",
                  mimeType: "image/png",
                  sizeBytes: 12,
                  dataUrl: "data:image/png;base64,AA==",
                },
              ],
              terminalContexts: [],
              modelSelection: {
                provider: "codex",
                model: "gpt-5.3-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          ],
          queuedSteerRequest: {
            messageId: MessageId.makeUnsafe("queued-message-1"),
            baselineWorkLogEntryCount: 4,
            interruptRequested: false,
          },
        }),
      ),
    );

    expect(next.threads[0]?.queuedComposerMessages).toEqual([
      {
        id: MessageId.makeUnsafe("queued-message-1"),
        prompt: "Follow up after the current run",
        images: [
          {
            type: "image",
            id: "queued-image-1",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 12,
            dataUrl: "data:image/png;base64,AA==",
            previewUrl: "data:image/png;base64,AA==",
          },
        ],
        terminalContexts: [],
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    expect(next.threads[0]?.queuedSteerRequest).toEqual({
      messageId: MessageId.makeUnsafe("queued-message-1"),
      baselineWorkLogEntryCount: 4,
      interruptRequested: false,
    });
  });

  it("marks only the requested thread as history-loaded during lean snapshot sync", () => {
    const initialState = makeState(makeThread());
    const firstThreadId = ThreadId.makeUnsafe("thread-1");
    const secondThreadId = ThreadId.makeUnsafe("thread-2");
    const readModel = makeReadModelFromThreads([
      makeReadModelThread({
        id: firstThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
        ],
      }),
      makeReadModelThread({
        id: secondThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-2"),
            role: "user",
            text: "Second",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:01:00.000Z",
            updatedAt: "2026-02-27T00:01:00.000Z",
          },
        ],
      }),
    ]);

    const next = syncServerReadModel(initialState, readModel, {
      hydrateThreadId: firstThreadId,
    });

    expect(next.threads.find((thread) => thread.id === firstThreadId)?.historyLoaded).toBe(true);
    expect(next.threads.find((thread) => thread.id === secondThreadId)?.historyLoaded).toBe(false);
  });

  it("hydrates an individual thread from a later snapshot without replacing the rest of the store", () => {
    const targetThreadId = ThreadId.makeUnsafe("thread-1");
    const initialState = syncServerReadModel(
      makeState(makeThread({ id: targetThreadId })),
      makeReadModel(
        makeReadModelThread({
          id: targetThreadId,
          messages: [
            {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "Short summary",
              turnId: null,
              streaming: false,
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
            },
          ],
        }),
      ),
      { hydrateThreadId: null },
    );

    const next = hydrateThreadFromReadModel(
      initialState,
      makeReadModelThread({
        id: targetThreadId,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Short summary",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("message-2"),
            role: "assistant",
            text: "Full thread body",
            turnId: null,
            streaming: false,
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: "2026-02-27T00:00:01.000Z",
          },
        ],
      }),
    );

    expect(next.threads[0]?.historyLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("message-1"),
      MessageId.makeUnsafe("message-2"),
    ]);
  });

  it("derives sidebar proposed-plan state from latestProposedPlanSummary for lean threads", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(makeThread({ id: threadId }));
    const readModel = makeReadModel(
      makeReadModelThread({
        id: threadId,
        interactionMode: "plan",
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:01.000Z",
          assistantMessageId: MessageId.makeUnsafe("message-1"),
        },
        proposedPlans: [],
        latestProposedPlanSummary: {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel, {
      hydrateThreadId: null,
    });

    expect(next.threads[0]?.historyLoaded).toBe(false);
    expect(next.threads[0]?.proposedPlans).toEqual([]);
    expect(next.sidebarThreadsById[threadId]?.hasActionableProposedPlan).toBe(true);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.text).toBe("hello world");
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[1]).toBe(thread2);
  });

  it("prefers payload sequence for assistant messages when provided", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-sequenced"),
          role: "assistant",
          text: "sequenced",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          sequence: 1_706_255_202_000_001,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
        { sequence: 3 },
      ),
    );

    expect(next.threads[0]?.messages[0]?.sequence).toBe(1_706_255_202_000_001);
  });

  it("keeps lean thread plan bodies unloaded while refreshing the latest plan summary", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: "2026-02-27T00:00:01.000Z",
        assistantMessageId: MessageId.makeUnsafe("message-1"),
      },
      historyLoaded: false,
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.proposed-plan-upserted", {
        threadId: thread.id,
        proposedPlan: {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.threads[0]?.proposedPlans).toEqual([]);
    expect(next.threads[0]?.latestProposedPlanSummary).toEqual({
      id: "plan-1",
      turnId: TurnId.makeUnsafe("turn-1"),
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:01.000Z",
    });
    expect(next.sidebarThreadsById[thread.id]?.hasActionableProposedPlan).toBe(true);
  });

  it("orders appended activities by createdAt when legacy entries are missing sequence", () => {
    const thread = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("legacy-activity"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Legacy activity",
          payload: {},
          turnId: null,
          createdAt: "2026-02-27T00:00:02.000Z",
        },
      ],
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("sequenced-activity"),
          tone: "tool",
          kind: "tool.started",
          summary: "Sequenced activity",
          payload: {},
          turnId: null,
          sequence: 1,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "sequenced-activity",
      "legacy-activity",
    ]);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toEqual(state.threads[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threads[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });

  it("compacts repeated reasoning activity so verbose turns keep earlier tool history visible", () => {
    const thread = makeThread();
    let state = makeState(thread);

    state = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-appended", {
        threadId: thread.id,
        activity: {
          id: EventId.makeUnsafe("tool-history"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Read file",
          payload: { detail: "packages/contracts/src/model.ts" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-03-05T10:00:00.500Z",
        },
      }),
    );

    for (let index = 0; index < 750; index += 1) {
      const fraction = String(index).padStart(3, "0");
      state = applyOrchestrationEvent(
        state,
        makeEvent(
          "thread.activity-appended",
          {
            threadId: thread.id,
            activity: {
              id: EventId.makeUnsafe(`reasoning-${fraction}`),
              tone: "info",
              kind: index === 749 ? "reasoning.completed" : "task.progress",
              summary: "Reasoning",
              payload: {
                taskId: "copilot-task-1",
                detail: `thought-${fraction}`,
              },
              turnId: TurnId.makeUnsafe("turn-1"),
              sequence: index + 1,
              createdAt: `2026-03-05T10:00:${String((index % 60) + 1).padStart(2, "0")}.000Z`,
            },
          },
          {
            sequence: index + 2,
            eventId: EventId.makeUnsafe(`event-reasoning-${fraction}`),
          },
        ),
      );
    }

    expect(state.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("tool-history"),
      EventId.makeUnsafe("reasoning-749"),
    ]);
    expect(
      (state.threads[0]?.activities[1]?.payload as { detail?: string } | undefined)?.detail,
    ).toContain("thought-000");
    expect(
      (state.threads[0]?.activities[1]?.payload as { detail?: string } | undefined)?.detail,
    ).toContain("thought-749");
  });
});
