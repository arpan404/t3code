import Editor, { type OnMount } from "@monaco-editor/react";
import type { WorkspaceEditorDiagnostic } from "@ace/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  Columns2Icon,
  FolderIcon,
  RefreshCwIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react";
import { initVimMode, type VimAdapterInstance, VimMode } from "monaco-vim";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ThreadEditorPaneState } from "~/editorStateStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { EDITOR_TAB_TRANSFER_TYPE, readEditorTabTransfer } from "./dragTransfer";

interface WorkspaceEditorPaneProps {
  active: boolean;
  canClosePane: boolean;
  canReopenClosedTab: boolean;
  canSplitPane: boolean;
  dirtyFilePaths: ReadonlySet<string>;
  draftsByFilePath: Record<string, { draftContents: string; savedContents: string }>;
  editorOptions: MonacoEditor.IStandaloneEditorConstructionOptions;
  gitCwd: string | null;
  neovimModeEnabled: boolean;
  onCloseFile: (paneId: string, filePath: string) => void;
  onCloseOtherTabs: (paneId: string, filePath: string) => void;
  onClosePane: (paneId: string) => void;
  onCloseTabsToRight: (paneId: string, filePath: string) => void;
  onDiscardDraft: (filePath: string) => void;
  onFocusPane: (paneId: string) => void;
  onHydrateFile: (filePath: string, contents: string) => void;
  onMoveFile: (input: {
    filePath: string;
    sourcePaneId: string;
    targetPaneId: string;
    targetIndex?: number;
  }) => void;
  onOpenFileToSide: (paneId: string, filePath: string) => void;
  onReopenClosedTab: (paneId: string) => void;
  onRetryActiveFile: () => void;
  onSaveFile: (relativePath: string, contents: string) => void;
  onSetActiveFile: (paneId: string, filePath: string | null) => void;
  onSplitPane: (paneId: string) => void;
  onSplitPaneDown: (paneId: string) => void;
  onUpdateDraft: (filePath: string, contents: string) => void;
  pane: ThreadEditorPaneState;
  paneIndex: number;
  resolvedTheme: "light" | "dark";
  savingFilePath: string | null;
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 KB";
  }
  if (sizeBytes < 1024) {
    return "<1 KB";
  }
  return `${Math.round(sizeBytes / 1024)} KB`;
}

const WORKSPACE_EDITOR_MARKER_OWNER = "ace-workspace-editor";
const MONACO_DIAGNOSTIC_OWNERS = [
  WORKSPACE_EDITOR_MARKER_OWNER,
  "css",
  "scss",
  "less",
  "html",
  "handlebars",
  "razor",
  "json",
  "javascript",
  "typescript",
] as const;
const DIAGNOSTIC_SYNC_DEBOUNCE_MS = 250;
const VIM_CLOSE_ACTION_KEY = "__aceClose";

type MonacoApi = typeof import("monaco-editor");

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatDiagnosticSummary(diagnostics: readonly WorkspaceEditorDiagnostic[]): string | null {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let hintCount = 0;

  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case "error":
        errorCount += 1;
        break;
      case "warning":
        warningCount += 1;
        break;
      case "info":
        infoCount += 1;
        break;
      case "hint":
        hintCount += 1;
        break;
      default:
    }
  }

  const parts = [
    errorCount > 0 ? `${errorCount} ${pluralize(errorCount, "error")}` : null,
    warningCount > 0 ? `${warningCount} ${pluralize(warningCount, "warning")}` : null,
    infoCount > 0 ? `${infoCount} ${pluralize(infoCount, "info")}` : null,
    hintCount > 0 ? `${hintCount} ${pluralize(hintCount, "hint")}` : null,
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? parts.join(", ") : null;
}

function toMonacoSeverity(
  monacoInstance: MonacoApi,
  severity: WorkspaceEditorDiagnostic["severity"],
) {
  switch (severity) {
    case "warning":
      return monacoInstance.MarkerSeverity.Warning;
    case "info":
      return monacoInstance.MarkerSeverity.Info;
    case "hint":
      return monacoInstance.MarkerSeverity.Hint;
    case "error":
    default:
      return monacoInstance.MarkerSeverity.Error;
  }
}

