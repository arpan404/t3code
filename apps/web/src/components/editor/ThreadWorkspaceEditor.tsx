import { loader } from "@monaco-editor/react";
import type { ProjectEntry, ResolvedKeybindingsConfig, ThreadId } from "@ace/contracts";
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
  type ThreadEditorRowState,
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { readExplorerEntryTransferPath, writeExplorerEntryTransfer } from "./dragTransfer";
import WorkspaceEditorPane from "./WorkspaceEditorPane";

let monacoConfigured = false;
const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function updateLanguageDiagnosticsOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setDiagnosticsOptions = Reflect.get(defaults, "setDiagnosticsOptions");
  if (typeof setDiagnosticsOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "diagnosticsOptions");
  setDiagnosticsOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setOptions = Reflect.get(defaults, "setOptions");
  if (typeof setOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "options");
  setOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateModeConfiguration(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setModeConfiguration = Reflect.get(defaults, "setModeConfiguration");
  if (typeof setModeConfiguration !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "modeConfiguration");
  setModeConfiguration.call(defaults, updater(isRecord(current) ? current : {}));
}

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
  const typescriptNamespace = Reflect.get(monaco.languages, "typescript");
  const jsonNamespace = Reflect.get(monaco.languages, "json");
  const cssNamespace = Reflect.get(monaco.languages, "css");
  const htmlNamespace = Reflect.get(monaco.languages, "html");

  updateLanguageDiagnosticsOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageDiagnosticsOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
    ...current,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: true,
  }));
  updateLanguageDiagnosticsOptions(jsonNamespace, "jsonDefaults", (current) => ({
    ...current,
    schemaRequest: "ignore",
    schemaValidation: "ignore",
    validate: false,
  }));
  updateModeConfiguration(jsonNamespace, "jsonDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "cssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "cssDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "scssDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "scssDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateLanguageOptions(cssNamespace, "lessDefaults", (current) => ({
    ...current,
    validate: false,
  }));
  updateModeConfiguration(cssNamespace, "lessDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "htmlDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "handlebarDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  updateModeConfiguration(htmlNamespace, "razorDefaults", (current) => ({
    ...current,
    diagnostics: false,
  }));
  monaco.editor.defineTheme("ace-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c7084" },
      { token: "keyword", foreground: "f7a267" },
      { token: "string", foreground: "8dc891" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme("ace-paper", {
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

type ExplorerInlineEntryState =
  | {
      kind: "create-file";
      parentPath: string | null;
      value: string;
    }
  | {
      kind: "create-folder";
      parentPath: string | null;
      value: string;
    }
  | {
      entry: ProjectEntry;
      kind: "rename";
      parentPath: string | null;
      value: string;
    };

type ExplorerRenderRow =
  | {
      kind: "entry";
      key: string;
      row: TreeRow;
    }
  | {
      depth: number;
      key: string;
      kind: "inline";
      state: ExplorerInlineEntryState;
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

function pathForDialogInput(parentPath: string | null, value: string): string {
  const trimmed = value.trim().replace(/^\.\//, "");
  return parentPath ? `${parentPath}/${trimmed}` : trimmed;
}

function isAncestorPath(pathValue: string, maybeAncestor: string): boolean {
  return pathValue === maybeAncestor || pathValue.startsWith(`${maybeAncestor}/`);
}

function movePathToParent(pathValue: string, nextParentPath: string | null): string {
  const name = basenameOfPath(pathValue);
  return nextParentPath ? `${nextParentPath}/${name}` : name;
}

function buildExplorerRenderRows(
  rows: readonly TreeRow[],
  inlineState: ExplorerInlineEntryState | null,
): ExplorerRenderRow[] {
  const baseRows = rows.map<ExplorerRenderRow>((row) => ({
    kind: "entry",
    key: row.entry.path,
    row,
  }));
  if (!inlineState) {
    return baseRows;
  }

  if (inlineState.kind === "rename") {
    const renameIndex = rows.findIndex((row) => row.entry.path === inlineState.entry.path);
    if (renameIndex < 0) {
      return baseRows;
    }
    const targetRow = rows[renameIndex];
    if (!targetRow) {
      return baseRows;
    }
    baseRows.splice(renameIndex, 1, {
      depth: targetRow.depth,
      key: `inline:${inlineState.entry.path}`,
      kind: "inline",
      state: inlineState,
    });
    return baseRows;
  }

  const parentIndex = inlineState.parentPath
    ? rows.findIndex((row) => row.entry.path === inlineState.parentPath)
    : -1;
  let insertIndex = baseRows.length;
  let depth = 0;
  if (parentIndex >= 0) {
    const parentRow = rows[parentIndex];
    if (parentRow) {
      depth = parentRow.depth + 1;
      insertIndex = parentIndex + 1;
      while (insertIndex < rows.length && (rows[insertIndex]?.depth ?? 0) > parentRow.depth) {
        insertIndex += 1;
      }
    }
  }

  baseRows.splice(insertIndex, 0, {
    depth,
    key: `inline:${inlineState.kind}:${inlineState.parentPath ?? "root"}`,
    kind: "inline",
    state: inlineState,
  });
  return baseRows;
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
  dragTargetPath: string | null;
  expandedDirectoryPaths: ReadonlySet<string>;
  focusedFilePath: string | null;
  onDropEntry: (sourcePath: string, targetParentPath: string | null) => void;
  onFocusEntry: (path: string) => void;
  onHoverDropTarget: (targetParentPath: string | null) => void;
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
  const dropTargetPath =
    props.row.kind === "directory" ? props.row.entry.path : (props.row.entry.parentPath ?? null);
  const isDropTarget = props.dragTargetPath !== null && props.dragTargetPath === dropTargetPath;
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
            ? "bg-foreground/6 text-foreground"
            : isDropTarget
              ? "bg-primary/10 text-foreground"
              : isOpen
                ? "bg-foreground/4 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      data-explorer-path={props.row.entry.path}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 14}px`,
      }}
      draggable
      onClick={(event) => {
        props.onSelectEntry(props.row.entry.path);
        if (props.row.kind === "directory") {
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path, event.altKey || event.metaKey);
      }}
      onFocus={() => {
        props.onFocusEntry(props.row.entry.path);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        writeExplorerEntryTransfer(event.dataTransfer, {
          kind: props.row.entry.kind,
          path: props.row.entry.path,
        });
      }}
      onDragOver={(event) => {
        if (!readExplorerEntryTransferPath(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onHoverDropTarget(dropTargetPath);
      }}
      onDragLeave={() => {
        props.onHoverDropTarget(null);
      }}
      onDrop={(event) => {
        const path = readExplorerEntryTransferPath(event.dataTransfer);
        if (!path) {
          return;
        }
        event.preventDefault();
        props.onHoverDropTarget(null);
        props.onDropEntry(path, dropTargetPath);
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

const InlineExplorerRow = memo(function InlineExplorerRow(props: {
  depth: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onChangeValue: (value: string) => void;
  onCommit: () => void;
  resolvedTheme: "light" | "dark";
  searchMode: boolean;
  state: ExplorerInlineEntryState;
}) {
  return (
    <div
      className="flex h-8 w-full items-center gap-2 rounded-lg bg-primary/8 px-2"
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.depth * 14}px`,
      }}
    >
      <span className="size-3.5 shrink-0" />
      <VscodeEntryIcon
        pathValue={
          props.state.kind === "rename"
            ? props.state.entry.path
            : props.state.kind === "create-folder"
              ? `${props.state.parentPath ?? "folder"}/folder`
              : `${props.state.parentPath ?? "file"}/file.ts`
        }
        kind={props.state.kind === "create-folder" ? "directory" : "file"}
        theme={props.resolvedTheme}
        className="size-4"
      />
      <Input
        ref={props.inputRef}
        value={props.state.value}
        onChange={(event) => props.onChangeValue(event.target.value)}
        onBlur={() => {
          if (props.state.value.trim().length === 0) {
            props.onCancel();
            return;
          }
          props.onCommit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onCommit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
        className="h-7"
        size="sm"
      />
    </div>
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
    neovimMode: settings.editorNeovimMode,
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
  const editorGridRef = useRef<HTMLDivElement | null>(null);
  const rowGroupRefs = useRef(new Map<string, HTMLDivElement | null>());
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
  const setRowRatios = useEditorStateStore((state) => state.setRowRatios);
  const setTreeWidth = useEditorStateStore((state) => state.setTreeWidth);
  const splitPane = useEditorStateStore((state) => state.splitPane);
  const syncTree = useEditorStateStore((state) => state.syncTree);
  const toggleDirectory = useEditorStateStore((state) => state.toggleDirectory);
  const updateDraft = useEditorStateStore((state) => state.updateDraft);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [inlineEntryState, setInlineEntryState] = useState<ExplorerInlineEntryState | null>(null);
  const [dragTargetParentPath, setDragTargetParentPath] = useState<string | null>(null);
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
  const {
    activePaneId,
    draftsByFilePath,
    expandedDirectoryPaths,
    paneRatios,
    panes,
    rows,
    treeWidth,
  } = editorState;
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null,
    [activePaneId, panes],
  );
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane] as const)), [panes]);
  const openWorkspaceFilePaths = useMemo(
    () => Array.from(new Set(panes.flatMap((pane) => pane.openFilePaths))).sort(),
    [panes],
  );
  const previousWorkspaceBufferStateRef = useRef<{
    cwd: string | null;
    filePaths: ReadonlySet<string>;
  }>({
    cwd: null,
    filePaths: new Set<string>(),
  });
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

  useEffect(() => {
    const previous = previousWorkspaceBufferStateRef.current;
    const nextFilePaths = new Set(openWorkspaceFilePaths);
    const removedFilePaths =
      previous.cwd && previous.cwd !== props.gitCwd
        ? Array.from(previous.filePaths)
        : previous.cwd
          ? Array.from(previous.filePaths).filter((filePath) => !nextFilePaths.has(filePath))
          : [];

    if (api && previous.cwd && removedFilePaths.length > 0) {
      const previousCwd = previous.cwd;
      void Promise.allSettled(
        removedFilePaths.map((relativePath) =>
          api.workspaceEditor.closeBuffer({
            cwd: previousCwd,
            relativePath,
          }),
        ),
      ).then((results) => {
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            console.error("Failed to close workspace editor buffer", {
              cwd: previousCwd,
              relativePath: removedFilePaths[index],
              error: result.reason,
            });
          }
        }
      });
    }

    previousWorkspaceBufferStateRef.current = {
      cwd: props.gitCwd,
      filePaths: nextFilePaths,
    };
  }, [api, openWorkspaceFilePaths, props.gitCwd]);

  useEffect(
    () => () => {
      const previous = previousWorkspaceBufferStateRef.current;
      if (!api || !previous.cwd || previous.filePaths.size === 0) {
        return;
      }
      const previousCwd = previous.cwd;
      void Promise.allSettled(
        Array.from(previous.filePaths).map((relativePath) =>
          api.workspaceEditor.closeBuffer({
            cwd: previousCwd,
            relativePath,
          }),
        ),
      );
    },
    [api],
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
    if (!inlineEntryState) {
      return;
    }
    const timer = window.setTimeout(() => {
      entryDialogInputRef.current?.focus();
      entryDialogInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inlineEntryState]);

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

  const normalizedRowRatios = useMemo(
    () => normalizePaneRatios(paneRatios, rows.length),
    [paneRatios, rows.length],
  );
  const layoutRows = useMemo(
    () =>
      rows
        .map((row) => {
          const rowPanes = row.paneIds
            .map((paneId) => panesById.get(paneId) ?? null)
            .filter((pane): pane is NonNullable<typeof pane> => pane !== null);
          if (rowPanes.length === 0) {
            return null;
          }
          return {
            ...row,
            paneRatios: normalizePaneRatios(row.paneRatios, rowPanes.length),
            panes: rowPanes,
          };
        })
        .filter((row): row is ThreadEditorRowState & { panes: typeof panes } => row !== null),
    [panesById, rows],
  );
  const orderedPaneIds = useMemo(() => layoutRows.flatMap((row) => row.paneIds), [layoutRows]);

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
  const explorerRows = useMemo(
    () => buildExplorerRenderRows(visibleRows, inlineEntryState),
    [inlineEntryState, visibleRows],
  );

  const rowVirtualizer = useVirtualizer({
    count: explorerRows.length,
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
    rowId: string;
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart = useCallback(
    (rowId: string, dividerIndex: number, ratios: readonly number[]) =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        paneResizeStateRef.current = {
          dividerIndex,
          pointerId: event.pointerId,
          rowId,
          startRatios: [...ratios],
          startX: event.clientX,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      },
    [],
  );
  const handlePaneResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = paneResizeStateRef.current;
      const container = rowGroupRefs.current.get(resizeState?.rowId ?? "") ?? null;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      setPaneRatios(
        props.threadId,
        resizeState.rowId,
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

  const rowResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    startRatios: number[];
    startY: number;
  } | null>(null);
  const handleRowResizeStart = useCallback(
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      rowResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        startRatios: normalizedRowRatios,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [normalizedRowRatios],
  );
  const handleRowResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = rowResizeStateRef.current;
      const container = editorGridRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      setRowRatios(
        props.threadId,
        resizePaneRatios({
          containerWidthPx: container.clientHeight,
          deltaPx: event.clientY - resizeState.startY,
          dividerIndex: resizeState.dividerIndex,
          minPaneWidthPx: 220,
          ratios: resizeState.startRatios,
        }),
      );
    },
    [props.threadId, setRowRatios],
  );
  const handleRowResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = rowResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    rowResizeStateRef.current = null;
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
    (paneId?: string, filePath?: string, direction: "down" | "right" = "right") => {
      const createdPaneId = splitPane(props.threadId, {
        direction,
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

  const focusExplorerEntry = useCallback((path: string) => {
    const target = treeScrollRef.current?.querySelector<HTMLElement>(
      `[data-explorer-path="${CSS.escape(path)}"]`,
    );
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, []);

  const startInlineEntry = useCallback(
    (state: ExplorerInlineEntryState) => {
      if (state.parentPath) {
        expandDirectories(
          props.threadId,
          collectAncestorDirectories(state.parentPath).concat(state.parentPath),
        );
      }
      setInlineEntryState(state);
    },
    [expandDirectories, props.threadId],
  );

  const cancelInlineEntry = useCallback(() => {
    setInlineEntryState(null);
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
      setInlineEntryState(null);
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
      setInlineEntryState(null);
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
        startInlineEntry({ kind: "create-file", parentPath, value: "" });
        return;
      }
      if (clicked === "new-folder") {
        startInlineEntry({ kind: "create-folder", parentPath, value: "" });
        return;
      }
      if (clicked === "rename" && entry) {
        startInlineEntry({
          kind: "rename",
          entry,
          parentPath: entry.parentPath ?? null,
          value: basenameOfPath(entry.path),
        });
        return;
      }
      if (clicked === "delete" && entry) {
        await handleDeleteEntry(entry);
      }
    },
    [api, handleDeleteEntry, startInlineEntry],
  );

  const submitInlineEntry = useCallback(() => {
    if (!inlineEntryState) {
      return;
    }

    const relativePath = pathForDialogInput(inlineEntryState.parentPath, inlineEntryState.value);
    if (
      relativePath.length === 0 ||
      inlineEntryState.value.trim() === "." ||
      inlineEntryState.value.trim() === ".."
    ) {
      toastManager.add({
        description: "Enter a valid workspace-relative name.",
        title: "Name required",
        type: "error",
      });
      return;
    }

    if (inlineEntryState.kind === "rename") {
      void renameEntryMutation.mutate({
        kind: inlineEntryState.entry.kind,
        nextRelativePath: relativePath,
        relativePath: inlineEntryState.entry.path,
      });
      return;
    }

    void createEntryMutation.mutate({
      kind: inlineEntryState.kind === "create-folder" ? "directory" : "file",
      relativePath,
    });
  }, [createEntryMutation, inlineEntryState, renameEntryMutation]);

  const moveExplorerEntry = useCallback(
    (sourcePath: string, targetParentPath: string | null) => {
      const sourceEntry = entryByPath.get(sourcePath);
      if (!sourceEntry) {
        return;
      }
      if (
        targetParentPath !== null &&
        sourceEntry.kind === "directory" &&
        isAncestorPath(targetParentPath, sourcePath)
      ) {
        return;
      }
      const nextRelativePath = movePathToParent(sourcePath, targetParentPath);
      if (nextRelativePath === sourcePath) {
        return;
      }
      void renameEntryMutation.mutate({
        kind: sourceEntry.kind,
        nextRelativePath,
        relativePath: sourcePath,
      });
      setDragTargetParentPath(null);
    },
    [entryByPath, renameEntryMutation],
  );

  const selectedVisibleEntryIndex = useMemo(
    () => visibleRows.findIndex((row) => row.entry.path === focusedExplorerEntryPath),
    [focusedExplorerEntryPath, visibleRows],
  );

  const handleExplorerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (inlineEntryState || visibleRows.length === 0) {
        return;
      }
      const currentIndex = selectedVisibleEntryIndex >= 0 ? selectedVisibleEntryIndex : 0;
      const currentRow = visibleRows[currentIndex];
      if (!currentRow) {
        return;
      }

      const selectRowAtIndex = (index: number) => {
        const nextRow = visibleRows[Math.max(0, Math.min(index, visibleRows.length - 1))];
        if (!nextRow) {
          return;
        }
        setSelectedEntryPath(nextRow.entry.path);
        focusExplorerEntry(nextRow.entry.path);
      };

      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectRowAtIndex(currentIndex + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectRowAtIndex(currentIndex - 1);
        return;
      }
      if (event.key === "ArrowRight") {
        if (currentRow.kind === "directory") {
          event.preventDefault();
          if (!expandedDirectoryPathSet.has(currentRow.entry.path)) {
            toggleDirectory(props.threadId, currentRow.entry.path);
            return;
          }
          const nextRow = visibleRows[currentIndex + 1];
          if (nextRow && nextRow.depth > currentRow.depth) {
            setSelectedEntryPath(nextRow.entry.path);
            focusExplorerEntry(nextRow.entry.path);
          }
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        if (
          currentRow.kind === "directory" &&
          expandedDirectoryPathSet.has(currentRow.entry.path)
        ) {
          event.preventDefault();
          toggleDirectory(props.threadId, currentRow.entry.path);
          return;
        }
        const parentPath = currentRow.entry.parentPath ?? null;
        if (parentPath) {
          event.preventDefault();
          setSelectedEntryPath(parentPath);
          focusExplorerEntry(parentPath);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (currentRow.kind === "directory") {
          toggleDirectory(props.threadId, currentRow.entry.path);
          return;
        }
        handleOpenFile(currentRow.entry.path, false);
        return;
      }
      if (event.key === "F2") {
        event.preventDefault();
        startInlineEntry({
          kind: "rename",
          entry: currentRow.entry,
          parentPath: currentRow.entry.parentPath ?? null,
          value: basenameOfPath(currentRow.entry.path),
        });
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && focusedExplorerEntry) {
        event.preventDefault();
        void handleDeleteEntry(focusedExplorerEntry);
      }
    },
    [
      expandedDirectoryPathSet,
      focusExplorerEntry,
      focusedExplorerEntry,
      handleDeleteEntry,
      handleOpenFile,
      inlineEntryState,
      props.threadId,
      selectedVisibleEntryIndex,
      startInlineEntry,
      toggleDirectory,
      visibleRows,
    ],
  );

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
      handleSplitPane(paneId, filePath, "right");
    },
    [handleSplitPane],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !activePane) {
        return;
      }
      if (inlineEntryState || document.activeElement === treeSearchInputRef.current) {
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
        handleSplitPane(activePane.id, undefined, "right");
        return;
      }

      if (command === "editor.splitDown") {
        event.preventDefault();
        event.stopPropagation();
        handleSplitPane(activePane.id, undefined, "down");
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
        startInlineEntry({
          kind: "create-file",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
          value: "",
        });
        return;
      }

      if (command === "editor.newFolder") {
        event.preventDefault();
        event.stopPropagation();
        startInlineEntry({
          kind: "create-folder",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
          value: "",
        });
        return;
      }

      if (command === "editor.rename") {
        if (!focusedExplorerEntry) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        startInlineEntry({
          kind: "rename",
          entry: focusedExplorerEntry,
          parentPath: focusedExplorerEntry.parentPath ?? null,
          value: basenameOfPath(focusedExplorerEntry.path),
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
        const currentIndex = orderedPaneIds.indexOf(activePane.id);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.focusNextWindow" ? 1 : -1;
        const nextPaneId =
          orderedPaneIds[(currentIndex + offset + orderedPaneIds.length) % orderedPaneIds.length];
        const nextPane = panesById.get(nextPaneId ?? "") ?? null;
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
    focusedExplorerEntry,
    handleSplitPane,
    handleReopenClosedTab,
    inlineEntryState,
    moveFile,
    orderedPaneIds,
    panes,
    panesById,
    props.browserOpen,
    props.keybindings,
    props.terminalOpen,
    props.threadId,
    setActiveFile,
    setActivePane,
    startInlineEntry,
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
                startInlineEntry({
                  kind: "create-file",
                  parentPath:
                    focusedExplorerEntry?.kind === "directory"
                      ? focusedExplorerEntry.path
                      : (focusedExplorerEntry?.parentPath ?? null),
                  value: "",
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
                startInlineEntry({
                  kind: "create-folder",
                  parentPath:
                    focusedExplorerEntry?.kind === "directory"
                      ? focusedExplorerEntry.path
                      : (focusedExplorerEntry?.parentPath ?? null),
                  value: "",
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
            tabIndex={0}
            onKeyDown={handleExplorerKeyDown}
            onDragOver={(event) => {
              if (!readExplorerEntryTransferPath(event.dataTransfer)) {
                return;
              }
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDragTargetParentPath(null);
            }}
            onDrop={(event) => {
              const path = readExplorerEntryTransferPath(event.dataTransfer);
              if (!path) {
                return;
              }
              event.preventDefault();
              moveExplorerEntry(path, null);
            }}
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
            ) : explorerRows.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {deferredTreeSearch.length > 0 ? "No files match this filter." : "No files found."}
              </div>
            ) : (
              <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = explorerRows[virtualRow.index];
                  if (!row) {
                    return null;
                  }
                  return (
                    <div
                      key={row.key}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {row.kind === "entry" ? (
                        <FileTreeRow
                          activeFilePaths={activeFilePathSet}
                          dragTargetPath={dragTargetParentPath}
                          expandedDirectoryPaths={expandedDirectoryPathSet}
                          focusedFilePath={activePane?.activeFilePath ?? null}
                          onDropEntry={(sourcePath, targetParentPath) => {
                            moveExplorerEntry(sourcePath, targetParentPath);
                          }}
                          onFocusEntry={setSelectedEntryPath}
                          onHoverDropTarget={setDragTargetParentPath}
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
                          row={row.row}
                          searchMode={deferredTreeSearch.length > 0}
                          selectedEntryPath={selectedEntryPath}
                        />
                      ) : (
                        <InlineExplorerRow
                          depth={row.depth}
                          inputRef={entryDialogInputRef}
                          onCancel={cancelInlineEntry}
                          onChangeValue={(value) =>
                            setInlineEntryState((current) =>
                              current ? { ...current, value } : current,
                            )
                          }
                          onCommit={submitInlineEntry}
                          resolvedTheme={resolvedTheme}
                          searchMode={deferredTreeSearch.length > 0}
                          state={row.state}
                        />
                      )}
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
            <div ref={editorGridRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {layoutRows.map((row, rowIndex) => (
                <div key={row.id} className="contents">
                  <div
                    className="flex min-h-0 min-w-0"
                    style={{
                      flexBasis: 0,
                      flexGrow: normalizedRowRatios[rowIndex] ?? 1,
                      minHeight: 0,
                    }}
                  >
                    <div
                      ref={(node) => {
                        rowGroupRefs.current.set(row.id, node);
                      }}
                      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                    >
                      {row.panes.map((pane, paneIndex) => (
                        <div
                          key={pane.id}
                          className="flex min-h-0 min-w-0"
                          style={{
                            flexBasis: 0,
                            flexGrow: row.paneRatios[paneIndex] ?? 1,
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
                            neovimModeEnabled={editorSettings.neovimMode}
                            onCloseFile={(paneId, filePath) =>
                              closeFile(props.threadId, filePath, paneId)
                            }
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
                            onSplitPane={(paneId) => handleSplitPane(paneId, undefined, "right")}
                            onSplitPaneDown={(paneId) => handleSplitPane(paneId, undefined, "down")}
                            onUpdateDraft={(filePath, contents) =>
                              updateDraft(props.threadId, filePath, contents)
                            }
                            pane={pane}
                            paneIndex={paneIndex}
                            resolvedTheme={resolvedTheme}
                            savingFilePath={
                              saveMutation.isPending
                                ? (saveMutation.variables?.relativePath ?? null)
                                : null
                            }
                          />
                          {paneIndex < row.panes.length - 1 ? (
                            <div
                              aria-label={`Resize between editor windows ${paneIndex + 1} and ${paneIndex + 2}`}
                              role="separator"
                              aria-orientation="vertical"
                              className="group relative z-10 -mx-0.75 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center touch-none select-none"
                              onPointerDown={handlePaneResizeStart(
                                row.id,
                                paneIndex,
                                row.paneRatios,
                              )}
                              onPointerMove={handlePaneResizeMove}
                              onPointerUp={handlePaneResizeEnd}
                              onPointerCancel={handlePaneResizeEnd}
                            >
                              <div className="h-full w-0.5 bg-border/40 transition-colors group-hover:bg-primary" />
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  {rowIndex < layoutRows.length - 1 ? (
                    <div
                      aria-label={`Resize between editor rows ${rowIndex + 1} and ${rowIndex + 2}`}
                      role="separator"
                      aria-orientation="horizontal"
                      className="group relative z-10 -my-0.75 flex h-1.5 shrink-0 cursor-row-resize items-center justify-center touch-none select-none"
                      onPointerDown={handleRowResizeStart(rowIndex)}
                      onPointerMove={handleRowResizeMove}
                      onPointerUp={handleRowResizeEnd}
                      onPointerCancel={handleRowResizeEnd}
                    >
                      <div className="h-0.5 w-full bg-border/40 transition-colors group-hover:bg-primary" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
