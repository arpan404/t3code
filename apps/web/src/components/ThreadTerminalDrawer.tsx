import { FitAddon } from "@xterm/addon-fit";
import {
  Code2,
  Database,
  EllipsisVertical,
  Globe,
  Plus,
  Server,
  SquareSplitHorizontal,
  TerminalSquare,
  Trash2,
  Wrench,
  XIcon,
} from "lucide-react";
import { type ThreadId } from "@ace/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  Fragment,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  applyTerminalInputToBuffer,
  buildTerminalFallbackTitle,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
  normalizeTerminalPaneRatios,
  resizeTerminalPaneRatios,
} from "~/lib/terminalPresentation";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readNativeApi } from "~/nativeApi";
import { reportBackgroundError, runAsyncTask } from "~/lib/async";
import {
  TERMINAL_COLOR_OPTIONS,
  TERMINAL_ICON_OPTIONS,
  type TerminalColorName,
  type TerminalIconName,
} from "~/lib/terminalAppearance";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 140;
const MIN_TERMINAL_SIDEBAR_WIDTH = 180;
const MAX_TERMINAL_SIDEBAR_WIDTH = 360;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function clampTerminalSidebarWidth(width: number): number {
  const safeWidth = Number.isFinite(width) ? width : 236;
  return Math.min(
    MAX_TERMINAL_SIDEBAR_WIDTH,
    Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(safeWidth)),
  );
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

function readTerminalFontFamily(): string {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_FAMILY;
  const configuredFont = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return configuredFont.length > 0 ? configuredFont : DEFAULT_TERMINAL_FONT_FAMILY;
}

async function waitForTerminalFontReady(fontFamily: string, fontSize: number): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const fontSet = document.fonts;
  const fontCandidates = fontFamily
    .split(",")
    .map((font) => font.trim().replace(/^['"]|['"]$/g, ""))
    .filter((font) => font.length > 0 && font.toLowerCase() !== "monospace");
  const resolvedFont =
    fontCandidates.find((candidate) => fontSet.check(`${fontSize}px "${candidate}"`)) ??
    fontCandidates[0];
  if (!resolvedFont) return;
  const fontLoadPromise = fontSet.load(`${fontSize}px "${resolvedFont}"`).catch((error) => {
    reportBackgroundError("Failed to load the terminal font.", error);
  });
  await Promise.race([
    fontLoadPromise,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, TERMINAL_FONT_LOAD_TIMEOUT_MS);
    }),
  ]);
}

function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

type TerminalMenuAction =
  | "split"
  | "new"
  | "duplicate"
  | "rename"
  | "reset-title"
  | "clear"
  | "restart"
  | "close";

type TerminalSectionMenuAction = "clear-all" | "close-all";
type TerminalSidebarDensity = "compact" | "comfortable";
type TerminalSidebarDropTarget =
  | { kind: "group"; groupId: string; index: number }
  | { kind: "new-group"; groupIndex: number };
type TerminalContextMenuState =
  | { kind: "terminal"; terminalId: string; position: { x: number; y: number } }
  | { kind: "section"; position: { x: number; y: number } };

interface TerminalMenuItemDescriptor<T extends string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

interface TerminalOptionMenuItemDescriptor<T extends string> {
  id: T;
  label: string;
  current: boolean;
}

export function buildTerminalContextMenuItems(options: {
  label: string;
  canSplit: boolean;
  hasCustomTitle: boolean;
}): TerminalMenuItemDescriptor<TerminalMenuAction>[] {
  const { label, canSplit, hasCustomTitle } = options;
  return [
    { id: "split", label: "Split Terminal", disabled: !canSplit },
    { id: "new", label: "New Terminal" },
    { id: "duplicate", label: `Duplicate ${label}` },
    { id: "rename", label: `Rename ${label}` },
    ...(hasCustomTitle ? [{ id: "reset-title" as const, label: "Reset Title" }] : []),
    { id: "clear", label: `Clear ${label}` },
    { id: "restart", label: `Restart ${label}` },
    { id: "close", label: `Close ${label}`, destructive: true },
  ];
}

export function buildTerminalIconMenuItems(
  currentIcon: TerminalIconName | null,
): TerminalOptionMenuItemDescriptor<TerminalIconName>[] {
  const resolvedCurrentIcon = currentIcon ?? "terminal";
  return TERMINAL_ICON_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    current: option.id === resolvedCurrentIcon,
  }));
}

export function buildTerminalColorMenuItems(
  currentColor: TerminalColorName | null,
): TerminalOptionMenuItemDescriptor<TerminalColorName>[] {
  const resolvedCurrentColor = currentColor ?? "default";
  return TERMINAL_COLOR_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    current: option.id === resolvedCurrentColor,
  }));
}

export function buildTerminalSidebarDensityItems(
  density: TerminalSidebarDensity = "comfortable",
): TerminalOptionMenuItemDescriptor<TerminalSidebarDensity>[] {
  return [
    { id: "comfortable", label: "Comfortable", current: density === "comfortable" },
    { id: "compact", label: "Compact", current: density === "compact" },
  ];
}

export function buildTerminalSectionMenuItems(): TerminalMenuItemDescriptor<TerminalSectionMenuAction>[] {
  return [
    { id: "clear-all", label: "Clear All Terminals" },
    { id: "close-all", label: "Kill All Terminals", destructive: true },
  ];
}

