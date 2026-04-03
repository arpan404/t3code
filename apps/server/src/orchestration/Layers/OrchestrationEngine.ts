import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import { Deferred, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
}

const ORCHESTRATION_ENGINE_WORKER_COUNT = Math.max(
  1,
  Number.parseInt(process.env.T3CODE_ORCHESTRATION_WORKERS ?? "8", 10) || 8,
);
const ORCHESTRATION_ENGINE_QUEUE_CAPACITY = Math.max(
  64,
  Number.parseInt(process.env.T3CODE_ORCHESTRATION_QUEUE_CAPACITY ?? "10000", 10) || 10_000,
);
const ORCHESTRATION_ENGINE_PARTITION_QUEUE_CAPACITY = Math.max(
  64,
  Math.ceil(ORCHESTRATION_ENGINE_QUEUE_CAPACITY / ORCHESTRATION_ENGINE_WORKER_COUNT),
);

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

function commandThreadId(command: OrchestrationCommand): ThreadId | null {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
    case "thread.create":
      return null;
    default:
      return command.threadId;
  }
}

function commandPartitionKey(command: OrchestrationCommand): string {
  if (command.type === "project.create" || command.type === "project.meta.update") {
    return `project:${command.projectId}`;
  }
  if (command.type === "project.delete" || command.type === "thread.create") {
    return `project:${command.projectId}`;
  }
  const threadId = commandThreadId(command);
  if (threadId === null) {
    return "shared";
  }
  return `thread:${threadId}`;
}

function partitionIndexForCommand(command: OrchestrationCommand, workerCount: number): number {
  const key = commandPartitionKey(command);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % workerCount;
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  let readModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.bounded<CommandEnvelope>(ORCHESTRATION_ENGINE_QUEUE_CAPACITY);
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  const readModelReconcileSemaphore = yield* Semaphore.make(1);
  const queueByPartition = yield* Effect.forEach(
    Array.from({ length: ORCHESTRATION_ENGINE_WORKER_COUNT }, () => null),
    () => Queue.bounded<CommandEnvelope>(ORCHESTRATION_ENGINE_PARTITION_QUEUE_CAPACITY),
  );

  const reconcilePersistedReadModel = readModelReconcileSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(readModel.snapshotSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      for (const persistedEvent of persistedEvents) {
        readModel = yield* projectEvent(readModel, persistedEvent);
      }

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    }),
  );

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    return Effect.gen(function* () {
      yield* reconcilePersistedReadModel;

      const existingReceipt = yield* commandReceiptRepository.getByCommandId({
        commandId: envelope.command.commandId,
      });
      if (Option.isSome(existingReceipt)) {
        if (existingReceipt.value.status === "accepted") {
          yield* Deferred.succeed(envelope.result, {
            sequence: existingReceipt.value.resultSequence,
          });
          return;
        }
        yield* Deferred.fail(
          envelope.result,
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          }),
        );
        return;
      }

      const eventBase = yield* decideOrchestrationCommand({
        command: envelope.command,
        readModel,
      });
      const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
      const committedCommand = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const committedEvents: OrchestrationEvent[] = [];

            for (const nextEvent of eventBases) {
              const savedEvent = yield* eventStore.append(nextEvent);
              yield* projectionPipeline.projectEvent(savedEvent);
              committedEvents.push(savedEvent);
            }

            const lastSavedEvent = committedEvents.at(-1) ?? null;
            if (lastSavedEvent === null) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Command produced no events.",
              });
            }

            yield* commandReceiptRepository.upsert({
              commandId: envelope.command.commandId,
              aggregateKind: lastSavedEvent.aggregateKind,
              aggregateId: lastSavedEvent.aggregateId,
              acceptedAt: lastSavedEvent.occurredAt,
              resultSequence: lastSavedEvent.sequence,
              status: "accepted",
              error: null,
            });

            return {
              committedEvents,
              lastSequence: lastSavedEvent.sequence,
            } as const;
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (sqlError) =>
            Effect.fail(
              toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
            ),
          ),
        );

      yield* reconcilePersistedReadModel;
      yield* Deferred.succeed(envelope.result, { sequence: committedCommand.lastSequence });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* reconcilePersistedReadModel.pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "failed to reconcile orchestration read model after dispatch failure",
              ).pipe(
                Effect.annotateLogs({
                  commandId: envelope.command.commandId,
                  snapshotSequence: readModel.snapshotSequence,
                }),
              ),
            ),
          );

          if (Schema.is(OrchestrationCommandInvariantError)(error)) {
            const aggregateRef = commandToAggregateRef(envelope.command);
            yield* commandReceiptRepository
              .upsert({
                commandId: envelope.command.commandId,
                aggregateKind: aggregateRef.aggregateKind,
                aggregateId: aggregateRef.aggregateId,
                acceptedAt: new Date().toISOString(),
                resultSequence: readModel.snapshotSequence,
                status: "rejected",
                error: error.message,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  readModel = yield* projectionSnapshotQuery.getSnapshot();

  const fanoutWorker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        Queue.offer(
          queueByPartition[
            partitionIndexForCommand(envelope.command, ORCHESTRATION_ENGINE_WORKER_COUNT)
          ]!,
          envelope,
        ),
      ),
    ),
  );
  yield* Effect.forkScoped(fanoutWorker);
  yield* Effect.forEach(
    queueByPartition,
    (partitionQueue) =>
      Effect.forever(Queue.take(partitionQueue).pipe(Effect.flatMap(processEnvelope))).pipe(
        Effect.forkScoped,
      ),
    { concurrency: "unbounded" },
  );
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({
      sequence: readModel.snapshotSequence,
      workers: ORCHESTRATION_ENGINE_WORKER_COUNT,
      queueCapacity: ORCHESTRATION_ENGINE_QUEUE_CAPACITY,
      partitionQueueCapacity: ORCHESTRATION_ENGINE_PARTITION_QUEUE_CAPACITY,
    }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): OrchestrationReadModel => readModel);

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
