import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  Columns2Icon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  PictureInPicture2Icon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { normalizeBrowserInput } from "./browserUrl";
import {
  BROWSER_SESSION_STORAGE_KEY,
  BrowserSessionStorageSchema,
  type BrowserTabState,
  addBrowserTab,
  closeBrowserTab,
  createBrowserSessionState,
  normalizeBrowserSessionState,
  resolveBrowserTabTitle,
  resolveLegacyBrowserUrl,
  setActiveBrowserTab,
  updateBrowserTab,
} from "./browserSession";

const IN_APP_BROWSER_PARTITION = "persist:t3-browser";
const PIP_MARGIN_PX = 16;
const MIN_PIP_WIDTH_PX = 320;
const MIN_PIP_HEIGHT_PX = 216;
const DEFAULT_PIP_WIDTH_PX = 440;
const DEFAULT_PIP_HEIGHT_PX = 280;

type BrowserWebview = HTMLElement & {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  closeDevTools: () => void;
  getTitle: () => string;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpened: () => boolean;
  isLoading: () => boolean;
  loadURL: (url: string) => void;
  openDevTools: (options?: { mode?: "detach" | "left" | "right" | "bottom" | "undocked" }) => void;
  reload: () => void;
  stop: () => void;
};

type BrowserTabRuntimeState = {
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen: boolean;
  loading: boolean;
};

type BrowserTabSnapshot = BrowserTabRuntimeState & {
  title: string;
  url: string;
};

type BrowserTabHandle = {
  closeDevTools: () => void;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpen: () => boolean;
  navigate: (url: string) => void;
  openDevTools: () => void;
  reload: () => void;
  stop: () => void;
};

const DEFAULT_BROWSER_TAB_RUNTIME_STATE: BrowserTabRuntimeState = {
  canGoBack: false,
  canGoForward: false,
  devToolsOpen: false,
  loading: false,
};

export interface InAppBrowserController {
  closeDevTools: () => void;
  goBack: () => void;
  goForward: () => void;
  openDevTools: () => void;
  openUrl: (rawUrl: string, options?: { newTab?: boolean }) => void;
  reload: () => void;
  toggleDevTools: () => void;
}

type ActiveBrowserRuntimeState = {
  devToolsOpen: boolean;
  loading: boolean;
};

export type InAppBrowserMode = "full" | "pip" | "split";

interface InAppBrowserProps {
  open: boolean;
  mode: InAppBrowserMode;
  onClose: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onSplit: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  backShortcutLabel?: string | null;
  devToolsShortcutLabel?: string | null;
  forwardShortcutLabel?: string | null;
  reloadShortcutLabel?: string | null;
  viewportRef?: RefObject<HTMLDivElement | null>;
}

function resolveViewportHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 900;
}

type BrowserPipBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserViewportRect = {
  width: number;
  height: number;
};

function resolveViewportRect(viewportRef?: RefObject<HTMLDivElement | null>): BrowserViewportRect {
  const viewport = viewportRef?.current;
  if (viewport) {
    return {
      width: Math.max(0, Math.round(viewport.clientWidth)),
      height: Math.max(0, Math.round(viewport.clientHeight)),
    };
  }
  return {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 900,
  };
}

function createDefaultPipBounds(viewportRect: BrowserViewportRect): BrowserPipBounds {
  const width = Math.min(
    DEFAULT_PIP_WIDTH_PX,
    Math.max(MIN_PIP_WIDTH_PX, viewportRect.width - PIP_MARGIN_PX * 2),
  );
  const height = Math.min(
    DEFAULT_PIP_HEIGHT_PX,
    Math.max(MIN_PIP_HEIGHT_PX, viewportRect.height - PIP_MARGIN_PX * 2),
  );
  return {
    width,
    height,
    x: Math.max(PIP_MARGIN_PX, viewportRect.width - width - PIP_MARGIN_PX),
    y: Math.max(PIP_MARGIN_PX, viewportRect.height - height - PIP_MARGIN_PX),
  };
}

