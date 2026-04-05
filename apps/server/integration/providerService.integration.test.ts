import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Queue, Stream } from "effect";

import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../src/provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { ProjectionThreadMessageRepositoryLive } from "../src/persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../src/persistence/Services/ProjectionThreadMessages.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
  type TestTurnResponse,
} from "./TestProviderAdapter.integration.ts";
import {
  codexTurnApprovalFixture,
  codexTurnToolFixture,
  codexTurnTextFixture,
} from "./fixtures/providerRuntime.ts";

const makeWorkspaceDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory();
  yield* fs.writeFileString(pathService.join(cwd, "README.md"), "v1\n");
  return cwd;
}).pipe(Effect.provide(NodeServices.layer));

interface IntegrationFixture {
  readonly cwd: string;
  readonly harness: TestProviderAdapterHarness;
  readonly layer: Layer.Layer<ProviderService | ProjectionThreadMessageRepository, unknown, never>;
}

const makeIntegrationFixture = (provider: "codex" | "githubCopilot" = "codex") =>
  Effect.gen(function* () {
    const cwd = yield* makeWorkspaceDirectory;
    const harness = yield* makeTestProviderAdapterHarness({ provider });

    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === harness.provider
          ? Effect.succeed(harness.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed([harness.provider]),
    };

    const directoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const projectionMessageRepositoryLayer = ProjectionThreadMessageRepositoryLive;

    const shared = Layer.mergeAll(
      directoryLayer,
      projectionMessageRepositoryLayer,
      Layer.succeed(ProviderAdapterRegistry, registry),
      ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS),
      AnalyticsService.layerTest,
    ).pipe(Layer.provide(SqlitePersistenceMemory));

    const layer = Layer.mergeAll(shared, makeProviderServiceLive().pipe(Layer.provide(shared)));

    return {
      cwd,
      harness,
      layer,
    } satisfies IntegrationFixture;
  });

const collectEventsDuring = <A, E, R>(
  stream: Stream.Stream<ProviderRuntimeEvent>,
  count: number,
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(stream, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
      Effect.forkScoped,
    );

    yield* action;

    return yield* Effect.forEach(
      Array.from({ length: count }, () => undefined),
      () => Queue.take(queue),
      { discard: false },
    );
  });

const runTurn = (input: {
  readonly provider: ProviderServiceShape;
  readonly harness: TestProviderAdapterHarness;
  readonly threadId: ThreadId;
  readonly userText: string;
  readonly response: TestTurnResponse;
}) =>
  Effect.gen(function* () {
    yield* input.harness.queueTurnResponse(input.threadId, input.response);

    return yield* collectEventsDuring(
      input.provider.streamEvents,
      input.response.events.length,
      input.provider.sendTurn({
        threadId: input.threadId,
        input: input.userText,
        attachments: [],
      }),
    );
  });

