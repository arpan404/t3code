import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

interface EditorDraftState {
  draftContents: string;
  savedContents: string;
}

interface PersistedThreadEditorState {
  activeFilePath: string | null;
  expandedDirectoryPaths: string[];
  openFilePaths: string[];
  treeWidth: number;
}

interface RuntimeThreadEditorState {
  draftsByFilePath: Record<string, EditorDraftState>;
}

interface EditorStoreState {
  runtimeStateByThreadId: Record<string, RuntimeThreadEditorState>;
  threadStateByThreadId: Record<string, PersistedThreadEditorState>;
  closeFile: (threadId: ThreadId, filePath: string) => void;
  discardDraft: (threadId: ThreadId, filePath: string) => void;
  hydrateFile: (threadId: ThreadId, filePath: string, contents: string) => void;
  isDirty: (threadId: ThreadId, filePath: string) => boolean;
  markFileSaved: (threadId: ThreadId, filePath: string, contents: string) => void;
  openFile: (threadId: ThreadId, filePath: string) => void;
  setActiveFile: (threadId: ThreadId, filePath: string | null) => void;
  setTreeWidth: (threadId: ThreadId, width: number) => void;
  syncTree: (threadId: ThreadId, validPaths: readonly string[]) => void;
  toggleDirectory: (threadId: ThreadId, directoryPath: string) => void;
  updateDraft: (threadId: ThreadId, filePath: string, draftContents: string) => void;
}

export interface ThreadEditorState extends PersistedThreadEditorState {
  draftsByFilePath: Record<string, EditorDraftState>;
}

const STORAGE_KEY = "t3code:editor-state:v1";
const DEFAULT_TREE_WIDTH = 280;
const MIN_TREE_WIDTH = 220;
const MAX_TREE_WIDTH = 420;

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
    return DEFAULT_TREE_WIDTH;
  }
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, safeWidth));
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function createDefaultThreadEditorState(): PersistedThreadEditorState {
  return {
    activeFilePath: null,
    expandedDirectoryPaths: [],
    openFilePaths: [],
    treeWidth: DEFAULT_TREE_WIDTH,
  };
}

function createDefaultRuntimeThreadEditorState(): RuntimeThreadEditorState {
  return {
    draftsByFilePath: {},
  };
}

function getPersistedThreadState(
  stateByThreadId: Record<string, PersistedThreadEditorState>,
  threadId: ThreadId,
): PersistedThreadEditorState {
  return stateByThreadId[threadId] ?? createDefaultThreadEditorState();
}

function getRuntimeThreadState(
  stateByThreadId: Record<string, RuntimeThreadEditorState>,
  threadId: ThreadId,
): RuntimeThreadEditorState {
  return stateByThreadId[threadId] ?? createDefaultRuntimeThreadEditorState();
}

export function selectThreadEditorState(
  threadStateByThreadId: Record<string, PersistedThreadEditorState>,
  runtimeStateByThreadId: Record<string, RuntimeThreadEditorState>,
  threadId: ThreadId,
): ThreadEditorState {
  return {
    ...getPersistedThreadState(threadStateByThreadId, threadId),
    draftsByFilePath: getRuntimeThreadState(runtimeStateByThreadId, threadId).draftsByFilePath,
  };
}

function createEditorStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useEditorStateStore = create<EditorStoreState>()(
  persist(
    (set, get) => ({
      runtimeStateByThreadId: {},
      threadStateByThreadId: {},
      closeFile: (threadId, filePath) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          if (!current.openFilePaths.includes(filePath)) {
            return state;
          }
          const nextOpenFilePaths = current.openFilePaths.filter((path) => path !== filePath);
          return {
            ...state,
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                activeFilePath:
                  current.activeFilePath === filePath
                    ? (nextOpenFilePaths.at(-1) ?? null)
                    : current.activeFilePath,
                openFilePaths: nextOpenFilePaths,
              },
            },
          };
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
      openFile: (threadId, filePath) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextOpenFilePaths = current.openFilePaths.includes(filePath)
            ? current.openFilePaths
            : [...current.openFilePaths, filePath];
          if (
            current.activeFilePath === filePath &&
            stringArraysEqual(current.openFilePaths, nextOpenFilePaths)
          ) {
            return state;
          }
          return {
            ...state,
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                activeFilePath: filePath,
                openFilePaths: nextOpenFilePaths,
              },
            },
          };
        }),
      setActiveFile: (threadId, filePath) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextOpenFilePaths =
            filePath && !current.openFilePaths.includes(filePath)
              ? [...current.openFilePaths, filePath]
              : current.openFilePaths;
          if (
            current.activeFilePath === filePath &&
            stringArraysEqual(current.openFilePaths, nextOpenFilePaths)
          ) {
            return state;
          }
          return {
            ...state,
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                activeFilePath: filePath,
                openFilePaths: nextOpenFilePaths,
              },
            },
          };
        }),
      setTreeWidth: (threadId, width) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const nextTreeWidth = normalizeTreeWidth(width);
          if (current.treeWidth === nextTreeWidth) {
            return state;
          }
          return {
            ...state,
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                treeWidth: nextTreeWidth,
              },
            },
          };
        }),
      syncTree: (threadId, validPaths) =>
        set((state) => {
          const validPathSet = new Set(normalizePathList(validPaths));
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const nextOpenFilePaths = current.openFilePaths.filter((path) => validPathSet.has(path));
          const nextExpandedDirectoryPaths = current.expandedDirectoryPaths.filter((path) =>
            validPathSet.has(path),
          );
          const nextActiveFilePath =
            current.activeFilePath && validPathSet.has(current.activeFilePath)
              ? current.activeFilePath
              : (nextOpenFilePaths.at(-1) ?? null);
          const nextDraftsByFilePath = Object.fromEntries(
            Object.entries(runtime.draftsByFilePath).filter(([path]) => validPathSet.has(path)),
          );
          if (
            current.activeFilePath === nextActiveFilePath &&
            stringArraysEqual(current.openFilePaths, nextOpenFilePaths) &&
            stringArraysEqual(current.expandedDirectoryPaths, nextExpandedDirectoryPaths) &&
            draftMapsEqual(runtime.draftsByFilePath, nextDraftsByFilePath)
          ) {
            return state;
          }

          return {
            ...state,
            runtimeStateByThreadId: {
              ...state.runtimeStateByThreadId,
              [threadId]: {
                ...runtime,
                draftsByFilePath: nextDraftsByFilePath,
              },
            },
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                activeFilePath: nextActiveFilePath,
                expandedDirectoryPaths: nextExpandedDirectoryPaths,
                openFilePaths: nextOpenFilePaths,
              },
            },
          };
        }),
      toggleDirectory: (threadId, directoryPath) =>
        set((state) => {
          const current = getPersistedThreadState(state.threadStateByThreadId, threadId);
          const expanded = current.expandedDirectoryPaths.includes(directoryPath);
          return {
            ...state,
            threadStateByThreadId: {
              ...state.threadStateByThreadId,
              [threadId]: {
                ...current,
                expandedDirectoryPaths: expanded
                  ? current.expandedDirectoryPaths.filter((path) => path !== directoryPath)
                  : [...current.expandedDirectoryPaths, directoryPath],
              },
            },
          };
        }),
      updateDraft: (threadId, filePath, draftContents) =>
        set((state) => {
          const runtime = getRuntimeThreadState(state.runtimeStateByThreadId, threadId);
          const existingDraft = runtime.draftsByFilePath[filePath];
          if (!existingDraft) {
            return state;
          }
          if (existingDraft.draftContents === draftContents) {
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
      name: STORAGE_KEY,
      partialize: (state) => ({
        threadStateByThreadId: state.threadStateByThreadId,
      }),
      storage: createJSONStorage(createEditorStateStorage),
      version: 1,
    },
  ),
);