function clampPipBounds(
  bounds: BrowserPipBounds,
  viewportRect: BrowserViewportRect,
): BrowserPipBounds {
  const maxWidth = Math.max(MIN_PIP_WIDTH_PX, viewportRect.width - PIP_MARGIN_PX * 2);
  const maxHeight = Math.max(MIN_PIP_HEIGHT_PX, viewportRect.height - PIP_MARGIN_PX * 2);
  const width = Math.min(Math.max(Math.round(bounds.width), MIN_PIP_WIDTH_PX), maxWidth);
  const height = Math.min(Math.max(Math.round(bounds.height), MIN_PIP_HEIGHT_PX), maxHeight);
  return {
    width,
    height,
    x: Math.min(
      Math.max(Math.round(bounds.x), PIP_MARGIN_PX),
      Math.max(PIP_MARGIN_PX, viewportRect.width - width - PIP_MARGIN_PX),
    ),
    y: Math.min(
      Math.max(Math.round(bounds.y), PIP_MARGIN_PX),
      Math.max(PIP_MARGIN_PX, viewportRect.height - height - PIP_MARGIN_PX),
    ),
  };
}

function resolveBrowserFaviconSources(url: string): string[] {
  try {
    const parsed = new URL(url);
    const domainUrl = encodeURIComponent(parsed.origin);
    return [
      `https://www.google.com/s2/favicons?domain_url=${domainUrl}&sz=64`,
      new URL("/favicon.ico", parsed.origin).toString(),
    ];
  } catch {
    return [];
  }
}

function BrowserFavicon(props: {
  url: string;
  title: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const { className, fallbackClassName, title, url } = props;
  const sources = useMemo(() => resolveBrowserFaviconSources(url), [url]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sources]);

  const source = sources[sourceIndex];
  if (!source) {
    return (
      <GlobeIcon className={cn("shrink-0", fallbackClassName, className)} aria-hidden="true" />
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 rounded-sm object-cover", className)}
      src={source}
      title={title}
      onError={() => {
        setSourceIndex((current) => {
          const nextIndex = current + 1;
          return nextIndex < sources.length ? nextIndex : current;
        });
      }}
    />
  );
}

function BrowserTabWebview(props: {
  active: boolean;
  tab: BrowserTabState;
  onHandleChange: (tabId: string, handle: BrowserTabHandle | null) => void;
  onSnapshotChange: (tabId: string, snapshot: BrowserTabSnapshot) => void;
}) {
  const { active, tab, onHandleChange, onSnapshotChange } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebview | null>(null);
  const readyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const requestedUrlRef = useRef(tab.url);

  const emitSnapshot = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return;
    }
    const currentUrl = webview.getURL();
    const resolvedUrl = currentUrl.trim().length > 0 ? currentUrl : requestedUrlRef.current;
    onSnapshotChange(tab.id, {
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      devToolsOpen: webview.isDevToolsOpened(),
      loading: webview.isLoading(),
      title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
      url: resolvedUrl,
    });
  }, [onSnapshotChange, tab.id]);

  const navigate = useCallback(
    (url: string) => {
      requestedUrlRef.current = url;
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      const currentUrl = webview.getURL();
      if (currentUrl === url) {
        emitSnapshot();
        return;
      }
      webview.loadURL(url);
    },
    [emitSnapshot],
  );

  useEffect(() => {
    const handle: BrowserTabHandle = {
      closeDevTools: () => {
        if (!readyRef.current || !webviewRef.current?.isDevToolsOpened()) return;
        webviewRef.current.closeDevTools();
      },
      goBack: () => {
        if (!readyRef.current || !webviewRef.current?.canGoBack()) return;
        webviewRef.current.goBack();
      },
      goForward: () => {
        if (!readyRef.current || !webviewRef.current?.canGoForward()) return;
        webviewRef.current.goForward();
      },
      isDevToolsOpen: () => {
        if (!readyRef.current || !webviewRef.current) return false;
        return webviewRef.current.isDevToolsOpened();
      },
      navigate,
      openDevTools: () => {
        if (!readyRef.current || !webviewRef.current || webviewRef.current.isDevToolsOpened()) {
          return;
        }
        webviewRef.current.openDevTools({ mode: "detach" });
      },
      reload: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.reload();
      },
      stop: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.stop();
      },
    };
    onHandleChange(tab.id, handle);
    return () => {
      onHandleChange(tab.id, null);
    };
  }, [navigate, onHandleChange, tab.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webviewRef.current) return;

    const webview = document.createElement("webview") as BrowserWebview;
    webview.className = "size-full bg-background";
    webview.setAttribute("partition", IN_APP_BROWSER_PARTITION);
    webview.setAttribute("src", requestedUrlRef.current);

    const handleDomReady = () => {
      readyRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (pendingUrl && pendingUrl !== webview.getURL()) {
        webview.loadURL(pendingUrl);
        return;
      }
      emitSnapshot();
    };
    const handleLoadStart = () => {
      onSnapshotChange(tab.id, {
        canGoBack: readyRef.current ? webview.canGoBack() : false,
        canGoForward: readyRef.current ? webview.canGoForward() : false,
        devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
        loading: true,
        title: resolveBrowserTabTitle(requestedUrlRef.current),
        url: requestedUrlRef.current,
      });
    };
    const handleNavigation = () => {
      emitSnapshot();
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      if (detail.errorCode === -3) {
        return;
      }
      emitSnapshot();
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleNavigation);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("devtools-closed", handleNavigation);
    webview.addEventListener("devtools-opened", handleNavigation);
    webview.addEventListener("page-title-updated", handleNavigation);
    webview.addEventListener("did-fail-load", handleFailLoad);

    host.replaceChildren(webview);
    webviewRef.current = webview;

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleNavigation);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("devtools-closed", handleNavigation);
      webview.removeEventListener("devtools-opened", handleNavigation);
      webview.removeEventListener("page-title-updated", handleNavigation);
      webview.removeEventListener("did-fail-load", handleFailLoad);
      host.replaceChildren();
      webviewRef.current = null;
      readyRef.current = false;
    };
  }, [emitSnapshot, onSnapshotChange, tab.id]);

  useEffect(() => {
    navigate(tab.url);
  }, [navigate, tab.url]);

  return (
    <div
      className={cn("absolute inset-0 min-h-0 [&_webview]:size-full", active ? "block" : "hidden")}
    >
      <div ref={hostRef} className="size-full min-h-0" />
    </div>
  );
}

