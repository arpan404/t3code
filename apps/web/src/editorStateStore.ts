import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizePaneRatios } from "./lib/paneRatios";
import { resolveStorage } from "./lib/storage";

interface EditorDraftState {
  draftContents: string;
  savedContents: string;
}

interface RecentlyClosedEditorEntry {
  filePath: string;
  paneId: string;
  targetIndex: number;
}

export interface ThreadEditorPaneState {
  activeFilePath: string | null;
  id: string;
  openFilePaths: string[];
}

interface PersistedThreadEditorState {
  activePaneId: string;
  expandedDirectoryPaths: string[];
  paneRatios: number[];
  panes: ThreadEditorPaneState[];
  treeWidth: number;
}

interface LegacyPersistedThreadEditorState {
  activeFilePath: string | null;
  expandedDirectoryPaths: string[];
  openFilePaths: string[];
  treeWidth: number;
}

interface RuntimeThreadEditorState {
  draftsByFilePath: Record<string, EditorDraftState>;
  recentlyClosedEntries: RecentlyClosedEditorEntry[];
}

interface PersistedEditorStoreSnapshot {
  threadStateByThreadId?: Record<
    string,
    PersistedThreadEditorState | LegacyPersistedThreadEditorState
  >;
}

interface EditorStoreState {
  closeFile: (threadId: ThreadId, filePath: string, paneId?: string) => void;
  closeFilesToRight: (threadId: ThreadId, filePath: string, paneId?: string) => void;
  closeOtherFiles: (threadId: ThreadId, filePath: string, paneId?: string) => void;
  closePane: (threadId: ThreadId, paneId: string) => void;
  discardDraft: (threadId: ThreadId, filePath: string) => void;
  expandDirectories: (threadId: ThreadId, directoryPaths: readonly string[]) => void;
  hydrateFile: (threadId: ThreadId, filePath: string, contents: string) => void;
  isDirty: (threadId: ThreadId, filePath: string) => boolean;
  markFileSaved: (threadId: ThreadId, filePath: string, contents: string) => void;
  moveFile: (
    threadId: ThreadId,
    input: {
      filePath: string;
      sourcePaneId: string;
      targetPaneId: string;
      targetIndex?: number;
    },
  ) => void;
  openFile: (threadId: ThreadId, filePath: string, paneId?: string) => void;
  removeEntry: (threadId: ThreadId, relativePath: string) => void;
  renameEntry: (threadId: ThreadId, previousPath: string, nextPath: string) => void;
  reopenClosedFile: (threadId: ThreadId, paneId?: string) => string | null;
  runtimeStateByThreadId: Record<string, RuntimeThreadEditorState>;
  setActiveFile: (threadId: ThreadId, filePath: string | null, paneId?: string) => void;
  setActivePane: (threadId: ThreadId, paneId: string) => void;
  setPaneRatios: (threadId: ThreadId, ratios: readonly number[]) => void;
  setTreeWidth: (threadId: ThreadId, width: number) => void;
  splitPane: (
    threadId: ThreadId,
    options?: { filePath?: string | null; sourcePaneId?: string },
  ) => string | null;
  syncTree: (threadId: ThreadId, validPaths: readonly string[]) => void;
  threadStateByThreadId: Record<string, PersistedThreadEditorState>;
  toggleDirectory: (threadId: ThreadId, directoryPath: string) => void;
  updateDraft: (threadId: ThreadId, filePath: string, draftContents: string) => void;
}

export interface ThreadEditorState extends PersistedThreadEditorState {
  draftsByFilePath: Record<string, EditorDraftState>;
}

interface ThreadEditorStateCacheEntry {
  editorState: ThreadEditorState;
  persistedThreadStateInput: PersistedThreadEditorState | undefined;
  runtimeThreadStateInput: RuntimeThreadEditorState | undefined;
}

const STORAGE_KEY = "t3code:editor-state:v1";
export const DEFAULT_THREAD_EDITOR_TREE_WIDTH = 280;
const MIN_TREE_WIDTH = 220;
const MAX_TREE_WIDTH = 420;
const DEFAULT_THREAD_EDITOR_PANE_ID = "pane-1";
export const MAX_THREAD_EDITOR_PANES = 4;
const MAX_RECENTLY_CLOSED_EDITOR_ENTRIES = 32;
const DEFAULT_THREAD_EDITOR_STATE = createDefaultThreadEditorState();
const DEFAULT_RUNTIME_THREAD_EDITOR_STATE = createDefaultRuntimeThreadEditorState();
const threadEditorStateCache = new Map<ThreadId, ThreadEditorStateCacheEntry>();

