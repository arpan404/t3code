import { loader } from "@monaco-editor/react";
import type { ProjectEntry, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilePlus2Icon,
  FolderIcon,
  FolderPlusIcon,
  SearchIcon,
} from "lucide-react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  MAX_THREAD_EDITOR_PANES,
  selectThreadEditorState,
  useEditorStateStore,
} from "~/editorStateStore";
import { useSettings } from "~/hooks/useSettings";
import { useUpdateSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { normalizePaneRatios, resizePaneRatios } from "~/lib/paneRatios";
import { projectListTreeQueryOptions, projectQueryKeys } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";
import { resolveShortcutCommand } from "~/keybindings";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import WorkspaceEditorPane from "./WorkspaceEditorPane";

let monacoConfigured = false;
const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];

function ensureMonacoConfigured() {
  if (monacoConfigured) {
    return;
  }

  const environment = {
    getWorker(_: string, label: string) {
      switch (label) {
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "json":
          return new jsonWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  Object.assign(globalThis as object, {
    MonacoEnvironment: environment,
  });
  loader.config({ monaco });
  monaco.editor.defineTheme("t3code-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c7084" },
      { token: "keyword", foreground: "f7a267" },
      { token: "string", foreground: "8dc891" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme("t3code-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7b8793" },
      { token: "keyword", foreground: "9f4f1d" },
      { token: "string", foreground: "2a6b4b" },
    ],
    colors: {},
  });
  monacoConfigured = true;
}

type TreeRow =
  | {
      depth: number;
      entry: ProjectEntry;
      hasChildren: boolean;
      kind: "directory";
      name: string;
    }
  | {
      depth: number;
      entry: ProjectEntry;
      hasChildren: false;
      kind: "file";
      name: string;
    };

function compareProjectEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return basenameOfPath(left.path).localeCompare(basenameOfPath(right.path));
}

function collectAncestorDirectories(pathValue: string | null): string[] {
  if (!pathValue) {
    return [];
  }
  const segments = pathValue.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

function buildTreeRows(
  entries: readonly ProjectEntry[],
  expandedDirectoryPaths: ReadonlySet<string>,
): TreeRow[] {
  const childrenByParent = new Map<string | undefined, ProjectEntry[]>();
  for (const entry of entries) {
    const existing = childrenByParent.get(entry.parentPath);
    if (existing) {
      existing.push(entry);
    } else {
      childrenByParent.set(entry.parentPath, [entry]);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareProjectEntries);
  }

  const rows: TreeRow[] = [];
  const visit = (parentPath: string | undefined, depth: number) => {
    const children = childrenByParent.get(parentPath) ?? [];
    for (const entry of children) {
      const name = basenameOfPath(entry.path);
      const hasChildren = (childrenByParent.get(entry.path)?.length ?? 0) > 0;
      if (entry.kind === "directory") {
        rows.push({ depth, entry, hasChildren, kind: "directory", name });
        if (expandedDirectoryPaths.has(entry.path)) {
          visit(entry.path, depth + 1);
        }
        continue;
      }
      rows.push({ depth, entry, hasChildren: false, kind: "file", name });
    }
  };

  visit(undefined, 0);
  return rows;
}

type ExplorerEntryDialogState =
  | {
      kind: "create-file";
      parentPath: string | null;
    }
  | {
      kind: "create-folder";
      parentPath: string | null;
    }
  | {
      entry: ProjectEntry;
      kind: "rename";
      parentPath: string | null;
    };

function pathForDialogInput(parentPath: string | null, value: string): string {
  const trimmed = value.trim().replace(/^\.\//, "");
  return parentPath ? `${parentPath}/${trimmed}` : trimmed;
}

function shouldIgnoreEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".monaco-editor")) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