export function InAppBrowser(props: InAppBrowserProps) {
  const {
    open,
    mode,
    onClose,
    onMinimize,
    onRestore,
    onSplit,
    onControllerChange,
    onActiveRuntimeStateChange,
    backShortcutLabel,
    devToolsShortcutLabel,
    forwardShortcutLabel,
    reloadShortcutLabel,
    viewportRef,
  } = props;
  const api = readNativeApi();
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const webviewHandlesRef = useRef(new Map<string, BrowserTabHandle>());
  const pipBoundsRef = useRef<BrowserPipBounds>(
    createDefaultPipBounds(resolveViewportRect(viewportRef)),
  );
  const pipDragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startBounds: BrowserPipBounds;
  } | null>(null);
  const pipResizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startBounds: BrowserPipBounds;
  } | null>(null);
  const legacyUrl = useMemo(() => resolveLegacyBrowserUrl(), []);
  const [browserSession, setBrowserSession] = useLocalStorage(
    BROWSER_SESSION_STORAGE_KEY,
    createBrowserSessionState(legacyUrl),
    BrowserSessionStorageSchema,
  );
  const [draftUrl, setDraftUrl] = useState(legacyUrl);
  const [tabRuntimeById, setTabRuntimeById] = useState<Record<string, BrowserTabRuntimeState>>({});
  const [pipBounds, setPipBounds] = useState<BrowserPipBounds>(() =>
    createDefaultPipBounds(resolveViewportRect(viewportRef)),
  );

  const updateBrowserSession = useCallback(
    (updater: (state: typeof browserSession) => typeof browserSession) => {
      setBrowserSession((current) =>
        normalizeBrowserSessionState(updater(current), legacyUrl, resolveViewportHeight()),
      );
    },
    [legacyUrl, setBrowserSession],
  );

  const activeTab =
    browserSession.tabs.find((tab) => tab.id === browserSession.activeTabId) ??
    browserSession.tabs[0];
  const activeRuntime = activeTab
    ? (tabRuntimeById[activeTab.id] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE)
    : DEFAULT_BROWSER_TAB_RUNTIME_STATE;

  const openUrl = useCallback(
    (rawUrl: string, options?: { newTab?: boolean }) => {
      const nextUrl = normalizeBrowserInput(rawUrl);
      if (!activeTab || options?.newTab) {
        updateBrowserSession((current) => addBrowserTab(current, { activate: true, url: nextUrl }));
        return;
      }
      updateBrowserSession((current) => updateBrowserTab(current, activeTab.id, { url: nextUrl }));
      webviewHandlesRef.current.get(activeTab.id)?.navigate(nextUrl);
    },
    [activeTab, updateBrowserSession],
  );

  const goBack = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.goBack();
  }, [activeTab]);

  const goForward = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.goForward();
  }, [activeTab]);

  const reload = useCallback(() => {
    if (!activeTab) return;
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (activeRuntime.loading) {
      handle?.stop();
      return;
    }
    handle?.reload();
  }, [activeRuntime.loading, activeTab]);

  const openDevTools = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.openDevTools();
  }, [activeTab]);

  const closeDevTools = useCallback(() => {
    if (!activeTab) return;
    webviewHandlesRef.current.get(activeTab.id)?.closeDevTools();
  }, [activeTab]);

  const toggleDevTools = useCallback(() => {
    if (!activeTab) return;
    const handle = webviewHandlesRef.current.get(activeTab.id);
    if (!handle) return;
    if (handle.isDevToolsOpen()) {
      handle.closeDevTools();
      return;
    }
    handle.openDevTools();
  }, [activeTab]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }
    setDraftUrl(activeTab.url);
  }, [activeTab]);

  useEffect(() => {
    onActiveRuntimeStateChange?.({
      devToolsOpen: activeRuntime.devToolsOpen,
      loading: activeRuntime.loading,
    });
  }, [activeRuntime.devToolsOpen, activeRuntime.loading, onActiveRuntimeStateChange]);

  useEffect(() => {
    if (!open || mode === "pip") {
      return;
    }
    addressInputRef.current?.focus();
  }, [mode, open]);

  useEffect(() => {
    pipBoundsRef.current = pipBounds;
  }, [pipBounds]);

  useEffect(() => {
    const syncBounds = () => {
      const viewportRect = resolveViewportRect(viewportRef);
      setPipBounds((current) => clampPipBounds(current, viewportRect));
    };

    syncBounds();
    window.addEventListener("resize", syncBounds);
    const viewport = viewportRef?.current;
    const observer =
      viewport && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncBounds();
          })
        : null;
    if (observer && viewport) {
      observer.observe(viewport);
    }

    return () => {
      window.removeEventListener("resize", syncBounds);
      observer?.disconnect();
    };
  }, [viewportRef]);

  useEffect(() => {
    setTabRuntimeById((current) => {
      const validIds = new Set(browserSession.tabs.map((tab) => tab.id));
      const entries = Object.entries(current).filter(([tabId]) => validIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [browserSession.tabs]);

  useEffect(() => {
    const controller: InAppBrowserController = {
      closeDevTools,
      goBack,
      goForward,
      openDevTools,
      openUrl,
      reload,
      toggleDevTools,
    };
    onControllerChange?.(controller);
    return () => {
      onControllerChange?.(null);
    };
  }, [
    closeDevTools,
    goBack,
    goForward,
    onControllerChange,
    openDevTools,
    openUrl,
    reload,
    toggleDevTools,
  ]);

  const registerWebviewHandle = useCallback((tabId: string, handle: BrowserTabHandle | null) => {
    if (handle) {
      webviewHandlesRef.current.set(tabId, handle);
      return;
    }
    webviewHandlesRef.current.delete(tabId);
  }, []);

  const handleTabSnapshotChange = useCallback(
    (tabId: string, snapshot: BrowserTabSnapshot) => {
      setTabRuntimeById((current) => {
        const previous = current[tabId];
        if (
          previous?.canGoBack === snapshot.canGoBack &&
          previous?.canGoForward === snapshot.canGoForward &&
          previous?.devToolsOpen === snapshot.devToolsOpen &&
          previous?.loading === snapshot.loading
        ) {
          return current;
        }
        return {
          ...current,
          [tabId]: {
            canGoBack: snapshot.canGoBack,
            canGoForward: snapshot.canGoForward,
            devToolsOpen: snapshot.devToolsOpen,
            loading: snapshot.loading,
          },
        };
      });
      updateBrowserSession((current) => updateBrowserTab(current, tabId, snapshot));
    },
    [updateBrowserSession],
  );

  const syncPipBounds = useCallback(
    (nextBounds: BrowserPipBounds) => {
      const clamped = clampPipBounds(nextBounds, resolveViewportRect(viewportRef));
      pipBoundsRef.current = clamped;
      setPipBounds(clamped);
    },
    [viewportRef],
  );

  const handlePipDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mode !== "pip" || event.button !== 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("button, input, form, [data-browser-control]")) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pipDragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: pipBoundsRef.current,
      };
    },
    [mode],
  );

  const handlePipDragPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = pipDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      syncPipBounds({
        ...dragState.startBounds,
        x: dragState.startBounds.x + (event.clientX - dragState.startX),
        y: dragState.startBounds.y + (event.clientY - dragState.startY),
      });
    },
    [syncPipBounds],
  );

  const handlePipDragPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = pipDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    pipDragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlePipResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mode !== "pip" || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      pipResizeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: pipBoundsRef.current,
      };
    },
    [mode],
  );

  const handlePipResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = pipResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      syncPipBounds({
        ...resizeState.startBounds,
        width: resizeState.startBounds.width + (event.clientX - resizeState.startX),
        height: resizeState.startBounds.height + (event.clientY - resizeState.startY),
      });
    },
    [syncPipBounds],
  );

  const handlePipResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = pipResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    pipResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const browserShellStyle = useMemo<CSSProperties | undefined>(() => {
    if (mode === "full") {
      return {
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
      };
    }
    if (mode === "split") {
      return undefined;
    }
    return {
      left: `${pipBounds.x}px`,
      top: `${pipBounds.y}px`,
      width: `${pipBounds.width}px`,
      height: `${pipBounds.height}px`,
    };
  }, [mode, pipBounds.height, pipBounds.width, pipBounds.x, pipBounds.y]);

  const activeTabFavicon = activeTab ? (
    <BrowserFavicon
      url={activeTab.url}
      title={activeTab.title}
      className="size-3.5"
      fallbackClassName="size-3.5 text-muted-foreground"
    />
  ) : null;
  const devToolsButtonClassName = cn(
    activeRuntime.devToolsOpen &&
      "border-amber-500/60 bg-amber-500/14 text-amber-800 hover:bg-amber-500/18 dark:text-amber-200",
  );
  const browserStatusLabel = activeRuntime.devToolsOpen
    ? activeRuntime.loading
      ? "Inspecting · Loading"
      : "Inspecting"
    : activeRuntime.loading
      ? "Loading"
      : null;

  if (!open) {
    return null;
  }

  return (
    <div
      aria-hidden={!open}
      className={cn(
        mode === "split"
          ? "relative z-20 flex h-full min-h-0 min-w-0"
          : "absolute z-30 min-h-0 min-w-0 will-change-[left,top,width,height,transform] transition-[left,top,width,height,transform,opacity,box-shadow,border-radius] duration-250 ease-out",
        mode === "full" ? "inset-0" : mode === "pip" ? "pointer-events-auto" : null,
      )}
      style={browserShellStyle}
    >
      <section
        className={cn(
          "flex size-full min-h-0 flex-col overflow-hidden border border-border/70 bg-background/98 text-foreground backdrop-blur-sm [-webkit-app-region:no-drag]",
          mode === "full"
            ? "rounded-none shadow-none"
            : mode === "split"
              ? "rounded-none border-y-0 border-r-0 border-l shadow-none"
              : "rounded-2xl shadow-[0_20px_55px_-18px_color-mix(in_srgb,var(--foreground)_20%,transparent)]",
        )}
      >
        {mode === "pip" ? (
          <>
            <div
              className="flex items-center gap-2 border-b border-border/70 bg-card/88 px-3 py-2 select-none"
              onDoubleClick={onRestore}
              onPointerDown={handlePipDragPointerDown}
              onPointerMove={handlePipDragPointerMove}
              onPointerUp={handlePipDragPointerEnd}
              onPointerCancel={handlePipDragPointerEnd}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                {activeTabFavicon}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {activeTab?.title ?? "Browser"}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {activeTab?.url ?? draftUrl}
                  </div>
                </div>
                {browserSession.tabs.length > 1 ? (
                  <span className="rounded-full border border-border/70 bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {browserSession.tabs.length} tabs
                  </span>
                ) : null}
                {activeRuntime.devToolsOpen ? (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                    DevTools
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1" data-browser-control>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    activeRuntime.devToolsOpen &&
                      "bg-amber-500/12 text-amber-800 hover:bg-amber-500/18 dark:text-amber-200",
                  )}
                  onClick={toggleDevTools}
                  aria-label={
                    activeRuntime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools"
                  }
                  data-browser-control
                >
                  <BugIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={goBack}
                  disabled={!activeRuntime.canGoBack}
                  aria-label="Go back"
                  data-browser-control
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={goForward}
                  disabled={!activeRuntime.canGoForward}
                  aria-label="Go forward"
                  data-browser-control
                >
                  <ArrowRightIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={reload}
                  aria-label={activeRuntime.loading ? "Stop loading" : "Reload page"}
                  data-browser-control
                >
                  {activeRuntime.loading ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onRestore}
                  aria-label="Restore browser"
                  data-browser-control
                >
                  <Maximize2Icon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    if (!activeTab) return;
                    void api?.shell.openExternal(activeTab.url);
                  }}
                  aria-label="Open current page externally"
                  disabled={!activeTab}
                  data-browser-control
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onClose}
                  aria-label="Close browser"
                  data-browser-control
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border bg-card/72 px-3 py-2 sm:px-5">
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5">
                {browserSession.tabs.map((tab) => {
                  const isActive = activeTab?.id === tab.id;
                  return (
                    <div
                      key={tab.id}
                      className={cn(
                        "group flex min-w-0 max-w-64 items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors",
                        isActive
                          ? "border-input bg-background text-foreground shadow-xs/5"
                          : "border-transparent bg-background/35 text-muted-foreground hover:border-border/70 hover:bg-background/60",
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
                        onClick={() => {
                          updateBrowserSession((current) => setActiveBrowserTab(current, tab.id));
                        }}
                        title={tab.title}
                      >
                        <BrowserFavicon
                          url={tab.url}
                          title={tab.title}
                          className="size-3"
                          fallbackClassName="size-3 text-muted-foreground"
                        />
                        <span className="truncate">{tab.title}</span>
                      </button>
                      <button
                        type="button"
                        className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={`Close ${tab.title}`}
                        onClick={() => {
                          updateBrowserSession((current) =>
                            closeBrowserTab(current, tab.id, legacyUrl),
                          );
                        }}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      onClick={() => {
                        updateBrowserSession((current) =>
                          addBrowserTab(current, { activate: true }),
                        );
                      }}
                      aria-label="Open a new browser tab"
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">New tab</TooltipPopup>
              </Tooltip>
            </div>

            <div className="flex items-center gap-2 border-b border-border/80 bg-card/70 px-3 py-2 sm:px-5">
              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className={devToolsButtonClassName}
                        onClick={toggleDevTools}
                        aria-label={
                          activeRuntime.devToolsOpen
                            ? "Close Chrome DevTools"
                            : "Open Chrome DevTools"
                        }
                      >
                        <BugIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {devToolsShortcutLabel
                      ? `${activeRuntime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools"} (${devToolsShortcutLabel})`
                      : activeRuntime.devToolsOpen
                        ? "Close Chrome DevTools"
                        : "Open Chrome DevTools"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={goBack}
                        disabled={!activeRuntime.canGoBack}
                        aria-label="Go back"
                      >
                        <ArrowLeftIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {backShortcutLabel ? `Back (${backShortcutLabel})` : "Back"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={goForward}
                        disabled={!activeRuntime.canGoForward}
                        aria-label="Go forward"
                      >
                        <ArrowRightIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {forwardShortcutLabel ? `Forward (${forwardShortcutLabel})` : "Forward"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={reload}
                        aria-label={activeRuntime.loading ? "Stop loading" : "Reload page"}
                      >
                        {activeRuntime.loading ? (
                          <LoaderCircleIcon className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3.5" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {reloadShortcutLabel
                      ? `${activeRuntime.loading ? "Stop or reload" : "Reload"} (${reloadShortcutLabel})`
                      : activeRuntime.loading
                        ? "Stop or reload"
                        : "Reload"}
                  </TooltipPopup>
                </Tooltip>
              </div>

              <form
                className="flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  openUrl(draftUrl);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2 shadow-xs/5">
                  {activeTabFavicon}
                  <Input
                    ref={addressInputRef}
                    className="border-0 bg-transparent shadow-none before:shadow-none"
                    unstyled
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    placeholder="Enter a URL or search the web"
                    aria-label="Browser address bar"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                {browserStatusLabel ? (
                  <span className="hidden shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 sm:inline-flex dark:text-amber-200">
                    {browserStatusLabel}
                  </span>
                ) : null}
                <Button variant="outline" size="xs" type="submit">
                  Open
                </Button>
              </form>

              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className={devToolsButtonClassName}
                        onClick={toggleDevTools}
                        aria-label={
                          activeRuntime.devToolsOpen
                            ? "Close Chrome DevTools"
                            : "Open Chrome DevTools"
                        }
                      >
                        <BugIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {devToolsShortcutLabel
                      ? `${activeRuntime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools"} (${devToolsShortcutLabel})`
                      : activeRuntime.devToolsOpen
                        ? "Close Chrome DevTools"
                        : "Open Chrome DevTools"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={mode === "split" ? onRestore : onSplit}
                        aria-label={mode === "split" ? "Expand browser" : "Open split view"}
                      >
                        {mode === "split" ? (
                          <Maximize2Icon className="size-3.5" />
                        ) : (
                          <Columns2Icon className="size-3.5" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {mode === "split" ? "Expand to full browser" : "Open split view"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={onMinimize}
                        aria-label="Minimize browser to picture-in-picture"
                      >
                        <PictureInPicture2Icon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Minimize to PiP</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={() => {
                          if (!activeTab) return;
                          void api?.shell.openExternal(activeTab.url);
                        }}
                        disabled={!activeTab}
                        aria-label="Open current page externally"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Open externally</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={onClose}
                        aria-label="Close in-app browser"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Close browser</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </>
        )}

        <div className="relative min-h-0 flex-1 bg-background">
          {browserSession.tabs.map((tab) => (
            <BrowserTabWebview
              key={tab.id}
              active={activeTab?.id === tab.id}
              tab={tab}
              onHandleChange={registerWebviewHandle}
              onSnapshotChange={handleTabSnapshotChange}
            />
          ))}
        </div>

        {mode === "pip" ? (
          <div
            className="absolute right-0 bottom-0 z-10 h-5 w-5 cursor-se-resize rounded-tl-xl bg-linear-to-br from-transparent via-transparent to-border/60"
            onPointerDown={handlePipResizePointerDown}
            onPointerMove={handlePipResizePointerMove}
            onPointerUp={handlePipResizePointerEnd}
            onPointerCancel={handlePipResizePointerEnd}
            data-browser-control
            aria-hidden="true"
          />
        ) : null}
      </section>
    </div>
  );
}