function basenameOfCwd(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (normalizedPath.length === 0) return "workspace";
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || normalizedPath;
}

function buildTerminalRowSubtitle(options: {
  cwd: string;
  displayLabel: string;
  autoTitle: string | null;
  isRunning: boolean;
}): string {
  const location = basenameOfCwd(options.cwd);
  const status = options.isRunning ? "running" : "idle";
  if (options.autoTitle && options.autoTitle !== options.displayLabel) {
    return `${options.autoTitle} · ${location} · ${status}`;
  }
  return `${location} · ${status}`;
}

function terminalColorClasses(color: TerminalColorName | null): string {
  switch (color) {
    case "emerald":
      return "text-emerald-500";
    case "amber":
      return "text-amber-500";
    case "sky":
      return "text-sky-500";
    case "rose":
      return "text-rose-500";
    case "violet":
      return "text-violet-500";
    default:
      return "text-muted-foreground/90";
  }
}

function terminalColorSwatchClasses(color: TerminalColorName | null): string {
  switch (color) {
    case "emerald":
      return "bg-emerald-500";
    case "amber":
      return "bg-amber-500";
    case "sky":
      return "bg-sky-500";
    case "rose":
      return "bg-rose-500";
    case "violet":
      return "bg-violet-500";
    default:
      return "bg-muted-foreground/35";
  }
}

