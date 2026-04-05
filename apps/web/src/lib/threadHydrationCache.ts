import { type OrchestrationReadModel, type ThreadId } from "@ace/contracts";
import { DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB } from "@ace/contracts/settings";

import { ensureNativeApi } from "../nativeApi";
import { runAsyncTask } from "./async";
import { LRUCache } from "./lruCache";

type HydratedReadModelThread = OrchestrationReadModel["threads"][number];

interface HydratedThreadCacheEntry {
  readonly updatedAt: string;
  readonly thread: HydratedReadModelThread;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_MAX_CACHED_THREADS = 256;
const DEFAULT_CACHE_MEMORY_BYTES = DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB * BYTES_PER_MEGABYTE;

export interface ThreadHydrationCacheConfig {
  readonly maxEntries?: number;
  readonly maxMemoryBytes?: number;
}

interface ResolvedThreadHydrationCacheConfig {
  readonly maxEntries: number;
  readonly maxMemoryBytes: number;
}

function estimateHydratedThreadSize(thread: HydratedReadModelThread): number {
  return (
    512 +
    thread.title.length * 2 +
    thread.messages.reduce(
      (size, message) =>
        size + 192 + message.text.length * 2 + (message.attachments?.length ?? 0) * 256,
      0,
    ) +
    thread.activities.reduce((size, activity) => size + 160 + activity.summary.length * 2, 0) +
    thread.proposedPlans.reduce((size, plan) => size + 160 + plan.planMarkdown.length * 2, 0) +
    thread.checkpoints.length * 192
  );
}

function findReadModelThread(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): HydratedReadModelThread {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new Error(`Thread ${threadId} is unavailable.`);
  }
  return thread;
}

function resolveThreadHydrationCacheConfig(
  config?: ThreadHydrationCacheConfig,
): ResolvedThreadHydrationCacheConfig {
  const maxEntries = Math.max(1, Math.trunc(config?.maxEntries ?? DEFAULT_MAX_CACHED_THREADS));
  const maxMemoryBytes = Math.max(
    BYTES_PER_MEGABYTE,
    Math.trunc(config?.maxMemoryBytes ?? DEFAULT_CACHE_MEMORY_BYTES),
  );
  return {
    maxEntries,
    maxMemoryBytes,
  };
}

export interface ThreadHydrationCache {
  readonly read: (
    threadId: ThreadId,
    expectedUpdatedAt?: string | null,
  ) => HydratedReadModelThread | null;
  readonly prime: (thread: HydratedReadModelThread) => HydratedReadModelThread;
  readonly hydrate: (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ) => Promise<HydratedReadModelThread>;
  readonly prefetch: (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ) => void;
  readonly clear: () => void;
}

export function createThreadHydrationCache(
  fetchThread: (threadId: ThreadId) => Promise<HydratedReadModelThread>,
  config?: ThreadHydrationCacheConfig,
): ThreadHydrationCache {
  const resolvedConfig = resolveThreadHydrationCacheConfig(config);
  const cache = new LRUCache<HydratedThreadCacheEntry>(
    resolvedConfig.maxEntries,
    resolvedConfig.maxMemoryBytes,
  );
  const inFlightByThreadId = new Map<ThreadId, Promise<HydratedReadModelThread>>();

  const read = (
    threadId: ThreadId,
    expectedUpdatedAt?: string | null,
  ): HydratedReadModelThread | null => {
    const cached = cache.get(threadId);
    if (!cached) {
      return null;
    }
    if (
      expectedUpdatedAt !== undefined &&
      expectedUpdatedAt !== null &&
      cached.updatedAt !== expectedUpdatedAt
    ) {
      return null;
    }
    return cached.thread;
  };

  const prime = (thread: HydratedReadModelThread): HydratedReadModelThread => {
    cache.set(
      thread.id,
      {
        updatedAt: thread.updatedAt,
        thread,
      },
      estimateHydratedThreadSize(thread),
    );
    return thread;
  };

  const hydrate = async (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ): Promise<HydratedReadModelThread> => {
    const cached = read(threadId, options?.expectedUpdatedAt);
    if (cached) {
      return cached;
    }

    const existing = inFlightByThreadId.get(threadId);
    if (existing) {
      return existing;
    }

    const request = fetchThread(threadId)
      .then((thread) => prime(thread))
      .finally(() => {
        if (inFlightByThreadId.get(threadId) === request) {
          inFlightByThreadId.delete(threadId);
        }
      });
    inFlightByThreadId.set(threadId, request);
    return request;
  };

  const prefetch = (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ): void => {
    runAsyncTask(hydrate(threadId, options), "Failed to prefetch hydrated thread data.");
  };

  const clear = () => {
    inFlightByThreadId.clear();
    cache.clear();
  };

  return {
    read,
    prime,
    hydrate,
    prefetch,
    clear,
  };
}

function createSharedThreadHydrationCache(
  config?: ThreadHydrationCacheConfig,
): ThreadHydrationCache {
  return createThreadHydrationCache(async (threadId) => {
    const snapshot = await ensureNativeApi().orchestration.getSnapshot({
      hydrateThreadId: threadId,
    });
    return findReadModelThread(snapshot, threadId);
  }, config);
}

let sharedThreadHydrationCacheConfig = resolveThreadHydrationCacheConfig();
let sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);

export function configureThreadHydrationCache(config?: ThreadHydrationCacheConfig): void {
  const nextConfig = resolveThreadHydrationCacheConfig(config);
  if (
    nextConfig.maxEntries === sharedThreadHydrationCacheConfig.maxEntries &&
    nextConfig.maxMemoryBytes === sharedThreadHydrationCacheConfig.maxMemoryBytes
  ) {
    return;
  }

  sharedThreadHydrationCacheConfig = nextConfig;
  sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);
}

export function readCachedHydratedThread(
  threadId: ThreadId,
  expectedUpdatedAt?: string | null,
): HydratedReadModelThread | null {
  return sharedThreadHydrationCache.read(threadId, expectedUpdatedAt);
}

export function primeHydratedThreadCache(thread: HydratedReadModelThread): HydratedReadModelThread {
  return sharedThreadHydrationCache.prime(thread);
}

export function hydrateThreadFromCache(
  threadId: ThreadId,
  options?: { readonly expectedUpdatedAt?: string | null },
): Promise<HydratedReadModelThread> {
  return sharedThreadHydrationCache.hydrate(threadId, options);
}

export function prefetchHydratedThread(
  threadId: ThreadId,
  options?: { readonly expectedUpdatedAt?: string | null },
): void {
  sharedThreadHydrationCache.prefetch(threadId, options);
}

export function __resetThreadHydrationCacheForTests(): void {
  sharedThreadHydrationCacheConfig = resolveThreadHydrationCacheConfig();
  sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);
}