it.effect("replays typed runtime fixture events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-typed"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-typed"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "hello",
        response: { events: codexTurnTextFixture },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnTextFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replays file-changing fixture turn events", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-tools"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-tools"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const observedEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "make a small change",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      assert.deepEqual(
        observedEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("runs multi-turn tool/approval flow", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-multi"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-multi"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      const firstTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        firstTurnEvents.map((event) => event.type),
        codexTurnToolFixture.map((event) => event.type),
      );

      const secondTurnEvents = yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });
      assert.deepEqual(
        secondTurnEvents.map((event) => event.type),
        codexTurnApprovalFixture.map((event) => event.type),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back provider conversation state only", () =>
  Effect.gen(function* () {
    const fixture = yield* makeIntegrationFixture();
    const { join } = yield* Path.Path;
    const { writeFileString, readFileString } = yield* FileSystem.FileSystem;

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(
        ThreadId.makeUnsafe("thread-integration-rollback"),
        {
          threadId: ThreadId.makeUnsafe("thread-integration-rollback"),
          provider: "codex",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        },
      );
      assert.equal((session.threadId ?? "").length > 0, true);

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 1",
        response: {
          events: codexTurnToolFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v2\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* runTurn({
        provider,
        harness: fixture.harness,
        threadId: session.threadId,
        userText: "turn 2 approval",
        response: {
          events: codexTurnApprovalFixture,
          mutateWorkspace: ({ cwd }) =>
            writeFileString(join(cwd, "README.md"), "v3\n").pipe(Effect.asVoid, Effect.ignore),
        },
      });

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });

      const rollbackCalls = fixture.harness.getRollbackCalls(session.threadId);
      assert.deepEqual(rollbackCalls, [1]);

      const readme = yield* readFileString(join(fixture.cwd, "README.md"));
      assert.equal(readme, "v3\n");
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rebuilds githubCopilot recovery from retained transcript after rollback and provider restart",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeIntegrationFixture("githubCopilot");

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const messages = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.makeUnsafe("thread-integration-github-copilot-recovery");
        const createdAt = "2026-04-05T12:00:00.000Z";

        const session = yield* provider.startSession(threadId, {
          threadId,
          provider: "githubCopilot",
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });
        assert.equal((session.threadId ?? "").length > 0, true);

        yield* fixture.harness.queueTurnResponse(threadId, {
          events: [
            {
              type: "turn.started",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-1"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-1",
            },
            {
              type: "message.delta",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-2"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-1",
              delta: "First answer\n",
            },
            {
              type: "turn.completed",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-3"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-1",
              status: "completed",
            },
          ],
        });

        yield* provider.sendTurn({
          threadId,
          input: "First prompt",
          attachments: [],
        });

        yield* fixture.harness.queueTurnResponse(threadId, {
          events: [
            {
              type: "turn.started",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-4"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-2",
            },
            {
              type: "message.delta",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-5"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-2",
              delta: "Second answer\n",
            },
            {
              type: "turn.completed",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-6"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-2",
              status: "completed",
            },
          ],
        });

        yield* provider.sendTurn({
          threadId,
          input: "Second prompt",
          attachments: [],
        });

        yield* provider.rollbackConversation({
          threadId,
          numTurns: 1,
        });
        assert.deepEqual(fixture.harness.getRollbackCalls(threadId), [1]);

        yield* messages.deleteByThreadId({ threadId });
        yield* messages.upsert({
          messageId: MessageId.makeUnsafe("user-github-copilot-recovery-1"),
          threadId,
          turnId: TurnId.makeUnsafe("turn-github-copilot-recovery-1"),
          role: "user",
          text: "First prompt",
          attachments: [],
          isStreaming: false,
          sequence: 1,
          createdAt,
          updatedAt: createdAt,
        });
        yield* messages.upsert({
          messageId: MessageId.makeUnsafe("assistant-github-copilot-recovery-1"),
          threadId,
          turnId: TurnId.makeUnsafe("turn-github-copilot-recovery-1"),
          role: "assistant",
          text: "First answer\n",
          isStreaming: false,
          sequence: 2,
          createdAt,
          updatedAt: createdAt,
        });

        const startInputsBeforeRecovery = fixture.harness.getStartInputs().length;
        yield* fixture.harness.adapter.stopAll();
        assert.deepEqual(fixture.harness.listActiveSessionIds(), []);

        yield* fixture.harness.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-7"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-3",
            },
            {
              type: "message.delta",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-8"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-3",
              delta: "Recovered answer\n",
            },
            {
              type: "turn.completed",
              eventId: EventId.makeUnsafe("evt-copilot-provider-recovery-9"),
              provider: "githubCopilot",
              createdAt,
              threadId,
              turnId: "fixture-turn-3",
              status: "completed",
            },
          ],
        });

        yield* provider.sendTurn({
          threadId,
          input: "After rollback",
          attachments: [],
        });

        const startInputs = fixture.harness.getStartInputs();
        assert.equal(startInputs.length > startInputsBeforeRecovery, true);
        const recoveryStartInput = startInputs[startInputs.length - 1];
        assert.equal(recoveryStartInput?.provider, "githubCopilot");
        assert.equal(recoveryStartInput?.resumeCursor, undefined);
        assert.deepEqual(recoveryStartInput?.replayTurns, [
          {
            prompt: "First prompt",
            attachmentNames: [],
            assistantResponse: "First answer",
          },
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