function toMonacoMarkers(
  monacoInstance: MonacoApi,
  diagnostics: readonly WorkspaceEditorDiagnostic[],
): MonacoEditor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const startLineNumber = diagnostic.startLine + 1;
    const startColumn = diagnostic.startColumn + 1;
    const endLineNumber = diagnostic.endLine + 1;
    const endColumn =
      diagnostic.endLine === diagnostic.startLine
        ? Math.max(startColumn + 1, diagnostic.endColumn + 1)
        : Math.max(1, diagnostic.endColumn + 1);

    const marker: MonacoEditor.IMarkerData = {
      endColumn,
      endLineNumber,
      message: diagnostic.message.trim().length > 0 ? diagnostic.message : "Neovim diagnostic",
      severity: toMonacoSeverity(monacoInstance, diagnostic.severity),
      startColumn,
      startLineNumber,
    };
    if (diagnostic.code !== undefined) {
      marker.code = diagnostic.code;
    }
    if (diagnostic.source !== undefined) {
      marker.source = diagnostic.source;
    }
    return marker;
  });
}

function clearModelMarkers(monacoInstance: MonacoApi, model: MonacoEditor.ITextModel): void {
  for (const owner of MONACO_DIAGNOSTIC_OWNERS) {
    monacoInstance.editor.setModelMarkers(model, owner, []);
  }
}

function ensureMonacoVimConfigured(): void {
  const vimApi = Reflect.get(VimMode, "Vim");
  if (!vimApi || typeof vimApi !== "object") {
    return;
  }
  const defineEx = Reflect.get(vimApi, "defineEx");
  if (typeof defineEx !== "function") {
    return;
  }

  const registerExCommand = (name: string, prefix: string, handler: (adapter: object) => void) => {
    try {
      defineEx.call(vimApi, name, prefix, handler);
    } catch {
      // Ignore duplicate registrations during HMR or repeated mounts.
    }
  };

  registerExCommand("quit", "q", (adapter) => {
    const close = Reflect.get(adapter, VIM_CLOSE_ACTION_KEY);
    if (typeof close === "function") {
      close();
    }
  });
  registerExCommand("writequit", "wq", (adapter) => {
    const save = Reflect.get(adapter, "save");
    if (typeof save === "function") {
      save();
    }
    const close = Reflect.get(adapter, VIM_CLOSE_ACTION_KEY);
    if (typeof close === "function") {
      close();
    }
  });
  registerExCommand("xit", "x", (adapter) => {
    const save = Reflect.get(adapter, "save");
    if (typeof save === "function") {
      save();
    }
    const close = Reflect.get(adapter, VIM_CLOSE_ACTION_KEY);
    if (typeof close === "function") {
      close();
    }
  });
}