function normalizePathList(paths: readonly string[]): string[] {
  const unique: string[] = [];
  for (const path of paths) {
    const normalized = path.trim();
    if (normalized.length === 0 || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }
  return unique;
}

function normalizeTreeWidth(width: number | null | undefined): number {
  const safeWidth = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : 0;
  if (safeWidth === 0) {
    return DEFAULT_THREAD_EDITOR_TREE_WIDTH;
  }
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, safeWidth));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function numberArraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function paneArraysEqual(
  left: readonly ThreadEditorPaneState[],
  right: readonly ThreadEditorPaneState[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (pane, index) =>
        pane.id === right[index]?.id &&
        pane.activeFilePath === right[index]?.activeFilePath &&
        stringArraysEqual(pane.openFilePaths, right[index]?.openFilePaths ?? []),
    )
  );
}

function draftMapsEqual(
  left: Record<string, EditorDraftState>,
  right: Record<string, EditorDraftState>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [path, draft] of leftEntries) {
    const other = right[path];
    if (!other) {
      return false;
    }
    if (
      other.draftContents !== draft.draftContents ||
      other.savedContents !== draft.savedContents
    ) {
      return false;
    }
  }
  return true;
}

function recentlyClosedEntriesEqual(
  left: readonly RecentlyClosedEditorEntry[],
  right: readonly RecentlyClosedEditorEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.filePath === right[index]?.filePath &&
        entry.paneId === right[index]?.paneId &&
        entry.targetIndex === right[index]?.targetIndex,
    )
  );
}

function threadStatesEqual(
  left: PersistedThreadEditorState,
  right: PersistedThreadEditorState,
): boolean {
  return (
    left.activePaneId === right.activePaneId &&
    left.treeWidth === right.treeWidth &&
    stringArraysEqual(left.expandedDirectoryPaths, right.expandedDirectoryPaths) &&
    numberArraysEqual(left.paneRatios, right.paneRatios) &&
    paneArraysEqual(left.panes, right.panes)
  );
}

function assignUniquePaneId(baseId: string, usedPaneIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedPaneIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedPaneIds.add(candidate);
  return candidate;
}

function createDefaultPane(id = DEFAULT_THREAD_EDITOR_PANE_ID): ThreadEditorPaneState {
  return {
    activeFilePath: null,
    id,
    openFilePaths: [],
  };
}

function createDefaultThreadEditorState(): PersistedThreadEditorState {
  return {
    activePaneId: DEFAULT_THREAD_EDITOR_PANE_ID,
    expandedDirectoryPaths: [],
    paneRatios: [1],
    panes: [createDefaultPane()],
    treeWidth: DEFAULT_THREAD_EDITOR_TREE_WIDTH,
  };
}

function createDefaultRuntimeThreadEditorState(): RuntimeThreadEditorState {
  return {
    draftsByFilePath: {},
    recentlyClosedEntries: [],
  };
}

function buildRecentlyClosedEntry(
  pane: ThreadEditorPaneState,
  filePath: string,
): RecentlyClosedEditorEntry | null {
  const targetIndex = pane.openFilePaths.indexOf(filePath);
  if (targetIndex < 0) {
    return null;
  }
  return {
    filePath,
    paneId: pane.id,
    targetIndex,
  };
}

function appendRecentlyClosedEntries(
  existingEntries: readonly RecentlyClosedEditorEntry[],
  nextEntries: readonly RecentlyClosedEditorEntry[],
): RecentlyClosedEditorEntry[] {
  if (nextEntries.length === 0) {
    return [...existingEntries];
  }

  const combined = [...existingEntries];
  for (const nextEntry of nextEntries) {
    const duplicateIndex = combined.findIndex(
      (entry) => entry.filePath === nextEntry.filePath && entry.paneId === nextEntry.paneId,
    );
    if (duplicateIndex >= 0) {
      combined.splice(duplicateIndex, 1);
    }
    combined.push({
      filePath: nextEntry.filePath,
      paneId: nextEntry.paneId,
      targetIndex: Math.max(0, Math.trunc(nextEntry.targetIndex)),
    });
  }

  return combined.slice(-MAX_RECENTLY_CLOSED_EDITOR_ENTRIES);
}

function createEditorStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeThreadEditorPanes(
  panes: readonly Partial<ThreadEditorPaneState>[] | null | undefined,
): ThreadEditorPaneState[] {
  const source = Array.isArray(panes) ? panes : [];
  const usedPaneIds = new Set<string>();
  const normalized = source.slice(0, MAX_THREAD_EDITOR_PANES).map((pane, index) => {
    const activeFilePath =
      typeof pane.activeFilePath === "string" ? pane.activeFilePath.trim() : null;
    const nextOpenFilePaths = normalizePathList(pane.openFilePaths ?? []);
    const openFilePaths =
      activeFilePath && !nextOpenFilePaths.includes(activeFilePath)
        ? [...nextOpenFilePaths, activeFilePath]
        : nextOpenFilePaths;
    return {
      activeFilePath: activeFilePath || (openFilePaths.at(-1) ?? null),
      id: assignUniquePaneId(
        typeof pane.id === "string" && pane.id.trim().length > 0
          ? pane.id.trim()
          : `pane-${index + 1}`,
        usedPaneIds,
      ),
      openFilePaths,
    };
  });
  return normalized.length > 0 ? normalized : [createDefaultPane()];
}

