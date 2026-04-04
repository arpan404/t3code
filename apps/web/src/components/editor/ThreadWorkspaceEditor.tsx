import Editor, { loader, type OnMount } from "@monaco-editor/react";
import type {
  EditorId,
  ProjectEntry,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DiffIcon,
  FolderIcon,
  SearchIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
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

import GitActionsControl from "../GitActionsControl";
import { OpenInPicker } from "../chat/OpenInPicker";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarTrigger } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useEditorStateStore } from "~/editorStateStore";
import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import {
  projectListTreeQueryOptions,
  projectQueryKeys,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { WorkspaceModeToggle } from "./WorkspaceModeToggle";
import { basenameOfPath } from "~/vscode-icons";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

let monacoConfigured = false;
const DEFAULT_TREE_WIDTH = 280;
const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];
const EMPTY_EDITOR_DRAFTS: Record<string, { draftContents: string; savedContents: string }> = {};
const EMPTY_PATHS: readonly string[] = [];

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
    colors: {
      "editor.background": "#0b0d10",
      "editor.lineHighlightBackground": "#151a20",
      "editorLineNumber.foreground": "#42505f",
      "editorLineNumber.activeForeground": "#f3f4ef",
      "editorCursor.foreground": "#f7a267",
      "editor.selectionBackground": "#2b3542",
      "editor.inactiveSelectionBackground": "#202833",
      "editorIndentGuide.background1": "#18202a",
      "editorIndentGuide.activeBackground1": "#344456",
      "editorWhitespace.foreground": "#1b232d",
    },
  });
  monaco.editor.defineTheme("t3code-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7b8793" },
      { token: "keyword", foreground: "9f4f1d" },
      { token: "string", foreground: "2a6b4b" },
    ],
    colors: {
      "editor.background": "#fcfaf5",
      "editor.lineHighlightBackground": "#f1ece1",
      "editorLineNumber.foreground": "#b6a894",
      "editorLineNumber.activeForeground": "#221c17",
      "editorCursor.foreground": "#9f4f1d",
      "editor.selectionBackground": "#e4d8c7",
      "editor.inactiveSelectionBackground": "#f0e7da",
      "editorIndentGuide.background1": "#efe6d8",
      "editorIndentGuide.activeBackground1": "#cdb89c",
      "editorWhitespace.foreground": "#eadfce",
    },
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

const FileTreeRow = memo(function FileTreeRow(props: {
  activeFilePath: string | null;
  expandedDirectoryPaths: ReadonlySet<string>;
  onOpenFile: (filePath: string) => void;
  onToggleDirectory: (directoryPath: string) => void;
  resolvedTheme: "light" | "dark";
  row: TreeRow;
  searchMode: boolean;
}) {
  const isActive = props.activeFilePath === props.row.entry.path;
  const isExpanded =
    props.row.kind === "directory" && props.expandedDirectoryPaths.has(props.row.entry.path);

  return (
    <button
      type="button"
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
        isActive
          ? "bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 14}px`,
      }}
      onClick={() => {
        if (props.row.kind === "directory") {
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path);
      }}
      title={props.row.entry.path}
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
        <span className="min-w-0 max-w-[38%] truncate text-[11px] text-muted-foreground/70">
          {props.row.entry.parentPath}
        </span>
      ) : null}
    </button>
  );
});