const FileTreeRow = memo(function FileTreeRow(props: {
  activeFilePaths: ReadonlySet<string>;
  expandedDirectoryPaths: ReadonlySet<string>;
  focusedFilePath: string | null;
  onOpenFile: (filePath: string, openInNewPane: boolean) => void;
  onOpenRowContextMenu: (entry: ProjectEntry, position: { x: number; y: number }) => void;
  onSelectEntry: (path: string) => void;
  onToggleDirectory: (directoryPath: string) => void;
  openFilePaths: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  row: TreeRow;
  searchMode: boolean;
  selectedEntryPath: string | null;
}) {
  const isFocused = props.focusedFilePath === props.row.entry.path;
  const isSelected = props.selectedEntryPath === props.row.entry.path;
  const isOpen = props.openFilePaths.has(props.row.entry.path);
  const isActiveElsewhere = props.activeFilePaths.has(props.row.entry.path);
  const isExpanded =
    props.row.kind === "directory" && props.expandedDirectoryPaths.has(props.row.entry.path);

  return (
    <button
      type="button"
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
        isFocused
          ? "bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]"
          : isSelected
            ? "bg-foreground/[0.06] text-foreground"
            : isOpen
              ? "bg-foreground/[0.04] text-foreground"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 14}px`,
      }}
      onClick={(event) => {
        props.onSelectEntry(props.row.entry.path);
        if (props.row.kind === "directory") {
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path, event.altKey || event.metaKey);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onSelectEntry(props.row.entry.path);
        props.onOpenRowContextMenu(props.row.entry, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      title={
        props.row.kind === "file"
          ? `${props.row.entry.path} • Option-click to open in a new window • Right-click for actions`
          : props.row.entry.path
      }
    >
      {props.row.kind === "directory" ? (
        props.row.hasChildren ? (
          isExpanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <VscodeEntryIcon
        pathValue={props.row.entry.path}
        kind={props.row.entry.kind}
        theme={props.resolvedTheme}
        className="size-4"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{props.row.name}</span>
      {props.searchMode && props.row.entry.parentPath ? (
        <span className="min-w-0 max-w-[34%] truncate text-[11px] text-muted-foreground/70">
          {props.row.entry.parentPath}
        </span>
      ) : null}
      {props.row.kind === "file" && isOpen ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isFocused ? "bg-primary" : isActiveElsewhere ? "bg-sky-500" : "bg-muted-foreground/60",
          )}
        />
      ) : null}
    </button>
  );
});

export default function ThreadWorkspaceEditor(props: {
  browserOpen: boolean;
  gitCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  threadId: ThreadId;
}) {
  ensureMonacoConfigured();

  const { resolvedTheme } = useTheme();
  const { updateSettings } = useUpdateSettings();
  const editorSettings = useSettings((settings) => ({
    lineNumbers: settings.editorLineNumbers,
    minimap: settings.editorMinimap,
    renderWhitespace: settings.editorRenderWhitespace,
    stickyScroll: settings.editorStickyScroll,
    suggestions: settings.editorSuggestions,
    wordWrap: settings.editorWordWrap,
  }));
  const queryClient = useQueryClient();
  const api = readNativeApi();
  const [treeSearch, setTreeSearch] = useState("");
  const deferredTreeSearch = useDeferredValue(treeSearch.trim().toLowerCase());
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const treeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const entryDialogInputRef = useRef<HTMLInputElement | null>(null);
  const paneGroupRef = useRef<HTMLDivElement | null>(null);
  const closeFile = useEditorStateStore((state) => state.closeFile);
  const closeFilesToRight = useEditorStateStore((state) => state.closeFilesToRight);
  const closeOtherFiles = useEditorStateStore((state) => state.closeOtherFiles);
  const closePane = useEditorStateStore((state) => state.closePane);
  const discardDraft = useEditorStateStore((state) => state.discardDraft);
  const expandDirectories = useEditorStateStore((state) => state.expandDirectories);
  const hydrateFile = useEditorStateStore((state) => state.hydrateFile);
  const markFileSaved = useEditorStateStore((state) => state.markFileSaved);
  const moveFile = useEditorStateStore((state) => state.moveFile);
  const openFile = useEditorStateStore((state) => state.openFile);
  const removeEntry = useEditorStateStore((state) => state.removeEntry);
  const renameEntry = useEditorStateStore((state) => state.renameEntry);
  const reopenClosedFile = useEditorStateStore((state) => state.reopenClosedFile);
  const setActiveFile = useEditorStateStore((state) => state.setActiveFile);
  const setActivePane = useEditorStateStore((state) => state.setActivePane);
  const setPaneRatios = useEditorStateStore((state) => state.setPaneRatios);
  const setTreeWidth = useEditorStateStore((state) => state.setTreeWidth);
  const splitPane = useEditorStateStore((state) => state.splitPane);
  const syncTree = useEditorStateStore((state) => state.syncTree);
  const toggleDirectory = useEditorStateStore((state) => state.toggleDirectory);
  const updateDraft = useEditorStateStore((state) => state.updateDraft);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [entryDialogState, setEntryDialogState] = useState<ExplorerEntryDialogState | null>(null);
  const [entryDialogValue, setEntryDialogValue] = useState("");
  const hasRecentlyClosedFiles = useEditorStateStore(
    useCallback(
      (state) =>
        (state.runtimeStateByThreadId[props.threadId]?.recentlyClosedEntries.length ?? 0) > 0,
      [props.threadId],
    ),
  );
  const editorState = useEditorStateStore(
    useCallback(
      (state) =>
        selectThreadEditorState(
          state.threadStateByThreadId,
          state.runtimeStateByThreadId,
          props.threadId,
        ),
      [props.threadId],
    ),
  );
  const { activePaneId, draftsByFilePath, expandedDirectoryPaths, paneRatios, panes, treeWidth } =
    editorState;
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null,
    [activePaneId, panes],
  );
  const editorOptions = useMemo(
    () => ({
      acceptSuggestionOnCommitCharacter: editorSettings.suggestions,
      acceptSuggestionOnEnter: editorSettings.suggestions ? ("on" as const) : ("off" as const),
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      cursorBlinking: "smooth" as const,
      fontLigatures: true,
      fontSize: 13.5,
      guides: {
        bracketPairs: true,
        highlightActiveBracketPair: true,
        indentation: true,
      },
      inlineSuggest: { enabled: editorSettings.suggestions },
      lineNumbers: editorSettings.lineNumbers,
      minimap: { enabled: editorSettings.minimap },
      padding: { top: 12, bottom: 24 },
      parameterHints: { enabled: editorSettings.suggestions },
      quickSuggestions: editorSettings.suggestions,
      renderLineHighlightOnlyWhenFocus: true,
      renderWhitespace: editorSettings.renderWhitespace ? ("all" as const) : ("none" as const),
      roundedSelection: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      snippetSuggestions: editorSettings.suggestions ? ("inline" as const) : ("none" as const),
      stickyScroll: { enabled: editorSettings.stickyScroll },
      suggestOnTriggerCharacters: editorSettings.suggestions,
      tabCompletion: editorSettings.suggestions ? ("on" as const) : ("off" as const),
      tabSize: 2,
      wordBasedSuggestions: editorSettings.suggestions
        ? ("currentDocument" as const)
        : ("off" as const),
      wordWrap: editorSettings.wordWrap ? ("on" as const) : ("off" as const),
    }),
    [editorSettings],
  );

  const workspaceTreeQuery = useQuery(
    projectListTreeQueryOptions({
      cwd: props.gitCwd,
    }),
  );
  const treeEntries = workspaceTreeQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const entryByPath = useMemo(
    () => new Map(treeEntries.map((entry) => [entry.path, entry] as const)),
    [treeEntries],
  );

  useEffect(() => {
    if (treeEntries.length === 0) {
      return;
    }
    syncTree(
      props.threadId,
      treeEntries.map((entry) => entry.path),
    );
  }, [props.threadId, syncTree, treeEntries]);

  const hasAnyOpenFile = panes.some((pane) => pane.openFilePaths.length > 0);
  useEffect(() => {
    if (hasAnyOpenFile || treeEntries.length === 0 || activePane?.id === undefined) {
      return;
    }
    const firstFile = treeEntries.find((entry) => entry.kind === "file");
    if (firstFile) {
      openFile(props.threadId, firstFile.path, activePane.id);
    }
  }, [activePane?.id, hasAnyOpenFile, openFile, props.threadId, treeEntries]);

  useEffect(() => {
    if (selectedEntryPath && entryByPath.has(selectedEntryPath)) {
      return;
    }
    setSelectedEntryPath(activePane?.activeFilePath ?? null);
  }, [activePane?.activeFilePath, entryByPath, selectedEntryPath]);

  useEffect(() => {
    if (!entryDialogState) {
      return;
    }
    const timer = window.setTimeout(() => {
      entryDialogInputRef.current?.focus();
      entryDialogInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [entryDialogState]);

  const saveMutation = useMutation({
    mutationFn: async (input: { contents: string; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.writeFile({
        contents: input.contents,
        cwd: props.gitCwd,
        relativePath: input.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to save ${variables.relativePath}.`,
        title: "Could not save file",
        type: "error",
      });
    },
    onSuccess: (_result, variables) => {
      markFileSaved(props.threadId, variables.relativePath, variables.contents);
      queryClient.setQueryData(projectQueryKeys.readFile(props.gitCwd, variables.relativePath), {
        contents: variables.contents,
        relativePath: variables.relativePath,
        sizeBytes: new Blob([variables.contents]).size,
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listTree(props.gitCwd) });
      toastManager.add({
        description: variables.relativePath,
        title: "File saved",
        type: "success",
      });
    },
  });

  const handleSaveFile = useCallback(
    (relativePath: string, contents: string) => {
      if (saveMutation.isPending) {
        return;
      }
      void saveMutation.mutate({ contents, relativePath });
    },
    [saveMutation],
  );
  const handleHydrateFile = useCallback(
    (filePath: string, contents: string) => {
      hydrateFile(props.threadId, filePath, contents);
    },
    [hydrateFile, props.threadId],
  );

  const normalizedPaneRatios = useMemo(
    () => normalizePaneRatios(paneRatios, panes.length),
    [paneRatios, panes.length],
  );

  const activeDirtyPaths = useMemo(
    () =>
      new Set(
        Object.entries(draftsByFilePath)
          .filter(([, draft]) => draft.draftContents !== draft.savedContents)
          .map(([path]) => path),
      ),
    [draftsByFilePath],
  );

  const openFilePaths = useMemo(
    () => new Set(panes.flatMap((pane) => pane.openFilePaths)),
    [panes],
  );
  const activeFilePaths = useMemo(
    () =>
      panes
        .map((pane) => pane.activeFilePath)
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    [panes],
  );
  const activeFilePathSet = useMemo(() => new Set(activeFilePaths), [activeFilePaths]);
  const activeAncestorDirectories = useMemo(
    () => Array.from(new Set(activeFilePaths.flatMap((path) => collectAncestorDirectories(path)))),
    [activeFilePaths],
  );

  const visibleRows = useMemo(() => {
    if (deferredTreeSearch.length > 0) {
      return treeEntries
        .filter((entry) => entry.path.toLowerCase().includes(deferredTreeSearch))
        .toSorted(compareProjectEntries)
        .map<TreeRow>((entry) => ({
          depth: 0,
          entry,
          hasChildren: false,
          kind: entry.kind,
          name: basenameOfPath(entry.path),
        }));
    }

    return buildTreeRows(
      treeEntries,
      new Set([...expandedDirectoryPaths, ...activeAncestorDirectories]),
    );
  }, [activeAncestorDirectories, deferredTreeSearch, expandedDirectoryPaths, treeEntries]);

  const expandedDirectoryPathSet = useMemo(
    () => new Set([...expandedDirectoryPaths, ...activeAncestorDirectories]),
    [activeAncestorDirectories, expandedDirectoryPaths],
  );

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    estimateSize: () => 32,
    getScrollElement: () => treeScrollRef.current,
    overscan: 12,
  });

  const treeResizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const handleTreeResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      treeResizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: treeWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [treeWidth],
  );
  const handleTreeResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = treeResizeStateRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }
      setTreeWidth(props.threadId, state.startWidth + (event.clientX - state.startX));
    },
    [props.threadId, setTreeWidth],
  );
  const handleTreeResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = treeResizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    treeResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const paneResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart = useCallback(
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      paneResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        startRatios: normalizedPaneRatios,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [normalizedPaneRatios],
  );
  const handlePaneResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = paneResizeStateRef.current;
      const container = paneGroupRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      setPaneRatios(
        props.threadId,
        resizePaneRatios({
          containerWidthPx: container.clientWidth,
          deltaPx: event.clientX - resizeState.startX,
          dividerIndex: resizeState.dividerIndex,
          minPaneWidthPx: 320,
          ratios: resizeState.startRatios,
        }),
      );
    },
    [props.threadId, setPaneRatios],
  );
  const handlePaneResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = paneResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    paneResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const workspaceFileCount = useMemo(
    () => treeEntries.filter((entry) => entry.kind === "file").length,
    [treeEntries],
  );

  const handleSplitPane = useCallback(
    (paneId?: string, filePath?: string) => {
      const createdPaneId = splitPane(props.threadId, {
        ...(filePath ? { filePath } : {}),
        ...(paneId ? { sourcePaneId: paneId } : {}),
      });
      if (createdPaneId) {
        return;
      }
      toastManager.add({
        description: `This milestone currently supports up to ${MAX_THREAD_EDITOR_PANES} editor windows.`,
        title: "Window limit reached",
        type: "info",
      });
    },
    [props.threadId, splitPane],
  );

  const handleOpenFile = useCallback(
    (filePath: string, openInNewPane: boolean) => {
      if (openInNewPane) {
        handleSplitPane(activePane?.id, filePath);
        if (panes.length >= MAX_THREAD_EDITOR_PANES) {
          openFile(props.threadId, filePath, activePane?.id);
        }
        return;
      }
      openFile(props.threadId, filePath, activePane?.id);
    },
    [activePane?.id, handleSplitPane, openFile, panes.length, props.threadId],
  );
  const handleRetryActiveFile = useCallback(() => {
    if (!activePane?.activeFilePath) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.readFile(props.gitCwd, activePane.activeFilePath),
    });
  }, [activePane?.activeFilePath, props.gitCwd, queryClient]);

  const invalidateWorkspaceTree = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listTree(props.gitCwd),
    });
  }, [props.gitCwd, queryClient]);

  const clearReadFileCache = useCallback(
    (relativePath: string) => {
      queryClient.removeQueries({
        queryKey: projectQueryKeys.readFile(props.gitCwd, relativePath),
        exact: true,
      });
    },
    [props.gitCwd, queryClient],
  );

  const openExplorerEntryDialog = useCallback((state: ExplorerEntryDialogState) => {
    setEntryDialogState(state);
    setEntryDialogValue(state.kind === "rename" ? basenameOfPath(state.entry.path) : "");
  }, []);

  const focusedExplorerEntryPath = selectedEntryPath ?? activePane?.activeFilePath ?? null;
  const focusedExplorerEntry = focusedExplorerEntryPath
    ? (entryByPath.get(focusedExplorerEntryPath) ?? null)
    : null;

  const createEntryMutation = useMutation({
    mutationFn: async (input: { kind: "file" | "directory"; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.createEntry({
        cwd: props.gitCwd,
        kind: input.kind,
        relativePath: input.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to create ${variables.relativePath}.`,
        title: variables.kind === "directory" ? "Could not create folder" : "Could not create file",
        type: "error",
      });
    },
    onSuccess: (result) => {
      const ancestorDirectories = collectAncestorDirectories(result.relativePath);
      expandDirectories(props.threadId, [
        ...ancestorDirectories,
        ...(result.kind === "directory" ? [result.relativePath] : []),
      ]);
      setSelectedEntryPath(result.relativePath);
      if (result.kind === "file") {
        markFileSaved(props.threadId, result.relativePath, "");
        openFile(props.threadId, result.relativePath, activePane?.id);
      }
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: result.kind === "directory" ? "Folder created" : "File created",
        type: "success",
      });
      setEntryDialogState(null);
      setEntryDialogValue("");
    },
  });

  const renameEntryMutation = useMutation({
    mutationFn: async (input: {
      kind: "file" | "directory";
      nextRelativePath: string;
      relativePath: string;
    }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.renameEntry({
        cwd: props.gitCwd,
        nextRelativePath: input.nextRelativePath,
        relativePath: input.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to rename ${variables.relativePath}.`,
        title: "Could not rename entry",
        type: "error",
      });
    },
    onSuccess: (result, variables) => {
      renameEntry(props.threadId, result.previousRelativePath, result.relativePath);
      expandDirectories(props.threadId, [
        ...collectAncestorDirectories(result.relativePath),
        ...(variables.kind === "directory" ? [result.relativePath] : []),
      ]);
      setSelectedEntryPath(result.relativePath);
      clearReadFileCache(result.previousRelativePath);
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: "Entry renamed",
        type: "success",
      });
      setEntryDialogState(null);
      setEntryDialogValue("");
    },
  });

  const deleteEntryMutation = useMutation({
    mutationFn: async (input: { kind: "file" | "directory"; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.deleteEntry({
        cwd: props.gitCwd,
        relativePath: input.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to delete ${variables.relativePath}.`,
        title: variables.kind === "directory" ? "Could not delete folder" : "Could not delete file",
        type: "error",
      });
    },
    onSuccess: (result) => {
      removeEntry(props.threadId, result.relativePath);
      clearReadFileCache(result.relativePath);
      setSelectedEntryPath(null);
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: "Entry deleted",
        type: "success",
      });
    },
  });

  const handleDeleteEntry = useCallback(
    async (entry: ProjectEntry) => {
      if (!api) {
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Delete ${entry.kind === "directory" ? "folder" : "file"} "${basenameOfPath(entry.path)}"?`,
          entry.kind === "directory"
            ? "This permanently removes the folder and its contents."
            : "This permanently removes the file.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }
      void deleteEntryMutation.mutate({
        kind: entry.kind,
        relativePath: entry.path,
      });
    },
    [api, deleteEntryMutation],
  );

  const openExplorerContextMenu = useCallback(
    async (entry: ProjectEntry | null, position: { x: number; y: number }) => {
      if (!api) {
        return;
      }
      const items = [
        { id: "new-file", label: "New File" },
        { id: "new-folder", label: "New Folder" },
        ...(entry
          ? [
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete", destructive: true },
            ]
          : []),
      ] as const;
      const clicked = await api.contextMenu.show(items, position);
      const parentPath = entry?.kind === "directory" ? entry.path : (entry?.parentPath ?? null);

      if (clicked === "new-file") {
        openExplorerEntryDialog({ kind: "create-file", parentPath });
        return;
      }
      if (clicked === "new-folder") {
        openExplorerEntryDialog({ kind: "create-folder", parentPath });
        return;
      }
      if (clicked === "rename" && entry) {
        openExplorerEntryDialog({ kind: "rename", entry, parentPath: entry.parentPath ?? null });
        return;
      }
      if (clicked === "delete" && entry) {
        await handleDeleteEntry(entry);
      }
    },
    [api, handleDeleteEntry, openExplorerEntryDialog],
  );

  const submitExplorerEntryDialog = useCallback(() => {
    if (!entryDialogState) {
      return;
    }

    const relativePath = pathForDialogInput(entryDialogState.parentPath, entryDialogValue);
    if (
      relativePath.length === 0 ||
      entryDialogValue.trim() === "." ||
      entryDialogValue.trim() === ".."
    ) {
      toastManager.add({
        description: "Enter a valid workspace-relative name.",
        title: "Name required",
        type: "error",
      });
      return;
    }

    if (entryDialogState.kind === "rename") {
      void renameEntryMutation.mutate({
        kind: entryDialogState.entry.kind,
        nextRelativePath: relativePath,
        relativePath: entryDialogState.entry.path,
      });
      return;
    }

    void createEntryMutation.mutate({
      kind: entryDialogState.kind === "create-folder" ? "directory" : "file",
      relativePath,
    });
  }, [createEntryMutation, entryDialogState, entryDialogValue, renameEntryMutation]);

  const handleReopenClosedTab = useCallback(
    (paneId?: string) => {
      const reopenedPath = reopenClosedFile(props.threadId, paneId);
      if (reopenedPath) {
        toastManager.add({
          description: reopenedPath,
          title: "Tab reopened",
          type: "success",
        });
        return true;
      }
      toastManager.add({
        description: "There are no recently closed tabs for this workspace.",
        title: "Nothing to reopen",
        type: "info",
      });
      return false;
    },
    [props.threadId, reopenClosedFile],
  );

  const handleOpenFileToSide = useCallback(
    (paneId: string, filePath: string) => {
      handleSplitPane(paneId, filePath);
    },
    [handleSplitPane],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !activePane) {
        return;
      }
      if (entryDialogState || document.activeElement === treeSearchInputRef.current) {
        return;
      }
      if (shouldIgnoreEditorShortcutTarget(event.target)) {
        return;
      }
      const terminalFocus = isTerminalFocused();
      const command = resolveShortcutCommand(event, props.keybindings, {
        context: {
          browserOpen: props.browserOpen,
          editorFocus: !terminalFocus,
          terminalFocus,
          terminalOpen: props.terminalOpen,
        },
      });
      if (!command) {
        return;
      }

      if (command === "editor.split") {
        event.preventDefault();
        event.stopPropagation();
        handleSplitPane(activePane.id);
        return;
      }

      if (command === "editor.toggleWordWrap") {
        event.preventDefault();
        event.stopPropagation();
        updateSettings({ editorWordWrap: !editorSettings.wordWrap });
        toastManager.add({
          description: !editorSettings.wordWrap ? "Soft wrap enabled." : "Soft wrap disabled.",
          title: "Editor wrapping updated",
          type: "success",
        });
        return;
      }

      if (command === "editor.closeTab") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeFile(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.reopenClosedTab") {
        event.preventDefault();
        event.stopPropagation();
        handleReopenClosedTab(activePane.id);
        return;
      }

      if (command === "editor.closeOtherTabs") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOtherFiles(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.closeTabsToRight") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeFilesToRight(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.newFile") {
        event.preventDefault();
        event.stopPropagation();
        openExplorerEntryDialog({
          kind: "create-file",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
        });
        return;
      }

      if (command === "editor.newFolder") {
        event.preventDefault();
        event.stopPropagation();
        openExplorerEntryDialog({
          kind: "create-folder",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
        });
        return;
      }

      if (command === "editor.rename") {
        if (!focusedExplorerEntry) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openExplorerEntryDialog({
          kind: "rename",
          entry: focusedExplorerEntry,
          parentPath: focusedExplorerEntry.parentPath ?? null,
        });
        return;
      }

      if (command === "editor.closeWindow") {
        if (panes.length <= 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closePane(props.threadId, activePane.id);
        return;
      }

      if (command === "editor.focusNextWindow" || command === "editor.focusPreviousWindow") {
        if (panes.length <= 1) {
          return;
        }
        const currentIndex = panes.findIndex((pane) => pane.id === activePane.id);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.focusNextWindow" ? 1 : -1;
        const nextPane = panes[(currentIndex + offset + panes.length) % panes.length];
        if (!nextPane) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setActivePane(props.threadId, nextPane.id);
        return;
      }

      if (command === "editor.nextTab" || command === "editor.previousTab") {
        if (activePane.openFilePaths.length <= 1 || !activePane.activeFilePath) {
          return;
        }
        const currentIndex = activePane.openFilePaths.indexOf(activePane.activeFilePath);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.nextTab" ? 1 : -1;
        const nextFilePath =
          activePane.openFilePaths[
            (currentIndex + offset + activePane.openFilePaths.length) %
              activePane.openFilePaths.length
          ];
        if (!nextFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setActiveFile(props.threadId, nextFilePath, activePane.id);
        return;
      }

      if (command === "editor.moveTabLeft" || command === "editor.moveTabRight") {
        if (!activePane.activeFilePath) {
          return;
        }
        const currentIndex = activePane.openFilePaths.indexOf(activePane.activeFilePath);
        if (currentIndex < 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        const direction = command === "editor.moveTabRight" ? 1 : -1;
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < activePane.openFilePaths.length) {
          moveFile(props.threadId, {
            filePath: activePane.activeFilePath,
            sourcePaneId: activePane.id,
            targetPaneId: activePane.id,
            targetIndex: nextIndex,
          });
          return;
        }

        const paneIndex = panes.findIndex((pane) => pane.id === activePane.id);
        const adjacentPane = panes[paneIndex + direction];
        if (!adjacentPane) {
          return;
        }
        moveFile(props.threadId, {
          filePath: activePane.activeFilePath,
          sourcePaneId: activePane.id,
          targetPaneId: adjacentPane.id,
          targetIndex: direction > 0 ? 0 : adjacentPane.openFilePaths.length,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activePane,
    closePane,
    closeFile,
    closeFilesToRight,
    closeOtherFiles,
    editorSettings.wordWrap,
    entryDialogState,
    focusedExplorerEntry,
    handleSplitPane,
    handleReopenClosedTab,
    moveFile,
    openExplorerEntryDialog,
    panes,
    props.browserOpen,
    props.keybindings,
    props.terminalOpen,
    props.threadId,
    setActiveFile,
    setActivePane,
    updateSettings,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        className="grid h-full min-h-0 min-w-0"
        style={{
          gridTemplateColumns: `minmax(220px, ${treeWidth}px) 6px minmax(0, 1fr)`,
        }}
      >
        <aside
          className={cn("flex min-h-0 min-w-0 flex-col border-r border-border/60", "bg-secondary")}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <FolderIcon className="size-3.5 text-muted-foreground/70" />
            <span className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground/80 uppercase">
              Explorer
            </span>
            <Badge variant="outline" size="sm" className="ml-auto text-[10px]">
              {workspaceFileCount}
            </Badge>
            {workspaceTreeQuery.data?.truncated ? (
              <Badge variant="warning" size="sm">
                Partial
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 rounded-md text-muted-foreground/75 hover:text-foreground"
              onClick={() =>
                openExplorerEntryDialog({
                  kind: "create-file",
                  parentPath:
                    focusedExplorerEntry?.kind === "directory"
                      ? focusedExplorerEntry.path
                      : (focusedExplorerEntry?.parentPath ?? null),
                })
              }
              title="New File"
            >
              <FilePlus2Icon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 rounded-md text-muted-foreground/75 hover:text-foreground"
              onClick={() =>
                openExplorerEntryDialog({
                  kind: "create-folder",
                  parentPath:
                    focusedExplorerEntry?.kind === "directory"
                      ? focusedExplorerEntry.path
                      : (focusedExplorerEntry?.parentPath ?? null),
                })
              }
              title="New Folder"
            >
              <FolderPlusIcon className="size-3.5" />
            </Button>
          </div>
          <div className="px-2.5 py-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                ref={treeSearchInputRef}
                value={treeSearch}
                onChange={(event) => setTreeSearch(event.target.value)}
                placeholder="Filter files…"
                className="pl-8"
                size="sm"
                type="search"
              />
            </div>
          </div>

          <div
            ref={treeScrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
            onContextMenu={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              event.preventDefault();
              setSelectedEntryPath(null);
              void openExplorerContextMenu(null, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {workspaceTreeQuery.isPending ? (
              <div className="space-y-1.5 px-1 py-2">
                {Array.from({ length: 10 }, (_, index) => (
                  <div
                    key={index}
                    className="h-7 rounded-md bg-foreground/5"
                    style={{ opacity: 1 - index * 0.06 }}
                  />
                ))}
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {deferredTreeSearch.length > 0 ? "No files match this filter." : "No files found."}
              </div>
            ) : (
              <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = visibleRows[virtualRow.index];
                  if (!row) {
                    return null;
                  }
                  return (
                    <div
                      key={row.entry.path}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      <FileTreeRow
                        activeFilePaths={activeFilePathSet}
                        expandedDirectoryPaths={expandedDirectoryPathSet}
                        focusedFilePath={activePane?.activeFilePath ?? null}
                        onOpenFile={handleOpenFile}
                        onOpenRowContextMenu={(entry, position) => {
                          void openExplorerContextMenu(entry, position);
                        }}
                        onSelectEntry={setSelectedEntryPath}
                        onToggleDirectory={(directoryPath) =>
                          toggleDirectory(props.threadId, directoryPath)
                        }
                        openFilePaths={openFilePaths}
                        resolvedTheme={resolvedTheme}
                        row={row}
                        searchMode={deferredTreeSearch.length > 0}
                        selectedEntryPath={selectedEntryPath}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <div
          aria-label="Resize workspace sidebar"
          role="separator"
          aria-orientation="vertical"
          className="relative cursor-col-resize hover:bg-primary/35"
          onPointerDown={handleTreeResizeStart}
          onPointerMove={handleTreeResizeMove}
          onPointerUp={handleTreeResizeEnd}
          onPointerCancel={handleTreeResizeEnd}
        >
          <div className="mx-auto h-full w-px bg-border/60" />
        </div>

        <section className="min-h-0 min-w-0 overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-col">
            <div ref={paneGroupRef} className="flex min-h-0 flex-1 overflow-hidden">
              {panes.map((pane, index) => (
                <div
                  key={pane.id}
                  className="flex min-h-0 min-w-0"
                  style={{
                    flexBasis: 0,
                    flexGrow: normalizedPaneRatios[index] ?? 1,
                    minWidth: 0,
                  }}
                >
                  <WorkspaceEditorPane
                    active={pane.id === activePaneId}
                    canClosePane={panes.length > 1}
                    canReopenClosedTab={hasRecentlyClosedFiles}
                    canSplitPane={panes.length < MAX_THREAD_EDITOR_PANES}
                    dirtyFilePaths={activeDirtyPaths}
                    draftsByFilePath={draftsByFilePath}
                    editorOptions={editorOptions}
                    gitCwd={props.gitCwd}
                    onCloseFile={(paneId, filePath) => closeFile(props.threadId, filePath, paneId)}
                    onCloseOtherTabs={(paneId, filePath) =>
                      closeOtherFiles(props.threadId, filePath, paneId)
                    }
                    onClosePane={(paneId) => closePane(props.threadId, paneId)}
                    onCloseTabsToRight={(paneId, filePath) =>
                      closeFilesToRight(props.threadId, filePath, paneId)
                    }
                    onDiscardDraft={(filePath) => discardDraft(props.threadId, filePath)}
                    onFocusPane={(paneId) => setActivePane(props.threadId, paneId)}
                    onHydrateFile={handleHydrateFile}
                    onMoveFile={(input) => moveFile(props.threadId, input)}
                    onOpenFileToSide={handleOpenFileToSide}
                    onReopenClosedTab={handleReopenClosedTab}
                    onRetryActiveFile={handleRetryActiveFile}
                    onSaveFile={handleSaveFile}
                    onSetActiveFile={(paneId, filePath) =>
                      setActiveFile(props.threadId, filePath, paneId)
                    }
                    onSplitPane={(paneId) => handleSplitPane(paneId)}
                    onUpdateDraft={(filePath, contents) =>
                      updateDraft(props.threadId, filePath, contents)
                    }
                    pane={pane}
                    paneIndex={index}
                    resolvedTheme={resolvedTheme}
                    savingFilePath={
                      saveMutation.isPending ? (saveMutation.variables?.relativePath ?? null) : null
                    }
                  />
                  {index < panes.length - 1 ? (
                    <div
                      aria-label={`Resize between editor windows ${index + 1} and ${index + 2}`}
                      role="separator"
                      aria-orientation="vertical"
                      className="group relative z-10 -mx-[3px] flex w-[6px] shrink-0 cursor-col-resize items-center justify-center touch-none select-none"
                      onPointerDown={handlePaneResizeStart(index)}
                      onPointerMove={handlePaneResizeMove}
                      onPointerUp={handlePaneResizeEnd}
                      onPointerCancel={handlePaneResizeEnd}
                    >
                      <div className="h-full w-[2px] bg-border/40 transition-colors group-hover:bg-primary" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <Dialog
        open={entryDialogState !== null}
        onOpenChange={(open) => {
          if (open) {
            return;
          }
          setEntryDialogState(null);
          setEntryDialogValue("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {entryDialogState?.kind === "create-file"
                ? "New file"
                : entryDialogState?.kind === "create-folder"
                  ? "New folder"
                  : "Rename entry"}
            </DialogTitle>
            <DialogDescription>
              {entryDialogState?.kind === "rename"
                ? `Update ${entryDialogState.entry.kind === "directory" ? "folder" : "file"} name within the workspace.`
                : "Enter a name relative to the selected folder."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              ref={entryDialogInputRef}
              value={entryDialogValue}
              onChange={(event) => setEntryDialogValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitExplorerEntryDialog();
                }
              }}
              placeholder={
                entryDialogState?.kind === "create-folder" ? "folder-name" : "file-name.ts"
              }
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {(entryDialogState?.parentPath ?? null) ? (
              <p className="text-xs text-muted-foreground">
                Parent: {entryDialogState?.parentPath}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Parent: workspace root</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEntryDialogState(null);
                setEntryDialogValue("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={submitExplorerEntryDialog}
              disabled={createEntryMutation.isPending || renameEntryMutation.isPending}
            >
              {entryDialogState?.kind === "rename"
                ? renameEntryMutation.isPending
                  ? "Renaming..."
                  : "Rename"
                : createEntryMutation.isPending
                  ? "Creating..."
                  : entryDialogState?.kind === "create-folder"
                    ? "Create Folder"
                    : "Create File"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