function menuPositionFromElement(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

function TerminalIconGlyph(props: {
  icon: TerminalIconName | null;
  color: TerminalColorName | null;
  className?: string;
}): ReactNode {
  const { icon, color, className } = props;
  const resolvedClassName = `${terminalColorClasses(color)} ${className ?? ""}`.trim();
  switch (icon) {
    case "code":
      return <Code2 className={resolvedClassName} />;
    case "server":
      return <Server className={resolvedClassName} />;
    case "database":
      return <Database className={resolvedClassName} />;
    case "globe":
      return <Globe className={resolvedClassName} />;
    case "wrench":
      return <Wrench className={resolvedClassName} />;
    default:
      return <TerminalSquare className={resolvedClassName} />;
  }
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onAutoTerminalTitleChange: (title: string | null) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  onAutoTerminalTitleChange,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onSessionExitedRef = useRef(onSessionExited);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const onAutoTerminalTitleChangeRef = useRef(onAutoTerminalTitleChange);
  const terminalLabelRef = useRef(terminalLabel);
  const hasHandledExitRef = useRef(false);
  const commandBufferRef = useRef("");
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onSessionExitedRef.current = onSessionExited;
  }, [onSessionExited]);

  useEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    onAutoTerminalTitleChangeRef.current = onAutoTerminalTitleChange;
  }, [onAutoTerminalTitleChange]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const fontFamily = readTerminalFontFamily();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.16,
      fontSize: 13,
      letterSpacing: 0.2,
      scrollback: 5_000,
      fontFamily,
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: terminalLabelRef.current,
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        onAddTerminalContextRef.current(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }

        const lineText = line.translateToString(true);
        const matches = extractTerminalLinks(lineText);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          matches.map((match) => ({
            text: match.text,
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.end, y: bufferLineNumber },
            },
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      const nextInputState = applyTerminalInputToBuffer(commandBufferRef.current, data);
      commandBufferRef.current = nextInputState.buffer;
      if (nextInputState.submittedCommand) {
        onAutoTerminalTitleChangeRef.current(
          deriveTerminalTitleFromCommand(nextInputState.submittedCommand),
        );
      }
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        await waitForTerminalFontReady(fontFamily, activeTerminal.options.fontSize ?? 13);
        if (disposed || !containerRef.current || containerRef.current.childElementCount > 0) {
          return;
        }
        activeTerminal.open(containerRef.current);
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        activeTerminal.write("\u001bc");
        onAutoTerminalTitleChangeRef.current(snapshot.title);
        if (snapshot.history.length > 0) {
          activeTerminal.write(snapshot.history);
        }
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const unsubscribe = api?.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        const oscTitle = extractTerminalOscTitle(event.data);
        if (oscTitle) {
          onAutoTerminalTitleChangeRef.current(oscTitle);
        }
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        commandBufferRef.current = "";
        clearSelectionAction();
        activeTerminal.write("\u001bc");
        onAutoTerminalTitleChangeRef.current(event.snapshot.title);
        if (event.snapshot.history.length > 0) {
          activeTerminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "title") {
        onAutoTerminalTitleChangeRef.current(event.title);
        return;
      }

      if (event.type === "cleared") {
        commandBufferRef.current = "";
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        commandBufferRef.current = "";
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (hasHandledExitRef.current) {
          return;
        }
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          onSessionExitedRef.current();
        }, 0);
      }
    });

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      runAsyncTask(
        api.terminal.resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        }),
        "Failed to resize the terminal after fitting the viewport.",
      );
    }, 30);
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      unsubscribe();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      runAsyncTask(
        api.terminal.resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        }),
        "Failed to resize the terminal after drawer layout changed.",
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-lg" />;
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  sidebarWidth: number;
  sidebarDensity: TerminalSidebarDensity;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  runningTerminalIds: string[];
  customTerminalTitlesById: Record<string, string>;
  autoTerminalTitlesById: Record<string, string>;
  terminalIconsById: Record<string, TerminalIconName>;
  terminalColorsById: Record<string, TerminalColorName>;
  splitRatiosByGroupId: Record<string, number[]>;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onMoveTerminalToNewGroup: (terminalId: string, targetGroupIndex: number) => void;
  onDuplicateTerminal: (terminalId: string) => void;
  onRenameTerminal: (terminalId: string, title: string) => void;
  onClearTerminal: (terminalId: string) => void;
  onClearAllTerminals: () => void;
  onRestartTerminal: (terminalId: string) => void;
  onCloseAllTerminals: () => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onTerminalIconChange: (terminalId: string, icon: TerminalIconName | null) => void;
  onTerminalColorChange: (terminalId: string, color: TerminalColorName | null) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onSidebarWidthChange: (width: number) => void;
  onSidebarDensityChange: (density: TerminalSidebarDensity) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  sidebarWidth,
  sidebarDensity,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  runningTerminalIds,
  customTerminalTitlesById,
  autoTerminalTitlesById,
  terminalIconsById,
  terminalColorsById,
  splitRatiosByGroupId,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onMoveTerminal,
  onMoveTerminalToNewGroup,
  onDuplicateTerminal,
  onRenameTerminal,
  onClearTerminal,
  onClearAllTerminals,
  onRestartTerminal,
  onCloseAllTerminals,
  onAutoTerminalTitleChange,
  onTerminalIconChange,
  onTerminalColorChange,
  onSplitRatiosChange,
  onCloseTerminal,
  onHeightChange,
  onSidebarWidthChange,
  onSidebarDensityChange,
  onAddTerminalContext,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(() =>
    clampTerminalSidebarWidth(sidebarWidth),
  );
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [draggedTerminalId, setDraggedTerminalId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TerminalSidebarDropTarget | null>(null);
  const [contextMenuState, setContextMenuState] = useState<TerminalContextMenuState | null>(null);
  const drawerHeightRef = useRef(drawerHeight);
  const sidebarWidthRef = useRef(sidebarPanelWidth);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const lastSyncedSidebarWidthRef = useRef(clampTerminalSidebarWidth(sidebarWidth));
  const onHeightChangeRef = useRef(onHeightChange);
  const onSidebarWidthChangeRef = useRef(onSidebarWidthChange);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitResizeStateRef = useRef<{
    pointerId: number;
    dividerIndex: number;
    startX: number;
    startRatios: number[];
  } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const sidebarResizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const didResizeSidebarDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const visibleTerminalGroupId =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.id ?? `group-${resolvedActiveTerminalId}`;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalOrderById = useMemo(
    () => new Map(normalizedTerminalIds.map((terminalId, index) => [terminalId, index + 1])),
    [normalizedTerminalIds],
  );
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          customTerminalTitlesById[terminalId] ??
            autoTerminalTitlesById[terminalId] ??
            buildTerminalFallbackTitle(cwd, terminalId),
        ]),
      ),
    [autoTerminalTitlesById, customTerminalTitlesById, cwd, normalizedTerminalIds],
  );
  const terminalIconById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          terminalIconsById[terminalId] ?? null,
        ]),
      ),
    [normalizedTerminalIds, terminalIconsById],
  );
  const terminalColorById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          terminalColorsById[terminalId] ?? null,
        ]),
      ),
    [normalizedTerminalIds, terminalColorsById],
  );
  const activeGroupSplitRatios = useMemo(
    () =>
      normalizeTerminalPaneRatios(
        splitRatiosByGroupId[visibleTerminalGroupId] ?? [],
        visibleTerminalIds.length,
      ),
    [splitRatiosByGroupId, visibleTerminalGroupId, visibleTerminalIds.length],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const isCompactDensity = sidebarDensity === "compact";
  const rowPaddingClass = isCompactDensity ? "px-2 py-1" : "px-2 py-1.5";
  const rowTextClass = isCompactDensity ? "text-[10px]" : "text-[11px]";
  const groupHeaderPaddingClass = isCompactDensity ? "px-2 py-1" : "px-2 py-1.5";
  const activeContextMenuTerminalId =
    contextMenuState?.kind === "terminal" ? contextMenuState.terminalId : null;
  const activeContextMenuLabel = activeContextMenuTerminalId
    ? (terminalLabelById.get(activeContextMenuTerminalId) ?? "terminal")
    : "terminal";
  const activeContextMenuHasCustomTitle = activeContextMenuTerminalId
    ? Boolean(customTerminalTitlesById[activeContextMenuTerminalId])
    : false;
  const activeContextMenuIcon = activeContextMenuTerminalId
    ? (terminalIconById.get(activeContextMenuTerminalId) ?? null)
    : null;
  const activeContextMenuColor = activeContextMenuTerminalId
    ? (terminalColorById.get(activeContextMenuTerminalId) ?? null)
    : null;
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  const cancelRename = useCallback(() => {
    setEditingTerminalId(null);
    setEditingTitle("");
  }, []);
  const beginRename = useCallback(
    (terminalId: string) => {
      setEditingTerminalId(terminalId);
      setEditingTitle(terminalLabelById.get(terminalId) ?? "");
    },
    [terminalLabelById],
  );
  const commitRename = useCallback(() => {
    if (!editingTerminalId) return;
    onRenameTerminal(editingTerminalId, editingTitle);
    cancelRename();
  }, [cancelRename, editingTerminalId, editingTitle, onRenameTerminal]);
  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);
  const clearDragState = useCallback(() => {
    setDraggedTerminalId(null);
    setDropTarget(null);
  }, []);
  const handleTerminalContextMenu = useCallback(
    (terminalId: string, position: { x: number; y: number }) => {
      setContextMenuState({ kind: "terminal", terminalId, position });
    },
    [],
  );
  const handleTerminalSectionMenu = useCallback((position: { x: number; y: number }) => {
    setContextMenuState({ kind: "section", position });
  }, []);
  const handleTerminalMenuAction = useCallback(
    (terminalId: string, action: TerminalMenuAction) => {
      closeContextMenu();
      if (action === "split") {
        onSplitTerminalAction();
        return;
      }
      if (action === "new") {
        onNewTerminalAction();
        return;
      }
      if (action === "duplicate") {
        onDuplicateTerminal(terminalId);
        return;
      }
      if (action === "rename") {
        beginRename(terminalId);
        return;
      }
      if (action === "reset-title") {
        onRenameTerminal(terminalId, "");
        return;
      }
      if (action === "clear") {
        onClearTerminal(terminalId);
        return;
      }
      if (action === "restart") {
        onRestartTerminal(terminalId);
        return;
      }
      if (action === "close") {
        onCloseTerminal(terminalId);
      }
    },
    [
      beginRename,
      closeContextMenu,
      onClearTerminal,
      onCloseTerminal,
      onDuplicateTerminal,
      onNewTerminalAction,
      onRenameTerminal,
      onRestartTerminal,
      onSplitTerminalAction,
    ],
  );
  const handleTerminalIconSelect = useCallback(
    (terminalId: string, icon: TerminalIconName) => {
      closeContextMenu();
      onTerminalIconChange(terminalId, icon);
    },
    [closeContextMenu, onTerminalIconChange],
  );
  const handleTerminalColorSelect = useCallback(
    (terminalId: string, color: TerminalColorName) => {
      closeContextMenu();
      onTerminalColorChange(terminalId, color);
    },
    [closeContextMenu, onTerminalColorChange],
  );
  const handleTerminalSectionAction = useCallback(
    (action: TerminalSectionMenuAction) => {
      closeContextMenu();
      if (action === "clear-all") {
        onClearAllTerminals();
        return;
      }
      if (action === "close-all") {
        onCloseAllTerminals();
      }
    },
    [closeContextMenu, onClearAllTerminals, onCloseAllTerminals],
  );
  const handleSidebarDensitySelect = useCallback(
    (density: TerminalSidebarDensity) => {
      closeContextMenu();
      onSidebarDensityChange(density);
    },
    [closeContextMenu, onSidebarDensityChange],
  );
  const handleTerminalDragStart = useCallback((terminalId: string) => {
    setDraggedTerminalId(terminalId);
    setDropTarget(null);
  }, []);
  const handleTerminalDrop = useCallback(
    (terminalId: string, targetGroupId: string, targetIndex: number) => {
      if (!terminalId) return;
      onMoveTerminal(terminalId, targetGroupId, targetIndex);
      clearDragState();
    },
    [clearDragState, onMoveTerminal],
  );
  const handleTerminalDropToNewGroup = useCallback(
    (terminalId: string, targetGroupIndex: number) => {
      if (!terminalId) return;
      onMoveTerminalToNewGroup(terminalId, targetGroupIndex);
      clearDragState();
    },
    [clearDragState, onMoveTerminalToNewGroup],
  );

  useEffect(() => {
    if (editingTerminalId && !normalizedTerminalIds.includes(editingTerminalId)) {
      cancelRename();
    }
  }, [cancelRename, editingTerminalId, normalizedTerminalIds]);

  useEffect(() => {
    if (
      contextMenuState?.kind === "terminal" &&
      !normalizedTerminalIds.includes(contextMenuState.terminalId)
    ) {
      closeContextMenu();
    }
  }, [closeContextMenu, contextMenuState, normalizedTerminalIds]);

  useEffect(() => {
    if (draggedTerminalId && !normalizedTerminalIds.includes(draggedTerminalId)) {
      clearDragState();
    }
  }, [clearDragState, draggedTerminalId, normalizedTerminalIds]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    onSidebarWidthChangeRef.current = onSidebarWidthChange;
  }, [onSidebarWidthChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarPanelWidth;
  }, [sidebarPanelWidth]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  const syncSidebarWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampTerminalSidebarWidth(nextWidth);
    if (lastSyncedSidebarWidthRef.current === clampedWidth) return;
    lastSyncedSidebarWidthRef.current = clampedWidth;
    onSidebarWidthChangeRef.current(clampedWidth);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  useEffect(() => {
    const clampedWidth = clampTerminalSidebarWidth(sidebarWidth);
    setSidebarPanelWidth(clampedWidth);
    sidebarWidthRef.current = clampedWidth;
    lastSyncedSidebarWidthRef.current = clampedWidth;
  }, [sidebarWidth, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  const handleSidebarResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeSidebarDuringDragRef.current = false;
    sidebarResizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
    };
  }, []);

  const handleSidebarResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = sidebarResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedWidth = clampTerminalSidebarWidth(
      resizeState.startWidth + (resizeState.startX - event.clientX),
    );
    if (clampedWidth === sidebarWidthRef.current) {
      return;
    }
    didResizeSidebarDuringDragRef.current = true;
    sidebarWidthRef.current = clampedWidth;
    setSidebarPanelWidth(clampedWidth);
  }, []);

  const handleSidebarResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = sidebarResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      sidebarResizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeSidebarDuringDragRef.current) {
        return;
      }
      syncSidebarWidth(sidebarWidthRef.current);
    },
    [syncSidebarWidth],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      const clampedSidebarWidth = clampTerminalSidebarWidth(sidebarWidthRef.current);
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (clampedSidebarWidth !== sidebarWidthRef.current) {
        setSidebarPanelWidth(clampedSidebarWidth);
        sidebarWidthRef.current = clampedSidebarWidth;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      if (!sidebarResizeStateRef.current) {
        syncSidebarWidth(clampedSidebarWidth);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, syncSidebarWidth]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
      syncSidebarWidth(sidebarWidthRef.current);
    };
  }, [syncHeight, syncSidebarWidth]);

  const handleSplitResizePointerDown = useCallback(
    (dividerIndex: number, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = splitContainerRef.current;
      if (!container || visibleTerminalIds.length <= 1) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      splitResizeStateRef.current = {
        pointerId: event.pointerId,
        dividerIndex,
        startX: event.clientX,
        startRatios: activeGroupSplitRatios,
      };
    },
    [activeGroupSplitRatios, visibleTerminalIds.length],
  );

  const handleSplitResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = splitResizeStateRef.current;
      const container = splitContainerRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) return;
      event.preventDefault();
      const nextRatios = resizeTerminalPaneRatios({
        ratios: resizeState.startRatios,
        dividerIndex: resizeState.dividerIndex,
        deltaPx: event.clientX - resizeState.startX,
        containerWidthPx: container.clientWidth,
      });
      onSplitRatiosChange(visibleTerminalGroupId, nextRatios);
    },
    [onSplitRatiosChange, visibleTerminalGroupId],
  );

  const handleSplitResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = splitResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    splitResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <aside
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />

      {contextMenuState ? (
        <Menu
          key={
            contextMenuState.kind === "terminal"
              ? `terminal:${contextMenuState.terminalId}:${contextMenuState.position.x}:${contextMenuState.position.y}`
              : `section:${contextMenuState.position.x}:${contextMenuState.position.y}`
          }
          defaultOpen
          modal={false}
          onOpenChange={(open) => {
            if (!open) {
              closeContextMenu();
            }
          }}
        >
          <MenuTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none fixed z-50 size-px opacity-0"
                style={{
                  left: `${contextMenuState.position.x}px`,
                  top: `${contextMenuState.position.y}px`,
                }}
              />
            }
          />
          <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-52">
            {contextMenuState.kind === "terminal" ? (
              <>
                {buildTerminalContextMenuItems({
                  label: activeContextMenuLabel,
                  canSplit: !hasReachedSplitLimit,
                  hasCustomTitle: activeContextMenuHasCustomTitle,
                }).map((item) => (
                  <MenuItem
                    key={item.id}
                    disabled={item.disabled}
                    variant={item.destructive ? "destructive" : "default"}
                    onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, item.id)}
                  >
                    {item.label}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger>
                    {TerminalIconGlyph({
                      icon: activeContextMenuIcon,
                      color: activeContextMenuColor,
                      className: "size-3.5 shrink-0",
                    })}
                    <span>Icon</span>
                    <span className="ms-auto truncate text-[11px] text-muted-foreground/80">
                      {buildTerminalIconMenuItems(activeContextMenuIcon).find(
                        (item) => item.current,
                      )?.label ?? "Terminal"}
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup className="min-w-44" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={
                          buildTerminalIconMenuItems(activeContextMenuIcon).find(
                            (item) => item.current,
                          )?.id ?? "terminal"
                        }
                        onValueChange={(value) =>
                          handleTerminalIconSelect(
                            contextMenuState.terminalId,
                            value as TerminalIconName,
                          )
                        }
                      >
                        {buildTerminalIconMenuItems(activeContextMenuIcon).map((item) => (
                          <MenuRadioItem key={item.id} value={item.id}>
                            {TerminalIconGlyph({
                              icon: item.id,
                              color: activeContextMenuColor,
                              className: "size-3.5 shrink-0",
                            })}
                            {item.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSub>
                  <MenuSubTrigger>
                    <span
                      className={`size-2.5 shrink-0 rounded-full ${terminalColorSwatchClasses(
                        activeContextMenuColor,
                      )}`}
                    />
                    <span>Color</span>
                    <span className="ms-auto truncate text-[11px] text-muted-foreground/80">
                      {buildTerminalColorMenuItems(activeContextMenuColor).find(
                        (item) => item.current,
                      )?.label ?? "Default"}
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup className="min-w-40" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={
                          buildTerminalColorMenuItems(activeContextMenuColor).find(
                            (item) => item.current,
                          )?.id ?? "default"
                        }
                        onValueChange={(value) =>
                          handleTerminalColorSelect(
                            contextMenuState.terminalId,
                            value as TerminalColorName,
                          )
                        }
                      >
                        {buildTerminalColorMenuItems(activeContextMenuColor).map((item) => (
                          <MenuRadioItem key={item.id} value={item.id}>
                            <span
                              className={`size-2.5 shrink-0 rounded-full ${terminalColorSwatchClasses(
                                item.id,
                              )}`}
                            />
                            {item.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              </>
            ) : (
              <>
                <MenuSub>
                  <MenuSubTrigger>Density</MenuSubTrigger>
                  <MenuSubPopup className="min-w-36" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={sidebarDensity}
                        onValueChange={(value) =>
                          handleSidebarDensitySelect(value as TerminalSidebarDensity)
                        }
                      >
                        {buildTerminalSidebarDensityItems(sidebarDensity).map((item) => (
                          <MenuRadioItem key={item.id} value={item.id}>
                            {item.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSeparator />
                {buildTerminalSectionMenuItems().map((item) => (
                  <MenuItem
                    key={item.id}
                    variant={item.destructive ? "destructive" : "default"}
                    onClick={() => handleTerminalSectionAction(item.id)}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </>
            )}
          </MenuPopup>
        </Menu>
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/80 shadow-sm backdrop-blur-sm">
            <button
              type="button"
              className="inline-flex max-w-44 items-center gap-1 truncate px-2 py-1 text-[11px] text-foreground/85 transition-colors hover:bg-accent/70"
              onContextMenu={(event) => {
                event.preventDefault();
                void handleTerminalContextMenu(resolvedActiveTerminalId, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              aria-label={`Rename ${terminalLabelById.get(resolvedActiveTerminalId) ?? "terminal"}`}
            >
              {TerminalIconGlyph({
                icon: terminalIconById.get(resolvedActiveTerminalId) ?? null,
                color: terminalColorById.get(resolvedActiveTerminalId) ?? null,
                className: "size-3 shrink-0",
              })}
              {terminalLabelById.get(resolvedActiveTerminalId) ?? "terminal"}
            </button>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={(event) => {
                handleTerminalSectionMenu(menuPositionFromElement(event.currentTarget));
              }}
              label="Terminal Actions"
            >
              <EllipsisVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div ref={splitContainerRef} className="flex h-full w-full min-w-0 overflow-hidden">
                {visibleTerminalIds.map((terminalId, index) => (
                  <Fragment key={terminalId}>
                    <div
                      className={`min-h-0 min-w-0 ${
                        terminalId === resolvedActiveTerminalId ? "" : "opacity-90"
                      }`}
                      style={{ flexBasis: 0, flexGrow: activeGroupSplitRatios[index] ?? 1 }}
                      onMouseDown={() => {
                        if (terminalId !== resolvedActiveTerminalId) {
                          onActiveTerminalChange(terminalId);
                        }
                      }}
                    >
                      <div className="h-full p-1">
                        <TerminalViewport
                          threadId={threadId}
                          terminalId={terminalId}
                          terminalLabel={terminalLabelById.get(terminalId) ?? "terminal"}
                          cwd={cwd}
                          {...(runtimeEnv ? { runtimeEnv } : {})}
                          onSessionExited={() => onCloseTerminal(terminalId)}
                          onAddTerminalContext={onAddTerminalContext}
                          onAutoTerminalTitleChange={(title) =>
                            onAutoTerminalTitleChange(terminalId, title)
                          }
                          focusRequestId={focusRequestId}
                          autoFocus={terminalId === resolvedActiveTerminalId}
                          resizeEpoch={resizeEpoch}
                          drawerHeight={drawerHeight}
                        />
                      </div>
                    </div>
                    {index < visibleTerminalIds.length - 1 ? (
                      <div
                        className="group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center"
                        onPointerDown={(event) => handleSplitResizePointerDown(index, event)}
                        onPointerMove={handleSplitResizePointerMove}
                        onPointerUp={handleSplitResizePointerEnd}
                        onPointerCancel={handleSplitResizePointerEnd}
                      >
                        <div className="my-3 w-px rounded-full bg-border/70 transition-colors group-hover:bg-primary/60" />
                      </div>
                    ) : null}
                  </Fragment>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  onAutoTerminalTitleChange={(title) =>
                    onAutoTerminalTitleChange(resolvedActiveTerminalId, title)
                  }
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <>
              <div
                className="group relative flex w-3 shrink-0 cursor-col-resize items-stretch justify-center"
                onPointerDown={handleSidebarResizePointerDown}
                onPointerMove={handleSidebarResizePointerMove}
                onPointerUp={handleSidebarResizePointerEnd}
                onPointerCancel={handleSidebarResizePointerEnd}
                aria-hidden="true"
              >
                <div className="my-3 w-px rounded-full bg-border/60 transition-colors group-hover:bg-primary/60" />
              </div>

              <aside
                className="flex shrink-0 flex-col overflow-hidden border-l border-border/70 bg-muted/15"
                style={{ width: `${sidebarPanelWidth}px`, minWidth: `${sidebarPanelWidth}px` }}
              >
                <div
                  className="flex items-center justify-between gap-2 border-b border-border/60 bg-background/70 px-2.5 py-2"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    handleTerminalSectionMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
                      terminals
                    </div>
                    <div className="truncate text-[11px] text-foreground/85">
                      {normalizedTerminalIds.length} open
                    </div>
                  </div>
                  <div className="inline-flex items-center overflow-hidden rounded-md border border-border/70 bg-background/70">
                    <TerminalActionButton
                      className={`inline-flex h-7 items-center px-1.5 text-foreground/90 transition-colors ${
                        hasReachedSplitLimit
                          ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                          : "hover:bg-accent/70"
                      }`}
                      onClick={onSplitTerminalAction}
                      label={splitTerminalActionLabel}
                    >
                      <SquareSplitHorizontal className="size-3.25" />
                    </TerminalActionButton>
                    <TerminalActionButton
                      className="inline-flex h-7 items-center border-l border-border/70 px-1.5 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={onNewTerminalAction}
                      label={newTerminalActionLabel}
                    >
                      <Plus className="size-3.25" />
                    </TerminalActionButton>
                    <TerminalActionButton
                      className="inline-flex h-7 items-center border-l border-border/70 px-1.5 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={(event) => {
                        handleTerminalSectionMenu(menuPositionFromElement(event.currentTarget));
                      }}
                      label="Terminal Actions"
                    >
                      <EllipsisVertical className="size-3.25" />
                    </TerminalActionButton>
                    <TerminalActionButton
                      className="inline-flex h-7 items-center border-l border-border/70 px-1.5 text-foreground/90 transition-colors hover:bg-accent/70"
                      onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                      label={closeTerminalActionLabel}
                    >
                      <Trash2 className="size-3.25" />
                    </TerminalActionButton>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
                  {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                    const isGroupActive =
                      terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                    const groupActiveTerminalId = isGroupActive
                      ? resolvedActiveTerminalId
                      : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);
                    const groupTitle =
                      terminalGroup.terminalIds.length > 1
                        ? `${terminalGroup.terminalIds.length} pane split`
                        : groupIndex === 0
                          ? "workspace shell"
                          : "shell";

                    return (
                      <div key={terminalGroup.id} className="pb-1.5">
                        {showGroupHeaders && (
                          <button
                            type="button"
                            className={`mb-1 flex w-full items-center justify-between ${groupHeaderPaddingClass} text-left text-[10px] font-medium uppercase tracking-[0.12em] ${
                              isGroupActive
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                            onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                            onDragOver={(event) => {
                              if (!draggedTerminalId) return;
                              event.preventDefault();
                              setDropTarget({
                                kind: "group",
                                groupId: terminalGroup.id,
                                index: terminalGroup.terminalIds.length,
                              });
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const droppedTerminalId =
                                event.dataTransfer.getData("text/plain") || draggedTerminalId;
                              if (!droppedTerminalId) return;
                              handleTerminalDrop(
                                droppedTerminalId,
                                terminalGroup.id,
                                terminalGroup.terminalIds.length,
                              );
                            }}
                          >
                            <span>{groupTitle}</span>
                            <span className="rounded-full bg-background/80 px-1.5 py-0.5 text-[9px] tracking-normal text-muted-foreground/90">
                              {terminalGroup.terminalIds.length}
                            </span>
                          </button>
                        )}

                        <div
                          className={
                            showGroupHeaders
                              ? "space-y-0.5 border-l border-border/40 pl-2"
                              : "space-y-0.5"
                          }
                          onDragOver={(event) => {
                            if (!draggedTerminalId) return;
                            event.preventDefault();
                            setDropTarget({
                              kind: "group",
                              groupId: terminalGroup.id,
                              index: terminalGroup.terminalIds.length,
                            });
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const droppedTerminalId =
                              event.dataTransfer.getData("text/plain") || draggedTerminalId;
                            if (!droppedTerminalId) return;
                            handleTerminalDrop(
                              droppedTerminalId,
                              terminalGroup.id,
                              terminalGroup.terminalIds.length,
                            );
                          }}
                        >
                          {terminalGroup.terminalIds.map((terminalId) => {
                            const isActive = terminalId === resolvedActiveTerminalId;
                            const isEditing = editingTerminalId === terminalId;
                            const displayLabel = terminalLabelById.get(terminalId) ?? "shell";
                            const ordinal = terminalOrderById.get(terminalId) ?? groupIndex + 1;
                            const isRunning = runningTerminalIds.includes(terminalId);
                            const autoTitle = autoTerminalTitlesById[terminalId] ?? null;
                            const terminalIcon = terminalIconById.get(terminalId) ?? null;
                            const terminalColor = terminalColorById.get(terminalId) ?? null;
                            const subtitle = buildTerminalRowSubtitle({
                              cwd,
                              displayLabel,
                              autoTitle,
                              isRunning,
                            });
                            const closeTerminalLabel = `Close ${
                              displayLabel
                            }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                            return (
                              <div
                                key={terminalId}
                                className={`group flex items-center gap-2 border-l-2 ${rowPaddingClass} ${rowTextClass} transition-colors ${
                                  isActive
                                    ? "border-primary/60 bg-accent/50 text-foreground"
                                    : "border-transparent text-muted-foreground hover:bg-accent/35 hover:text-foreground"
                                }`}
                                draggable={!isEditing}
                                onDragStart={(event) => {
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", terminalId);
                                  handleTerminalDragStart(terminalId);
                                }}
                                onDragEnd={clearDragState}
                                onDragOver={(event) => {
                                  if (!draggedTerminalId) return;
                                  event.preventDefault();
                                  setDropTarget({
                                    kind: "group",
                                    groupId: terminalGroup.id,
                                    index: terminalGroup.terminalIds.indexOf(terminalId),
                                  });
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const droppedTerminalId =
                                    event.dataTransfer.getData("text/plain") || draggedTerminalId;
                                  if (!droppedTerminalId) return;
                                  handleTerminalDrop(
                                    droppedTerminalId,
                                    terminalGroup.id,
                                    terminalGroup.terminalIds.indexOf(terminalId),
                                  );
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  void handleTerminalContextMenu(terminalId, {
                                    x: event.clientX,
                                    y: event.clientY,
                                  });
                                }}
                                data-drop-active={
                                  dropTarget?.kind === "group" &&
                                  dropTarget.groupId === terminalGroup.id &&
                                  dropTarget.index === terminalGroup.terminalIds.indexOf(terminalId)
                                }
                              >
                                {showGroupHeaders && (
                                  <span className="text-[10px] text-muted-foreground/45">└</span>
                                )}
                                <span className="inline-flex min-w-4 shrink-0 items-center justify-center text-[9px] leading-none text-muted-foreground/70">
                                  {ordinal}
                                </span>
                                <span
                                  className={`size-1.5 shrink-0 rounded-full ${
                                    isRunning ? "bg-emerald-400" : "bg-border"
                                  }`}
                                />
                                {isEditing ? (
                                  <div className="flex min-w-0 flex-1 items-center gap-1">
                                    <Input
                                      size="sm"
                                      nativeInput
                                      value={editingTitle}
                                      autoFocus
                                      onChange={(event) =>
                                        setEditingTitle(event.currentTarget.value)
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          commitRename();
                                        }
                                        if (event.key === "Escape") {
                                          event.preventDefault();
                                          cancelRename();
                                        }
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className="rounded px-1 text-[10px] uppercase tracking-[0.08em] hover:bg-accent/70"
                                      onClick={commitRename}
                                    >
                                      save
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded px-1 text-[10px] uppercase tracking-[0.08em] hover:bg-accent/70"
                                      onClick={cancelRename}
                                    >
                                      cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                                      draggedTerminalId === terminalId ? "opacity-60" : ""
                                    } ${
                                      dropTarget?.kind === "group" &&
                                      dropTarget.groupId === terminalGroup.id &&
                                      dropTarget.index ===
                                        terminalGroup.terminalIds.indexOf(terminalId)
                                        ? "rounded-sm bg-primary/10"
                                        : ""
                                    }`}
                                    onClick={() => onActiveTerminalChange(terminalId)}
                                  >
                                    {TerminalIconGlyph({
                                      icon: terminalIcon,
                                      color: terminalColor,
                                      className: "size-3 shrink-0",
                                    })}
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">{displayLabel}</span>
                                      <span className="block truncate text-[9px] text-muted-foreground/80">
                                        {subtitle}
                                      </span>
                                    </span>
                                    {isRunning ? (
                                      <span className="px-1 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-emerald-600 dark:text-emerald-300">
                                        live
                                      </span>
                                    ) : null}
                                  </button>
                                )}
                                {normalizedTerminalIds.length > 1 && (
                                  <Popover>
                                    <PopoverTrigger
                                      openOnHover
                                      render={
                                        <button
                                          type="button"
                                          className="inline-flex size-3.5 items-center justify-center rounded-sm text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                          onClick={() => onCloseTerminal(terminalId)}
                                          aria-label={closeTerminalLabel}
                                        />
                                      }
                                    >
                                      <XIcon className="size-2.5" />
                                    </PopoverTrigger>
                                    <PopoverPopup
                                      tooltipStyle
                                      side="bottom"
                                      sideOffset={6}
                                      align="center"
                                      className="pointer-events-none select-none"
                                    >
                                      {closeTerminalLabel}
                                    </PopoverPopup>
                                  </Popover>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {draggedTerminalId ? (
                          <button
                            type="button"
                            className={`mt-1 flex w-full items-center justify-center border border-dashed px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors ${
                              dropTarget?.kind === "new-group" &&
                              dropTarget.groupIndex === groupIndex + 1
                                ? "border-primary/40 bg-primary/10 text-foreground"
                                : "border-border/60 text-muted-foreground hover:border-primary/25 hover:text-foreground"
                            }`}
                            onDragOver={(event) => {
                              if (!draggedTerminalId) return;
                              event.preventDefault();
                              setDropTarget({ kind: "new-group", groupIndex: groupIndex + 1 });
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const droppedTerminalId =
                                event.dataTransfer.getData("text/plain") || draggedTerminalId;
                              if (!droppedTerminalId) return;
                              handleTerminalDropToNewGroup(droppedTerminalId, groupIndex + 1);
                            }}
                          >
                            Drop To New Group
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </aside>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