function normalizePersistedThreadState(
  threadState: Partial<PersistedThreadEditorState> | null | undefined,
): PersistedThreadEditorState {
  const panes = normalizeThreadEditorPanes(threadState?.panes);
  const activePaneId = panes.some((pane) => pane.id === threadState?.activePaneId)
    ? threadState?.activePaneId
    : panes[0]?.id;
  return {
    activePaneId: activePaneId ?? panes[0]?.id ?? DEFAULT_THREAD_EDITOR_PANE_ID,
    expandedDirectoryPaths: normalizePathList(threadState?.expandedDirectoryPaths ?? []),
    paneRatios: normalizePaneRatios(threadState?.paneRatios ?? [], panes.length),
    panes,
    treeWidth: normalizeTreeWidth(threadState?.treeWidth),
  };
}

function createPersistedThreadStateFromLegacy(
  threadState: LegacyPersistedThreadEditorState | null | undefined,
): PersistedThreadEditorState {
  if (!threadState) {
    return createDefaultThreadEditorState();
  }
  const activeFilePath =
    typeof threadState.activeFilePath === "string" ? threadState.activeFilePath.trim() : null;
  const openFilePaths = normalizePathList(threadState.openFilePaths ?? []);
  return normalizePersistedThreadState({
    activePaneId: DEFAULT_THREAD_EDITOR_PANE_ID,
    expandedDirectoryPaths: threadState.expandedDirectoryPaths,
    paneRatios: [1],
    panes: [
      {
        activeFilePath,
        id: DEFAULT_THREAD_EDITOR_PANE_ID,
        openFilePaths,
      },
    ],
    treeWidth: threadState.treeWidth,
  });
}

function isLegacyThreadState(
  value: PersistedThreadEditorState | LegacyPersistedThreadEditorState | undefined,
): value is LegacyPersistedThreadEditorState {
  return Boolean(value) && typeof value === "object" && !("panes" in value);
}

function getPersistedThreadState(
  stateByThreadId: Record<string, PersistedThreadEditorState>,
  threadId: ThreadId,
): PersistedThreadEditorState {
  const threadState = stateByThreadId[threadId];
  return threadState
    ? normalizePersistedThreadState(threadState)
    : createDefaultThreadEditorState();
}

function getRuntimeThreadState(
  stateByThreadId: Record<string, RuntimeThreadEditorState>,
  threadId: ThreadId,
): RuntimeThreadEditorState {
  return stateByThreadId[threadId] ?? createDefaultRuntimeThreadEditorState();
}

function replacePaneAtIndex(
  panes: readonly ThreadEditorPaneState[],
  paneIndex: number,
  pane: ThreadEditorPaneState,
): ThreadEditorPaneState[] {
  const next = [...panes];
  next[paneIndex] = pane;
  return next;
}

function resolvePaneIndex(
  threadState: PersistedThreadEditorState,
  paneId: string | null | undefined,
): number {
  const preferredPaneId = threadState.panes.some((pane) => pane.id === paneId)
    ? paneId
    : threadState.activePaneId;
  const paneIndex = threadState.panes.findIndex((pane) => pane.id === preferredPaneId);
  return paneIndex >= 0 ? paneIndex : 0;
}

function createNextPaneId(panes: readonly ThreadEditorPaneState[]): string {
  const usedPaneIds = new Set(panes.map((pane) => pane.id));
  return assignUniquePaneId(`pane-${panes.length + 1}`, usedPaneIds);
}

function insertPathAtIndex(paths: readonly string[], path: string, targetIndex?: number): string[] {
  const next = [...paths];
  const normalizedTargetIndex =
    typeof targetIndex === "number" && Number.isFinite(targetIndex)
      ? Math.max(0, Math.min(next.length, Math.trunc(targetIndex)))
      : next.length;
  next.splice(normalizedTargetIndex, 0, path);
  return next;
}

function isPathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function replacePathPrefix(path: string, previousPath: string, nextPath: string): string | null {
  if (!isPathWithinPrefix(path, previousPath)) {
    return null;
  }
  if (path === previousPath) {
    return nextPath;
  }
  return `${nextPath}${path.slice(previousPath.length)}`;
}

function splitPaneRatios(
  paneRatios: readonly number[],
  paneIndex: number,
  nextPaneCount: number,
): number[] {
  const current = normalizePaneRatios(paneRatios, nextPaneCount - 1);
  const targetRatio = current[paneIndex] ?? 1 / nextPaneCount;
  const next = [...current];
  const splitRatio = targetRatio / 2;
  next[paneIndex] = splitRatio;
  next.splice(paneIndex + 1, 0, splitRatio);
  return normalizePaneRatios(next, nextPaneCount);
}