export default function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
  const api = readNativeApi();
  const pane = props.pane;
  const canReopenClosedTab = props.canReopenClosedTab;
  const onFocusPane = props.onFocusPane;
  const onHydrateFile = props.onHydrateFile;
  const onMoveFile = props.onMoveFile;
  const onCloseFile = props.onCloseFile;
  const onCloseOtherTabs = props.onCloseOtherTabs;
  const onCloseTabsToRight = props.onCloseTabsToRight;
  const onOpenFileToSide = props.onOpenFileToSide;
  const onReopenClosedTab = props.onReopenClosedTab;
  const onSaveFile = props.onSaveFile;
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [diagnosticSummary, setDiagnosticSummary] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [editorMountVersion, setEditorMountVersion] = useState(0);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const vimAdapterRef = useRef<VimAdapterInstance | null>(null);
  const vimStatusNodeRef = useRef<HTMLDivElement | null>(null);
  const syncRequestIdRef = useRef(0);
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.gitCwd,
      relativePath: pane.activeFilePath,
      enabled: pane.activeFilePath !== null && props.gitCwd !== null,
    }),
  );

  useEffect(() => {
    if (!pane.activeFilePath || activeFileQuery.data?.contents === undefined) {
      return;
    }
    onHydrateFile(pane.activeFilePath, activeFileQuery.data.contents);
  }, [activeFileQuery.data?.contents, onHydrateFile, pane.activeFilePath]);

  const activeDraft = pane.activeFilePath
    ? (props.draftsByFilePath[pane.activeFilePath] ?? null)
    : null;
  const activeFileContents = activeDraft?.draftContents ?? activeFileQuery.data?.contents ?? "";
  const activeFileDirty = activeDraft
    ? activeDraft.draftContents !== activeDraft.savedContents
    : false;
  const activeFileSizeBytes =
    activeFileQuery.data?.sizeBytes ?? new Blob([activeFileContents]).size;

  const handleSave = useCallback(() => {
    if (!pane.activeFilePath || !activeDraft) {
      return;
    }
    onSaveFile(pane.activeFilePath, activeDraft.draftContents);
  }, [activeDraft, onSaveFile, pane.activeFilePath]);
  const handleCloseActiveFile = useCallback(() => {
    if (!pane.activeFilePath) {
      return;
    }
    onCloseFile(pane.id, pane.activeFilePath);
  }, [onCloseFile, pane.activeFilePath, pane.id]);

  const saveActionRef = useRef(handleSave);
  useEffect(() => {
    saveActionRef.current = handleSave;
  }, [handleSave]);

  const closeActionRef = useRef(handleCloseActiveFile);
  useEffect(() => {
    closeActionRef.current = handleCloseActiveFile;
  }, [handleCloseActiveFile]);

  const disposeVimAdapter = useCallback(() => {
    vimAdapterRef.current?.dispose();
    vimAdapterRef.current = null;
    if (vimStatusNodeRef.current) {
      vimStatusNodeRef.current.replaceChildren();
      vimStatusNodeRef.current.textContent = "";
    }
  }, []);

  const bindVimAdapterActions = useCallback(() => {
    if (!vimAdapterRef.current) {
      return;
    }
    Reflect.set(vimAdapterRef.current, "save", () => {
      saveActionRef.current();
    });
    Reflect.set(vimAdapterRef.current, VIM_CLOSE_ACTION_KEY, () => {
      closeActionRef.current();
    });
  }, []);

  const clearEditorMarkers = useCallback(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoInstance || !model) {
      return;
    }
    clearModelMarkers(monacoInstance, model);
  }, []);

  const activeFileReady =
    pane.activeFilePath !== null &&
    (activeDraft !== null || activeFileQuery.data?.contents !== undefined);

  const handleEditorMount = useCallback<OnMount>(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;
      setEditorMountVersion((version) => version + 1);
      editor.onDidFocusEditorWidget(() => {
        onFocusPane(pane.id);
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        saveActionRef.current();
      });
      editor.onDidDispose(() => {
        disposeVimAdapter();
        editorRef.current = null;
        monacoRef.current = null;
      });
    },
    [disposeVimAdapter, onFocusPane, pane.id],
  );

  useEffect(() => {
    bindVimAdapterActions();
  }, [bindVimAdapterActions]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    if (!props.neovimModeEnabled) {
      disposeVimAdapter();
      return;
    }

    ensureMonacoVimConfigured();
    if (!vimAdapterRef.current) {
      vimAdapterRef.current = initVimMode(editor, vimStatusNodeRef.current);
    }
    bindVimAdapterActions();

    return () => {
      disposeVimAdapter();
    };
  }, [bindVimAdapterActions, disposeVimAdapter, editorMountVersion, props.neovimModeEnabled]);

  useEffect(() => {
    syncRequestIdRef.current += 1;
    const requestId = syncRequestIdRef.current;

    if (
      !api ||
      !props.gitCwd ||
      !pane.activeFilePath ||
      !activeFileReady ||
      !editorRef.current ||
      !monacoRef.current
    ) {
      clearEditorMarkers();
      setDiagnosticError(null);
      setDiagnosticSummary(null);
      return;
    }

    const editor = editorRef.current;
    const activeFilePath = pane.activeFilePath;
    const model = editor.getModel();
    if (!model || !activeFilePath) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void api.workspaceEditor
        .syncBuffer({
          cwd: props.gitCwd!,
          relativePath: activeFilePath,
          contents: activeFileContents,
        })
        .then((result) => {
          if (syncRequestIdRef.current !== requestId) {
            return;
          }

          const liveEditor = editorRef.current;
          const liveMonaco = monacoRef.current;
          const liveModel = liveEditor?.getModel();
          if (
            !liveEditor ||
            !liveMonaco ||
            !liveModel ||
            liveModel.uri.toString() !== model.uri.toString()
          ) {
            return;
          }

          clearModelMarkers(liveMonaco, liveModel);
          liveMonaco.editor.setModelMarkers(
            liveModel,
            WORKSPACE_EDITOR_MARKER_OWNER,
            toMonacoMarkers(liveMonaco, result.diagnostics),
          );
          setDiagnosticError(null);
          setDiagnosticSummary(formatDiagnosticSummary(result.diagnostics));
        })
        .catch((error) => {
          if (syncRequestIdRef.current !== requestId) {
            return;
          }
          clearEditorMarkers();
          const message =
            error instanceof Error ? error.message : "Failed to sync Neovim diagnostics.";
          setDiagnosticError(message);
          setDiagnosticSummary(null);
          console.error("Failed to sync workspace editor diagnostics", {
            cwd: props.gitCwd,
            relativePath: activeFilePath,
            error,
          });
        });
    }, DIAGNOSTIC_SYNC_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeFileContents,
    activeFileReady,
    api,
    clearEditorMarkers,
    editorMountVersion,
    pane.activeFilePath,
    props.gitCwd,
  ]);

  useEffect(
    () => () => {
      syncRequestIdRef.current += 1;
      clearEditorMarkers();
      disposeVimAdapter();
    },
    [clearEditorMarkers, disposeVimAdapter],
  );

  const readDraggedTab = useCallback((event: ReactDragEvent<HTMLElement>) => {
    return readEditorTabTransfer(event.dataTransfer);
  }, []);

  const handleTabDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetIndex?: number) => {
      const draggedTab = readDraggedTab(event);
      if (!draggedTab) {
        return;
      }
      event.preventDefault();
      setDropTargetIndex(null);
      onMoveFile({
        ...draggedTab,
        targetPaneId: pane.id,
        ...(targetIndex === undefined ? {} : { targetIndex }),
      });
    },
    [onMoveFile, pane.id, readDraggedTab],
  );

  const handleTabDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetIndex?: number) => {
      const draggedTab = readDraggedTab(event);
      if (!draggedTab) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTargetIndex(targetIndex ?? pane.openFilePaths.length);
    },
    [pane.openFilePaths.length, readDraggedTab],
  );

  const clearDropTarget = useCallback(() => {
    setDropTargetIndex(null);
  }, []);

  const openTabContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>, filePath: string) => {
      if (!api) {
        return;
      }

      const tabIndex = pane.openFilePaths.indexOf(filePath);
      if (tabIndex < 0) {
        return;
      }

      const items = [
        { id: "open-side", label: `Open ${basenameOfPath(filePath)} to the Side` },
        { id: "close", label: `Close ${basenameOfPath(filePath)}` },
        {
          id: "close-others",
          label: "Close Other Tabs",
          disabled: pane.openFilePaths.length <= 1,
        },
        {
          id: "close-right",
          label: "Close Tabs to the Right",
          disabled: tabIndex >= pane.openFilePaths.length - 1,
        },
        {
          id: "reopen-closed",
          label: "Reopen Closed Tab",
          disabled: !canReopenClosedTab,
        },
      ] as const;

      const clicked = await api.contextMenu.show(items, {
        x: event.clientX,
        y: event.clientY,
      });

      switch (clicked) {
        case "open-side":
          onOpenFileToSide(pane.id, filePath);
          return;
        case "close":
          onCloseFile(pane.id, filePath);
          return;
        case "close-others":
          onCloseOtherTabs(pane.id, filePath);
          return;
        case "close-right":
          onCloseTabsToRight(pane.id, filePath);
          return;
        case "reopen-closed":
          onReopenClosedTab(pane.id);
          return;
        default:
      }
    },
    [
      api,
      canReopenClosedTab,
      onCloseFile,
      onCloseOtherTabs,
      onCloseTabsToRight,
      onOpenFileToSide,
      onReopenClosedTab,
      pane.id,
      pane.openFilePaths,
    ],
  );

  return (
    <section
      data-pane-active={props.active ? "true" : "false"}
      className={cn(
        "group flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-colors relative",
        "bg-background",
      )}
      onPointerDown={() => {
        props.onFocusPane(props.pane.id);
      }}
    >
      <div
        className={cn(
          "flex h-[35px] shrink-0 items-center overflow-x-auto scrollbar-none border-b border-border/40",
          "bg-secondary/80",
        )}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          clearDropTarget();
        }}
        onDragOver={(event) => handleTabDragOver(event)}
        onDrop={(event) => handleTabDrop(event)}
      >
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none">
          {props.pane.openFilePaths.map((filePath) => {
            const isActive = filePath === props.pane.activeFilePath;
            const isDirty = props.dirtyFilePaths.has(filePath);
            return (
              <div key={filePath} className="relative flex shrink-0">
                {dropTargetIndex === props.pane.openFilePaths.indexOf(filePath) ? (
                  <div className="absolute top-1.5 bottom-1.5 left-0 z-20 w-[2px] rounded-full bg-primary" />
                ) : null}
                <button
                  type="button"
                  data-editor-tab="true"
                  className={cn(
                    "group/tab flex h-[35px] shrink-0 items-center gap-1.5 border-r border-border/30 px-3 text-[12px] transition-colors relative",
                    isActive
                      ? "bg-background text-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                  draggable
                  onClick={() => props.onSetActiveFile(props.pane.id, filePath)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    props.onSetActiveFile(props.pane.id, filePath);
                    void openTabContextMenu(event, filePath);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) {
                      return;
                    }
                    event.preventDefault();
                    props.onCloseFile(props.pane.id, filePath);
                  }}
                  onDragStart={(event) => {
                    props.onFocusPane(props.pane.id);
                    event.dataTransfer.effectAllowed = "move";
                    const payload = JSON.stringify({
                      filePath,
                      sourcePaneId: props.pane.id,
                    });
                    event.dataTransfer.setData(EDITOR_TAB_TRANSFER_TYPE, payload);
                    event.dataTransfer.setData("text/plain", payload);
                  }}
                  onDragEnd={clearDropTarget}
                  onDragOver={(event) =>
                    handleTabDragOver(event, props.pane.openFilePaths.indexOf(filePath))
                  }
                  onDrop={(event) =>
                    handleTabDrop(event, props.pane.openFilePaths.indexOf(filePath))
                  }
                  title={filePath}
                >
                  {isActive && (
                    <div className="absolute bottom-0 left-0 h-px w-full bg-background" />
                  )}
                  <VscodeEntryIcon
                    pathValue={filePath}
                    kind="file"
                    theme={props.resolvedTheme}
                    className="size-[14px] shrink-0"
                  />
                  <span className="max-w-[140px] truncate">{basenameOfPath(filePath)}</span>
                  {isDirty ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground/40 group-hover/tab:hidden" />
                  ) : null}
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100",
                      isDirty ? "hidden group-hover/tab:flex" : "",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onCloseFile(props.pane.id, filePath);
                    }}
                  >
                    <XIcon className="size-3" />
                  </span>
                </button>
              </div>
            );
          })}
          {dropTargetIndex === props.pane.openFilePaths.length ? (
            <div className="relative flex shrink-0 items-stretch px-0.5">
              <div className="my-1.5 w-[2px] rounded-full bg-primary" />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
            onClick={() => props.onSplitPane(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Right"
          >
            <Columns2Icon className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
            onClick={() => props.onSplitPaneDown(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Down"
          >
            <Rows2Icon className="size-3" />
          </Button>
          {props.canClosePane ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
              onClick={() => props.onClosePane(props.pane.id)}
              title="Close Editor Group"
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn("min-h-0 min-w-0 flex-1 relative border-t border-border/40", "bg-background")}
      >
        {!props.pane.activeFilePath ? (
          <div className="flex h-full items-center justify-center">
            <div className="opacity-[0.03] pointer-events-none text-foreground flex items-center justify-center">
              <FolderIcon className="size-24" strokeWidth={1} />
            </div>
          </div>
        ) : props.gitCwd === null && !activeDraft ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">This workspace is unavailable.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The current thread does not have an active project path.
              </p>
            </div>
          </div>
        ) : activeFileQuery.isPending && !activeDraft ? (
          <div className="space-y-4 px-6 py-6">
            <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Opening file
            </p>
            <div className="h-5 w-52 rounded bg-foreground/6" />
            <div className="h-4 w-full rounded bg-foreground/4" />
            <div className="h-4 w-[88%] rounded bg-foreground/4" />
            <div className="h-4 w-[76%] rounded bg-foreground/4" />
          </div>
        ) : activeFileQuery.isError && !activeDraft ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircleIcon className="size-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                This file could not be opened.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFileQuery.error instanceof Error
                  ? activeFileQuery.error.message
                  : "An unexpected error occurred."}
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={props.onRetryActiveFile}>
                  <RefreshCwIcon className="size-3.5" />
                  Retry
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 min-w-0">
            <Editor
              key={`${props.pane.id}:${props.pane.activeFilePath ?? "empty"}:${props.resolvedTheme}`}
              height="100%"
              path={props.pane.activeFilePath}
              value={activeFileContents}
              theme={props.resolvedTheme === "dark" ? "ace-carbon" : "ace-paper"}
              onMount={handleEditorMount}
              onChange={(value) => {
                if (!props.pane.activeFilePath || value === undefined) {
                  return;
                }
                props.onUpdateDraft(props.pane.activeFilePath, value);
              }}
              options={props.editorOptions}
            />
          </div>
        )}
      </div>

      <footer className="flex h-[22px] shrink-0 items-center justify-between gap-3 border-t border-border/30 bg-secondary/60 px-2.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
          {props.pane.activeFilePath ? (
            <>
              <span className="truncate">{props.pane.activeFilePath}</span>
              <span className="shrink-0 opacity-60">{formatFileSize(activeFileSizeBytes)}</span>
              {activeFileDirty ? (
                <span className="shrink-0 rounded-sm bg-primary/15 px-1 py-px text-[9px] font-semibold tracking-wider text-primary uppercase">
                  Modified
                </span>
              ) : null}
            </>
          ) : (
            <span className="opacity-60">Ready</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {props.neovimModeEnabled ? (
            <div
              ref={vimStatusNodeRef}
              aria-live="polite"
              className="min-w-0 max-w-[16rem] truncate text-[10px] text-muted-foreground/80 [&_input]:h-4 [&_input]:w-24 [&_input]:rounded-sm [&_input]:border [&_input]:border-border/60 [&_input]:bg-background/80 [&_input]:px-1 [&_input]:py-0 [&_input]:text-[10px] [&_input]:text-foreground"
            />
          ) : null}
          {diagnosticError ? (
            <span className="max-w-[18rem] truncate text-destructive/80" title={diagnosticError}>
              {diagnosticError}
            </span>
          ) : diagnosticSummary ? (
            <span className="opacity-70" title={diagnosticSummary}>
              {diagnosticSummary}
            </span>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              type="button"
              className="opacity-60 hover:opacity-100 transition-opacity hover:text-foreground"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
            >
              Revert
            </button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              type="button"
              className="font-medium opacity-80 hover:opacity-100 transition-opacity hover:text-foreground"
              onClick={handleSave}
              disabled={props.savingFilePath === props.pane.activeFilePath}
            >
              {props.savingFilePath === props.pane.activeFilePath ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