export default function ThreadWorkspaceEditor(props: {
  activeThreadTitle: string;
  availableEditors: ReadonlyArray<EditorId>;
  diffOpen: boolean;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  mode: ThreadWorkspaceMode;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
  onToggleDiff: () => void;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  threadId: ThreadId;
  workspaceName: string | undefined;
}) {
  ensureMonacoConfigured();

  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const api = readNativeApi();
  const [treeSearch, setTreeSearch] = useState("");
  const deferredTreeSearch = useDeferredValue(treeSearch.trim().toLowerCase());
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const saveActionRef = useRef<() => void>(() => {});
  const closeFile = useEditorStateStore((state) => state.closeFile);
  const discardDraft = useEditorStateStore((state) => state.discardDraft);
  const hydrateFile = useEditorStateStore((state) => state.hydrateFile);
  const markFileSaved = useEditorStateStore((state) => state.markFileSaved);
  const openFile = useEditorStateStore((state) => state.openFile);
  const setActiveFile = useEditorStateStore((state) => state.setActiveFile);
  const setTreeWidth = useEditorStateStore((state) => state.setTreeWidth);
  const syncTree = useEditorStateStore((state) => state.syncTree);
  const toggleDirectory = useEditorStateStore((state) => state.toggleDirectory);
  const updateDraft = useEditorStateStore((state) => state.updateDraft);
  const activeFilePath = useEditorStateStore(
    useCallback(
      (state) => state.threadStateByThreadId[props.threadId]?.activeFilePath ?? null,
      [props.threadId],
    ),
  );
  const draftsByFilePath = useEditorStateStore(
    useCallback(
      (state) =>
        state.runtimeStateByThreadId[props.threadId]?.draftsByFilePath ?? EMPTY_EDITOR_DRAFTS,
      [props.threadId],
    ),
  );
  const expandedDirectoryPaths = useEditorStateStore(
    useCallback(
      (state) => state.threadStateByThreadId[props.threadId]?.expandedDirectoryPaths ?? EMPTY_PATHS,
      [props.threadId],
    ),
  );
  const openFilePaths = useEditorStateStore(
    useCallback(
      (state) => state.threadStateByThreadId[props.threadId]?.openFilePaths ?? EMPTY_PATHS,
      [props.threadId],
    ),
  );
  const treeWidth = useEditorStateStore(
    useCallback(
      (state) => state.threadStateByThreadId[props.threadId]?.treeWidth ?? DEFAULT_TREE_WIDTH,
      [props.threadId],
    ),
  );

  const workspaceTreeQuery = useQuery(
    projectListTreeQueryOptions({
      cwd: props.gitCwd,
    }),
  );
  const treeEntries = workspaceTreeQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  useEffect(() => {
    if (treeEntries.length === 0) {
      return;
    }
    const validPaths = treeEntries.map((entry) => entry.path);
    syncTree(props.threadId, validPaths);
  }, [props.threadId, syncTree, treeEntries]);

  useEffect(() => {
    if (activeFilePath || treeEntries.length === 0) {
      return;
    }
    const firstFile = treeEntries.find((entry) => entry.kind === "file");
    if (firstFile) {
      openFile(props.threadId, firstFile.path);
    }
  }, [activeFilePath, openFile, props.threadId, treeEntries]);
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.gitCwd,
      relativePath: activeFilePath,
      enabled: activeFilePath !== null,
    }),
  );
  const activeFileSavedContents = activeFileQuery.data?.contents;

  useEffect(() => {
    if (!activeFilePath || activeFileSavedContents === undefined) {
      return;
    }
    hydrateFile(props.threadId, activeFilePath, activeFileSavedContents);
  }, [activeFilePath, activeFileSavedContents, hydrateFile, props.threadId]);

  const activeDraft = activeFilePath ? draftsByFilePath[activeFilePath] : null;
  const activeFileDirty = activeDraft
    ? activeDraft.draftContents !== activeDraft.savedContents
    : false;
  const activeFileContents = activeDraft?.draftContents ?? activeFileQuery.data?.contents ?? "";
  const activeFileSizeBytes =
    activeFileQuery.data?.sizeBytes ?? new Blob([activeFileContents]).size;

  const saveMutation = useMutation({
    mutationFn: async (input: { relativePath: string; contents: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.writeFile({
        cwd: props.gitCwd,
        relativePath: input.relativePath,
        contents: input.contents,
      });
    },
    onSuccess: (_result, variables) => {
      markFileSaved(props.threadId, variables.relativePath, variables.contents);
      queryClient.setQueryData(projectQueryKeys.readFile(props.gitCwd, variables.relativePath), {
        relativePath: variables.relativePath,
        contents: variables.contents,
        sizeBytes: new Blob([variables.contents]).size,
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listTree(props.gitCwd) });
      toastManager.add({
        type: "success",
        title: "File saved",
        description: variables.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        type: "error",
        title: "Could not save file",
        description:
          error instanceof Error ? error.message : `Failed to save ${variables.relativePath}.`,
      });
    },
  });

  const handleSave = useCallback(() => {
    if (!activeFilePath || !activeDraft || !props.gitCwd || saveMutation.isPending) {
      return;
    }
    void saveMutation.mutate({
      relativePath: activeFilePath,
      contents: activeDraft.draftContents,
    });
  }, [activeDraft, activeFilePath, props.gitCwd, saveMutation]);

  saveActionRef.current = handleSave;

  const handleEditorMount = useCallback<OnMount>((editor, monacoInstance) => {
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () =>
      saveActionRef.current(),
    );
  }, []);

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

    const visibleExpandedDirectoryPaths = new Set([
      ...expandedDirectoryPaths,
      ...collectAncestorDirectories(activeFilePath),
    ]);
    return buildTreeRows(treeEntries, visibleExpandedDirectoryPaths);
  }, [activeFilePath, deferredTreeSearch, expandedDirectoryPaths, treeEntries]);

  const expandedDirectoryPathSet = useMemo(
    () => new Set([...expandedDirectoryPaths, ...collectAncestorDirectories(activeFilePath)]),
    [activeFilePath, expandedDirectoryPaths],
  );

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    estimateSize: () => 32,
    getScrollElement: () => treeScrollRef.current,
    overscan: 12,
  });

  const resizeStateRef = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(
    null,
  );
  const handleTreeResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      resizeStateRef.current = {
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
      const state = resizeStateRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }
      setTreeWidth(props.threadId, state.startWidth + (event.clientX - state.startX));
    },
    [props.threadId, setTreeWidth],
  );
  const handleTreeResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const activeTabDirty = useMemo(
    () =>
      new Set(
        Object.entries(draftsByFilePath)
          .filter(([, draft]) => draft.draftContents !== draft.savedContents)
          .map(([path]) => path),
      ),
    [draftsByFilePath],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "border-b border-border/70 px-3 sm:px-5",
          isElectron ? "drag-region flex h-13 items-center" : "py-2.5",
        )}
      >
        <div className="@container/editor-header flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="flex min-w-0 flex-col">
              <span
                className="truncate text-sm font-medium text-foreground"
                title={props.activeThreadTitle}
              >
                {props.activeThreadTitle}
              </span>
              <span className="truncate text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
                Workspace instrument
              </span>
            </div>
            {props.workspaceName ? (
              <Badge variant="outline" className="min-w-0 max-w-40 overflow-hidden">
                <span className="truncate">{props.workspaceName}</span>
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <WorkspaceModeToggle mode={props.mode} onModeChange={props.onModeChange} />
            {props.workspaceName ? (
              <OpenInPicker
                keybindings={props.keybindings}
                availableEditors={props.availableEditors}
                openInCwd={props.gitCwd}
              />
            ) : null}
            {props.workspaceName ? (
              <GitActionsControl gitCwd={props.gitCwd} activeThreadId={props.threadId} />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={props.terminalOpen}
                    onPressedChange={props.onToggleTerminal}
                    aria-label="Toggle terminal drawer"
                    variant="outline"
                    size="xs"
                    disabled={!props.terminalAvailable}
                  >
                    <TerminalSquareIcon className="size-3" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">
                {!props.terminalAvailable
                  ? "Terminal is unavailable until this thread has an active project."
                  : props.terminalToggleShortcutLabel
                    ? `Toggle terminal drawer (${props.terminalToggleShortcutLabel})`
                    : "Toggle terminal drawer"}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={props.diffOpen}
                    onPressedChange={props.onToggleDiff}
                    aria-label="Toggle diff panel"
                    variant="outline"
                    size="xs"
                    disabled={!props.isGitRepo}
                  >
                    <DiffIcon className="size-3" />
                  </Toggle>
                }
              />
              <TooltipPopup side="bottom">
                {!props.isGitRepo
                  ? "Diff panel is unavailable because this project is not a git repository."
                  : props.diffToggleShortcutLabel
                    ? `Toggle diff panel (${props.diffToggleShortcutLabel})`
                    : "Toggle diff panel"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 opacity-100",
            resolvedTheme === "dark"
              ? "bg-[radial-gradient(circle_at_top_left,rgba(247,162,103,0.12),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_20%)]"
              : "bg-[radial-gradient(circle_at_top_left,rgba(159,79,29,0.08),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.76),transparent_18%)]",
          )}
        />
        <div
          className="relative grid h-full min-h-0 min-w-0"
          style={{
            gridTemplateColumns: `minmax(220px, ${treeWidth}px) 6px minmax(0, 1fr)`,
          }}
        >
          <aside
            className={cn(
              "flex min-h-0 min-w-0 flex-col border-r border-border/60",
              resolvedTheme === "dark" ? "bg-[#0e1318]/96" : "bg-[#f7f1e6]/90",
            )}
          >
            <div className="border-b border-border/60 px-3 py-3">
              <div className="mb-2 flex items-center gap-2">
                <FolderIcon className="size-4 text-muted-foreground/80" />
                <span className="text-[11px] font-semibold tracking-[0.24em] text-muted-foreground uppercase">
                  Workspace
                </span>
                {workspaceTreeQuery.data?.truncated ? (
                  <Badge variant="outline" className="ml-auto text-[10px] uppercase">
                    Partial
                  </Badge>
                ) : null}
              </div>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  value={treeSearch}
                  onChange={(event) => setTreeSearch(event.target.value)}
                  placeholder="Filter files"
                  className="pl-8"
                  size="sm"
                  type="search"
                />
              </div>
            </div>

            <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {workspaceTreeQuery.isPending ? (
                <div className="space-y-2 px-1 py-2">
                  {Array.from({ length: 10 }, (_, index) => (
                    <div
                      key={index}
                      className="h-8 rounded-lg bg-foreground/6"
                      style={{ opacity: 1 - index * 0.06 }}
                    />
                  ))}
                </div>
              ) : visibleRows.length === 0 ? (
                <div className="px-2 py-6 text-sm text-muted-foreground">
                  {deferredTreeSearch.length > 0
                    ? "No files match this filter."
                    : "No files found."}
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
                          activeFilePath={activeFilePath}
                          expandedDirectoryPaths={expandedDirectoryPathSet}
                          onOpenFile={(filePath) => openFile(props.threadId, filePath)}
                          onToggleDirectory={(directoryPath) =>
                            toggleDirectory(props.threadId, directoryPath)
                          }
                          resolvedTheme={resolvedTheme}
                          row={row}
                          searchMode={deferredTreeSearch.length > 0}
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
            className="relative cursor-col-resize bg-border/80 hover:bg-primary/35"
            onPointerDown={handleTreeResizeStart}
            onPointerMove={handleTreeResizeMove}
            onPointerUp={handleTreeResizeEnd}
            onPointerCancel={handleTreeResizeEnd}
          />

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div
              className={cn(
                "border-b border-border/60 px-3 pt-2",
                resolvedTheme === "dark" ? "bg-[#0b0d10]" : "bg-[#fcfaf5]",
              )}
            >
              <div className="scrollbar-thin flex min-h-11 items-end gap-2 overflow-x-auto pb-2">
                {openFilePaths.map((filePath) => {
                  const isActive = filePath === activeFilePath;
                  const isDirty = activeTabDirty.has(filePath);
                  return (
                    <button
                      key={filePath}
                      type="button"
                      className={cn(
                        "group flex h-9 items-center gap-2 rounded-t-xl border border-b-0 px-3 text-sm transition-colors",
                        isActive
                          ? resolvedTheme === "dark"
                            ? "border-border/70 bg-[#14181d] text-foreground"
                            : "border-border/70 bg-[#ffffff] text-foreground"
                          : "border-transparent bg-transparent text-muted-foreground hover:border-border/50 hover:bg-foreground/4 hover:text-foreground",
                      )}
                      onClick={() => setActiveFile(props.threadId, filePath)}
                    >
                      <VscodeEntryIcon
                        pathValue={filePath}
                        kind="file"
                        theme={resolvedTheme}
                        className="size-4"
                      />
                      <span className="max-w-44 truncate">{basenameOfPath(filePath)}</span>
                      {isDirty ? <span className="size-1.5 rounded-full bg-amber-500" /> : null}
                      <span
                        className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeFile(props.threadId, filePath);
                        }}
                      >
                        <XIcon className="size-3.5" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className={cn(
                "min-h-0 min-w-0 flex-1",
                resolvedTheme === "dark" ? "bg-[#0b0d10]" : "bg-[#fcfaf5]",
              )}
            >
              {!activeFilePath ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <FolderIcon className="size-8 text-muted-foreground/50" />
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Choose a file to start editing.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      The editor stays out of the chat bundle until you switch into this mode.
                    </p>
                  </div>
                </div>
              ) : activeFileQuery.isPending && !activeDraft ? (
                <div className="space-y-4 px-6 py-6">
                  <div className="h-5 w-52 rounded bg-foreground/6" />
                  <div className="h-4 w-full rounded bg-foreground/4" />
                  <div className="h-4 w-[88%] rounded bg-foreground/4" />
                  <div className="h-4 w-[76%] rounded bg-foreground/4" />
                </div>
              ) : activeFileQuery.isError && !activeDraft ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      This file could not be opened.
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {activeFileQuery.error instanceof Error
                        ? activeFileQuery.error.message
                        : "An unexpected error occurred."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="h-full min-h-0 min-w-0">
                  <Editor
                    key={`${activeFilePath}:${resolvedTheme}`}
                    height="100%"
                    path={activeFilePath}
                    value={activeFileContents}
                    theme={resolvedTheme === "dark" ? "t3code-carbon" : "t3code-paper"}
                    onMount={handleEditorMount}
                    onChange={(value) => {
                      if (!activeFilePath || value === undefined) {
                        return;
                      }
                      updateDraft(props.threadId, activeFilePath, value);
                    }}
                    options={{
                      automaticLayout: true,
                      cursorBlinking: "smooth",
                      fontLigatures: true,
                      fontSize: 13.5,
                      minimap: { enabled: false },
                      padding: { top: 20, bottom: 24 },
                      renderLineHighlightOnlyWhenFocus: true,
                      roundedSelection: true,
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      stickyScroll: { enabled: true },
                      tabSize: 2,
                      wordWrap: "off",
                    }}
                  />
                </div>
              )}
            </div>

            <footer
              className={cn(
                "flex min-h-11 items-center justify-between gap-3 border-t border-border/60 px-3 text-[11px]",
                resolvedTheme === "dark"
                  ? "bg-[#0c1015] text-muted-foreground"
                  : "bg-[#f4efe4] text-muted-foreground",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {activeFilePath ? (
                  <>
                    <Badge
                      variant="outline"
                      className="border-border/70 bg-transparent font-mono text-[10px]"
                    >
                      {activeFilePath}
                    </Badge>
                    <span>{Math.round(activeFileSizeBytes / 1024)} KB</span>
                    {activeFileDirty ? (
                      <span className="font-semibold tracking-[0.18em] text-amber-600 uppercase">
                        Unsaved
                      </span>
                    ) : (
                      <span className="tracking-[0.18em] uppercase">Synced</span>
                    )}
                  </>
                ) : (
                  <span>Select a file from the workspace tree.</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {activeFilePath && activeFileDirty ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => discardDraft(props.threadId, activeFilePath)}
                  >
                    Revert
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!activeFilePath || !activeFileDirty || saveMutation.isPending}
                >
                  {saveMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