function writeThreadState(
  state: EditorStoreState,
  threadId: ThreadId,
  nextThreadState: PersistedThreadEditorState,
): EditorStoreState {
  return {
    ...state,
    threadStateByThreadId: {
      ...state.threadStateByThreadId,
      [threadId]: nextThreadState,
    },
  };
}

export function selectThreadEditorState(
  threadStateByThreadId: Record<string, PersistedThreadEditorState>,
  runtimeStateByThreadId: Record<string, RuntimeThreadEditorState>,
  threadId: ThreadId,
): ThreadEditorState {
  const persistedThreadStateInput = threadStateByThreadId[threadId];
  const runtimeThreadStateInput = runtimeStateByThreadId[threadId];
  const cachedEditorState = threadEditorStateCache.get(threadId);
  if (
    cachedEditorState &&
    cachedEditorState.persistedThreadStateInput === persistedThreadStateInput &&
    cachedEditorState.runtimeThreadStateInput === runtimeThreadStateInput
  ) {
    return cachedEditorState.editorState;
  }

  const persistedThreadState = persistedThreadStateInput
    ? normalizePersistedThreadState(persistedThreadStateInput)
    : DEFAULT_THREAD_EDITOR_STATE;
  const runtimeThreadState = runtimeThreadStateInput ?? DEFAULT_RUNTIME_THREAD_EDITOR_STATE;
  const editorState = {
    ...persistedThreadState,
    draftsByFilePath: runtimeThreadState.draftsByFilePath,
  };
  threadEditorStateCache.set(threadId, {
    editorState,
    persistedThreadStateInput,
    runtimeThreadStateInput,
  });
  return editorState;
}

export const useEditorStateStore = create<EditorStoreState>()(
  persist(
    (set, get) => ({
      closeFile: (threadId, filePath, paneId) =>
        set((state) => {
          const normalizedPath = filePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const paneIndex = resolvePaneIndex(current, paneId);
          const pane = current.panes[paneIndex];
          if (!pane || !pane.openFilePaths.includes(normalizedPath)) {
            return state;
          }
          const recentlyClosedEntry = buildRecentlyClosedEntry(pane, normalizedPath);
          const nextOpenFilePaths = pane.openFilePaths.filter((path) => path !== normalizedPath);
          const nextThreadState = {
            ...current,
            panes: replacePaneAtIndex(current.panes, paneIndex, {
              ...pane,
              activeFilePath:
                pane.activeFilePath === normalizedPath
                  ? (nextOpenFilePaths.at(-1) ?? null)
                  : pane.activeFilePath,
              openFilePaths: nextOpenFilePaths,
            }),
          };
          if (threadStatesEqual(current, nextThreadState)) {
            return state;
          }

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                recentlyClosedEntries: recentlyClosedEntry
                  ? appendRecentlyClosedEntries(runtime.recentlyClosedEntries, [
                      recentlyClosedEntry,
                    ])
                  : runtime.recentlyClosedEntries,
              },
            },
          };
        }),
      closeFilesToRight: (threadId, filePath, paneId) =>
        set((state) => {
          const normalizedPath = filePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }

          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const paneIndex = resolvePaneIndex(current, paneId);
          const pane = current.panes[paneIndex];
          if (!pane) {
            return state;
          }

          const targetIndex = pane.openFilePaths.indexOf(normalizedPath);
          if (targetIndex < 0 || targetIndex >= pane.openFilePaths.length - 1) {
            return state;
          }

          const closedFilePaths = pane.openFilePaths.slice(targetIndex + 1);
          const nextThreadState = {
            ...current,
            activePaneId: pane.id,
            panes: replacePaneAtIndex(current.panes, paneIndex, {
              ...pane,
              activeFilePath:
                pane.activeFilePath &&
                pane.openFilePaths.indexOf(pane.activeFilePath) <= targetIndex
                  ? pane.activeFilePath
                  : normalizedPath,
              openFilePaths: pane.openFilePaths.slice(0, targetIndex + 1),
            }),
          };
          const recentlyClosedEntries = appendRecentlyClosedEntries(
            runtime.recentlyClosedEntries,
            closedFilePaths
              .toReversed()
              .map((closedFilePath) => buildRecentlyClosedEntry(pane, closedFilePath))
              .filter((entry): entry is RecentlyClosedEditorEntry => entry !== null),
          );

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                recentlyClosedEntries,
              },
            },
          };
        }),
      closeOtherFiles: (threadId, filePath, paneId) =>
        set((state) => {
          const normalizedPath = filePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }

          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const paneIndex = resolvePaneIndex(current, paneId);
          const pane = current.panes[paneIndex];
          if (
            !pane ||
            !pane.openFilePaths.includes(normalizedPath) ||
            pane.openFilePaths.length <= 1
          ) {
            return state;
          }

          const preservedIndex = pane.openFilePaths.indexOf(normalizedPath);
          const leftClosed = pane.openFilePaths.slice(0, preservedIndex);
          const rightClosed = pane.openFilePaths.slice(preservedIndex + 1);
          const nextThreadState = {
            ...current,
            activePaneId: pane.id,
            panes: replacePaneAtIndex(current.panes, paneIndex, {
              ...pane,
              activeFilePath: normalizedPath,
              openFilePaths: [normalizedPath],
            }),
          };
          const recentlyClosedEntries = appendRecentlyClosedEntries(
            runtime.recentlyClosedEntries,
            [...leftClosed, ...rightClosed.toReversed()]
              .map((closedFilePath) => buildRecentlyClosedEntry(pane, closedFilePath))
              .filter((entry): entry is RecentlyClosedEditorEntry => entry !== null),
          );

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                recentlyClosedEntries,
              },
            },
          };
        }),
      closePane: (threadId, paneId) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          if (current.panes.length <= 1) {
            return state;
          }
          const paneIndex = current.panes.findIndex((pane) => pane.id === paneId);
          if (paneIndex < 0) {
            return state;
          }
          const nextPanes = current.panes.filter((pane) => pane.id !== paneId);
          const fallbackPane = nextPanes[paneIndex] ?? nextPanes[paneIndex - 1] ?? nextPanes[0];
          if (!fallbackPane) {
            return state;
          }
          const nextThreadState = normalizePersistedThreadState({
            ...current,
            activePaneId: current.activePaneId === paneId ? fallbackPane.id : current.activePaneId,
            paneRatios: current.paneRatios.filter((_, index) => index !== paneIndex),
            panes: nextPanes,
          });
          return threadStatesEqual(current, nextThreadState)
            ? state
            : writeThreadState(state, threadId, nextThreadState);
        }),
      discardDraft: (threadId, filePath) =>
        set((state) => {
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const draft = runtime.draftsByFilePath[filePath];
          if (!draft || draft.draftContents === draft.savedContents) {
            return state;
          }
          return {
            ...state,
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: {
                  ...runtime.draftsByFilePath,
                  [filePath]: {
                    ...draft,
                    draftContents: draft.savedContents,
                  },
                },
              },
            },
          };
        }),
      expandDirectories: (threadId, directoryPaths) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextDirectoryPaths = normalizePathList([
            ...current.expandedDirectoryPaths,
            ...directoryPaths,
          ]);
          if (stringArraysEqual(current.expandedDirectoryPaths, nextDirectoryPaths)) {
            return state;
          }
          return writeThreadState(state, threadId, {
            ...current,
            expandedDirectoryPaths: nextDirectoryPaths,
          });
        }),
      hydrateFile: (threadId, filePath, contents) =>
        set((state) => {
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const existingDraft = runtime.draftsByFilePath[filePath];
          if (existingDraft) {
            if (existingDraft.draftContents !== existingDraft.savedContents) {
              return state;
            }
            if (
              existingDraft.savedContents === contents &&
              existingDraft.draftContents === contents
            ) {
              return state;
            }
          }

          return {
            ...state,
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: {
                  ...runtime.draftsByFilePath,
                  [filePath]: {
                    draftContents: contents,
                    savedContents: contents,
                  },
                },
              },
            },
          };
        }),
      isDirty: (threadId, filePath) => {
        const runtime = getRuntimeThreadState(get().runtimeStateByThreadId, threadId);
        const draft = runtime.draftsByFilePath[filePath];
        return draft ? draft.draftContents !== draft.savedContents : false;
      },
      markFileSaved: (threadId, filePath, contents) =>
        set((state) => {
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const existingDraft = runtime.draftsByFilePath[filePath];
          if (
            existingDraft &&
            existingDraft.draftContents === contents &&
            existingDraft.savedContents === contents
          ) {
            return state;
          }
          return {
            ...state,
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: {
                  ...runtime.draftsByFilePath,
                  [filePath]: {
                    draftContents: contents,
                    savedContents: contents,
                  },
                },
              },
            },
          };
        }),
      moveFile: (threadId, input) =>
        set((state) => {
          const normalizedPath = input.filePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const sourcePaneIndex = current.panes.findIndex((pane) => pane.id === input.sourcePaneId);
          const targetPaneIndex = current.panes.findIndex((pane) => pane.id === input.targetPaneId);
          if (sourcePaneIndex < 0 || targetPaneIndex < 0) {
            return state;
          }

          const sourcePane = current.panes[sourcePaneIndex];
          const targetPane = current.panes[targetPaneIndex];
          if (!sourcePane || !targetPane || !sourcePane.openFilePaths.includes(normalizedPath)) {
            return state;
          }

          if (sourcePane.id === targetPane.id) {
            const currentIndex = sourcePane.openFilePaths.indexOf(normalizedPath);
            if (currentIndex < 0) {
              return state;
            }
            const nextPaths = sourcePane.openFilePaths.filter((path) => path !== normalizedPath);
            const targetIndex =
              typeof input.targetIndex === "number" && Number.isFinite(input.targetIndex)
                ? Math.max(0, Math.min(nextPaths.length, Math.trunc(input.targetIndex)))
                : nextPaths.length;
            nextPaths.splice(targetIndex, 0, normalizedPath);
            const nextThreadState = {
              ...current,
              activePaneId: sourcePane.id,
              panes: replacePaneAtIndex(current.panes, sourcePaneIndex, {
                ...sourcePane,
                activeFilePath: normalizedPath,
                openFilePaths: nextPaths,
              }),
            };
            return threadStatesEqual(current, nextThreadState)
              ? state
              : writeThreadState(state, threadId, nextThreadState);
          }

          const nextSourcePaths = sourcePane.openFilePaths.filter(
            (path) => path !== normalizedPath,
          );
          const nextTargetPaths = insertPathAtIndex(
            targetPane.openFilePaths.filter((path) => path !== normalizedPath),
            normalizedPath,
            input.targetIndex,
          );
          const sourceFileIndex = sourcePane.openFilePaths.indexOf(normalizedPath);
          const nextSourceActiveFilePath =
            sourcePane.activeFilePath === normalizedPath
              ? (nextSourcePaths.at(Math.min(sourceFileIndex, nextSourcePaths.length - 1)) ?? null)
              : sourcePane.activeFilePath;
          const nextPanes = replacePaneAtIndex(
            replacePaneAtIndex(current.panes, sourcePaneIndex, {
              ...sourcePane,
              activeFilePath: nextSourceActiveFilePath,
              openFilePaths: nextSourcePaths,
            }),
            targetPaneIndex,
            {
              ...targetPane,
              activeFilePath: normalizedPath,
              openFilePaths: nextTargetPaths,
            },
          );
          const nextThreadState = {
            ...current,
            activePaneId: targetPane.id,
            panes: nextPanes,
          };
          return threadStatesEqual(current, nextThreadState)
            ? state
            : writeThreadState(state, threadId, nextThreadState);
        }),
      openFile: (threadId, filePath, paneId) =>
        set((state) => {
          const normalizedPath = filePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const paneIndex = resolvePaneIndex(current, paneId);
          const pane = current.panes[paneIndex];
          if (!pane) {
            return state;
          }
          const nextOpenFilePaths = pane.openFilePaths.includes(normalizedPath)
            ? pane.openFilePaths
            : [...pane.openFilePaths, normalizedPath];
          const nextThreadState = {
            ...current,
            activePaneId: pane.id,
            panes: replacePaneAtIndex(current.panes, paneIndex, {
              ...pane,
              activeFilePath: normalizedPath,
              openFilePaths: nextOpenFilePaths,
            }),
          };
          return threadStatesEqual(current, nextThreadState)
            ? state
            : writeThreadState(state, threadId, nextThreadState);
        }),
      removeEntry: (threadId, relativePath) =>
        set((state) => {
          const normalizedPath = relativePath.trim();
          if (normalizedPath.length === 0) {
            return state;
          }

          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const nextThreadState = normalizePersistedThreadState({
            ...current,
            expandedDirectoryPaths: current.expandedDirectoryPaths.filter(
              (path) => !isPathWithinPrefix(path, normalizedPath),
            ),
            panes: current.panes.map((pane) => {
              const nextOpenFilePaths = pane.openFilePaths.filter(
                (path) => !isPathWithinPrefix(path, normalizedPath),
              );
              return {
                ...pane,
                activeFilePath:
                  pane.activeFilePath && !isPathWithinPrefix(pane.activeFilePath, normalizedPath)
                    ? pane.activeFilePath
                    : (nextOpenFilePaths.at(-1) ?? null),
                openFilePaths: nextOpenFilePaths,
              };
            }),
          });
          const nextDraftsByFilePath = Object.fromEntries(
            Object.entries(runtime.draftsByFilePath).filter(
              ([path]) => !isPathWithinPrefix(path, normalizedPath),
            ),
          );
          const nextRecentlyClosedEntries = runtime.recentlyClosedEntries.filter(
            (entry) => !isPathWithinPrefix(entry.filePath, normalizedPath),
          );

          if (
            threadStatesEqual(current, nextThreadState) &&
            draftMapsEqual(runtime.draftsByFilePath, nextDraftsByFilePath) &&
            recentlyClosedEntriesEqual(runtime.recentlyClosedEntries, nextRecentlyClosedEntries)
          ) {
            return state;
          }

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: nextDraftsByFilePath,
                recentlyClosedEntries: nextRecentlyClosedEntries,
              },
            },
          };
        }),
      renameEntry: (threadId, previousPath, nextPath) =>
        set((state) => {
          const normalizedPreviousPath = previousPath.trim();
          const normalizedNextPath = nextPath.trim();
          if (
            normalizedPreviousPath.length === 0 ||
            normalizedNextPath.length === 0 ||
            normalizedPreviousPath === normalizedNextPath
          ) {
            return state;
          }

          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const nextThreadState = normalizePersistedThreadState({
            ...current,
            expandedDirectoryPaths: normalizePathList(
              current.expandedDirectoryPaths.map(
                (path) =>
                  replacePathPrefix(path, normalizedPreviousPath, normalizedNextPath) ?? path,
              ),
            ),
            panes: current.panes.map((pane) => ({
              ...pane,
              activeFilePath:
                typeof pane.activeFilePath === "string"
                  ? (replacePathPrefix(
                      pane.activeFilePath,
                      normalizedPreviousPath,
                      normalizedNextPath,
                    ) ?? pane.activeFilePath)
                  : null,
              openFilePaths: normalizePathList(
                pane.openFilePaths.map(
                  (path) =>
                    replacePathPrefix(path, normalizedPreviousPath, normalizedNextPath) ?? path,
                ),
              ),
            })),
          });
          const nextDraftsByFilePath = Object.fromEntries(
            Object.entries(runtime.draftsByFilePath).map(([path, draft]) => [
              replacePathPrefix(path, normalizedPreviousPath, normalizedNextPath) ?? path,
              draft,
            ]),
          );
          const nextRecentlyClosedEntries = runtime.recentlyClosedEntries.map((entry) => ({
            ...entry,
            filePath:
              replacePathPrefix(entry.filePath, normalizedPreviousPath, normalizedNextPath) ??
              entry.filePath,
          }));

          if (
            threadStatesEqual(current, nextThreadState) &&
            draftMapsEqual(runtime.draftsByFilePath, nextDraftsByFilePath) &&
            recentlyClosedEntriesEqual(runtime.recentlyClosedEntries, nextRecentlyClosedEntries)
          ) {
            return state;
          }

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: nextDraftsByFilePath,
                recentlyClosedEntries: nextRecentlyClosedEntries,
              },
            },
          };
        }),
      reopenClosedFile: (threadId, paneId) => {
        let reopenedFilePath: string | null = null;
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const recentlyClosedEntry = runtime.recentlyClosedEntries.at(-1);
          if (!recentlyClosedEntry) {
            return state;
          }

          const paneIndex = current.panes.findIndex(
            (pane) => pane.id === recentlyClosedEntry.paneId,
          );
          const fallbackPaneIndex = resolvePaneIndex(current, paneId);
          const targetPane =
            current.panes[paneIndex >= 0 ? paneIndex : fallbackPaneIndex] ?? current.panes[0];
          if (!targetPane) {
            return state;
          }

          reopenedFilePath = recentlyClosedEntry.filePath;
          const targetPaneIndex = current.panes.findIndex((pane) => pane.id === targetPane.id);
          if (targetPaneIndex < 0) {
            reopenedFilePath = null;
            return state;
          }

          const nextOpenFilePaths = insertPathAtIndex(
            targetPane.openFilePaths.filter((path) => path !== recentlyClosedEntry.filePath),
            recentlyClosedEntry.filePath,
            recentlyClosedEntry.targetIndex,
          );
          const nextThreadState = {
            ...current,
            activePaneId: targetPane.id,
            panes: replacePaneAtIndex(current.panes, targetPaneIndex, {
              ...targetPane,
              activeFilePath: recentlyClosedEntry.filePath,
              openFilePaths: nextOpenFilePaths,
            }),
          };

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                recentlyClosedEntries: runtime.recentlyClosedEntries.slice(0, -1),
              },
            },
          };
        });
        return reopenedFilePath;
      },
      runtimeStateByThreadId: {},
      setActiveFile: (threadId, filePath, paneId) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const paneIndex = resolvePaneIndex(current, paneId);
          const pane = current.panes[paneIndex];
          if (!pane) {
            return state;
          }
          const normalizedPath =
            typeof filePath === "string" && filePath.trim().length > 0 ? filePath.trim() : null;
          const nextOpenFilePaths =
            normalizedPath && !pane.openFilePaths.includes(normalizedPath)
              ? [...pane.openFilePaths, normalizedPath]
              : pane.openFilePaths;
          const nextThreadState = {
            ...current,
            activePaneId: pane.id,
            panes: replacePaneAtIndex(current.panes, paneIndex, {
              ...pane,
              activeFilePath: normalizedPath,
              openFilePaths: nextOpenFilePaths,
            }),
          };
          return threadStatesEqual(current, nextThreadState)
            ? state
            : writeThreadState(state, threadId, nextThreadState);
        }),
      setActivePane: (threadId, paneId) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          if (
            current.activePaneId === paneId ||
            !current.panes.some((pane) => pane.id === paneId)
          ) {
            return state;
          }
          return writeThreadState(state, threadId, {
            ...current,
            activePaneId: paneId,
          });
        }),
      setPaneRatios: (threadId, ratios) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextPaneRatios = normalizePaneRatios(ratios, current.panes.length);
          if (numberArraysEqual(current.paneRatios, nextPaneRatios)) {
            return state;
          }
          return writeThreadState(state, threadId, {
            ...current,
            paneRatios: nextPaneRatios,
          });
        }),
      setTreeWidth: (threadId, width) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextTreeWidth = normalizeTreeWidth(width);
          if (current.treeWidth === nextTreeWidth) {
            return state;
          }
          return writeThreadState(state, threadId, {
            ...current,
            treeWidth: nextTreeWidth,
          });
        }),
      splitPane: (threadId, options) => {
        let createdPaneId: string | null = null;
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          if (current.panes.length >= MAX_THREAD_EDITOR_PANES) {
            return state;
          }
          const paneIndex = resolvePaneIndex(current, options?.sourcePaneId);
          const sourcePane = current.panes[paneIndex];
          if (!sourcePane) {
            return state;
          }
          const requestedFilePath =
            typeof options?.filePath === "string" && options.filePath.trim().length > 0
              ? options.filePath.trim()
              : null;
          const initialFilePath = requestedFilePath ?? sourcePane.activeFilePath;
          const newPane = {
            activeFilePath: initialFilePath,
            id: createNextPaneId(current.panes),
            openFilePaths: initialFilePath ? [initialFilePath] : [],
          };
          createdPaneId = newPane.id;
          const nextPanes = [...current.panes];
          nextPanes.splice(paneIndex + 1, 0, newPane);
          return writeThreadState(state, threadId, {
            ...current,
            activePaneId: newPane.id,
            paneRatios: splitPaneRatios(current.paneRatios, paneIndex, nextPanes.length),
            panes: nextPanes,
          });
        });
        return createdPaneId;
      },
      syncTree: (threadId, validPaths) =>
        set((state) => {
          const validPathSet = new Set(normalizePathList(validPaths));
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const nextThreadState = normalizePersistedThreadState({
            ...current,
            expandedDirectoryPaths: current.expandedDirectoryPaths.filter((path) =>
              validPathSet.has(path),
            ),
            panes: current.panes.map((pane) => {
              const nextOpenFilePaths = pane.openFilePaths.filter((path) => validPathSet.has(path));
              return {
                ...pane,
                activeFilePath:
                  pane.activeFilePath && validPathSet.has(pane.activeFilePath)
                    ? pane.activeFilePath
                    : (nextOpenFilePaths.at(-1) ?? null),
                openFilePaths: nextOpenFilePaths,
              };
            }),
          });
          const nextDraftsByFilePath = Object.fromEntries(
            Object.entries(runtime.draftsByFilePath).filter(([path]) => validPathSet.has(path)),
          );
          const nextRecentlyClosedEntries = runtime.recentlyClosedEntries.filter((entry) =>
            validPathSet.has(entry.filePath),
          );
          if (
            threadStatesEqual(current, nextThreadState) &&
            draftMapsEqual(runtime.draftsByFilePath, nextDraftsByFilePath) &&
            recentlyClosedEntriesEqual(runtime.recentlyClosedEntries, nextRecentlyClosedEntries)
          ) {
            return state;
          }

          return {
            ...writeThreadState(state, threadId, nextThreadState),
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: nextDraftsByFilePath,
                recentlyClosedEntries: nextRecentlyClosedEntries,
              },
            },
          };
        }),
      threadStateByThreadId: {},
      toggleDirectory: (threadId, directoryPath) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const expanded = current.expandedDirectoryPaths.includes(directoryPath);
          return writeThreadState(state, threadId, {
            ...current,
            expandedDirectoryPaths: expanded
              ? current.expandedDirectoryPaths.filter((path) => path !== directoryPath)
              : [...current.expandedDirectoryPaths, directoryPath],
          });
        }),
      updateDraft: (threadId, filePath, draftContents) =>
        set((state) => {
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const existingDraft = runtime.draftsByFilePath[filePath];
          if (!existingDraft || existingDraft.draftContents === draftContents) {
            return state;
          }
          return {
            ...state,
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: {
                  ...runtime.draftsByFilePath,
                  [filePath]: {
                    ...existingDraft,
                    draftContents,
                  },
                },
              },
            },
          };
        }),
    }),
    {
      migrate: (persistedState, version) => {
        const snapshot = (persistedState as PersistedEditorStoreSnapshot | undefined) ?? {};
        const nextThreadStateByThreadId = Object.fromEntries(
          Object.entries(snapshot.threadStateByThreadId ?? {}).map(([threadId, threadState]) => [
            threadId,
            version < 2
              ? createPersistedThreadStateFromLegacy(
                  threadState as LegacyPersistedThreadEditorState | undefined,
                )
              : isLegacyThreadState(threadState)
                ? createPersistedThreadStateFromLegacy(threadState)
                : normalizePersistedThreadState(threadState),
          ]),
        );
        return {
          threadStateByThreadId: nextThreadStateByThreadId,
        };
      },
      name: STORAGE_KEY,
      partialize: (state) => ({
        threadStateByThreadId: state.threadStateByThreadId,
      }),
      storage: createJSONStorage(createEditorStateStorage),
      version: 2,
    },
  ),
);
