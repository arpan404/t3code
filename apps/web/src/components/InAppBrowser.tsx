import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type BrowserWebview = HTMLElement & {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getTitle: () => string;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  isLoading: () => boolean;
  loadURL: (url: string) => void;
  reload: () => void;
  stop: () => void;
};

type BrowserTabRuntimeState = {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

type BrowserTabSnapshot = BrowserTabRuntimeState & {
  title: string;
  url: string;
};

type BrowserTabHandle = {
  goBack: () => void;
  goForward: () => void;
  navigate: (url: string) => void;
  reload: () => void;
  stop: () => void;
};

const DEFAULT_BROWSER_TAB_RUNTIME_STATE: BrowserTabRuntimeState = {
  canGoBack: false,
  canGoForward: false,
  loading: false,
};

export interface InAppBrowserController {
  goBack: () => void;
  goForward: () => void;
  openUrl: (rawUrl: string, options?: { newTab?: boolean }) => void;
  reload: () => void;
}

interface InAppBrowserProps {
  open: boolean;
  onClose: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  backShortcutLabel?: string | null;
  forwardShortcutLabel?: string | null;
  reloadShortcutLabel?: string | null;
}

function resolveViewportHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 900;
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
      goBack: () => {
        if (!readyRef.current || !webviewRef.current?.canGoBack()) return;
        webviewRef.current.goBack();
      },
      goForward: () => {
        if (!readyRef.current || !webviewRef.current?.canGoForward()) return;
        webviewRef.current.goForward();
      },
      navigate,
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
    onClose,
    onControllerChange,
    backShortcutLabel,
    forwardShortcutLabel,
    reloadShortcutLabel,
  } = props;
  const api = readNativeApi();
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const webviewHandlesRef = useRef(new Map<string, BrowserTabHandle>());
  const legacyUrl = useMemo(() => resolveLegacyBrowserUrl(), []);
  const [browserSession, setBrowserSession] = useLocalStorage(
    BROWSER_SESSION_STORAGE_KEY,
    createBrowserSessionState(legacyUrl),
    BrowserSessionStorageSchema,
  );
  const [draftUrl, setDraftUrl] = useState(legacyUrl);
  const [tabRuntimeById, setTabRuntimeById] = useState<Record<string, BrowserTabRuntimeState>>({});

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

  useEffect(() => {
    if (!activeTab) {
      return;
    }
    setDraftUrl(activeTab.url);
  }, [activeTab]);

  useEffect(() => {
    if (!open) {
      return;
    }
    addressInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setTabRuntimeById((current) => {
      const validIds = new Set(browserSession.tabs.map((tab) => tab.id));
      const entries = Object.entries(current).filter(([tabId]) => validIds.has(tabId));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [browserSession.tabs]);

  useEffect(() => {
    const controller: InAppBrowserController = {
      goBack,
      goForward,
      openUrl,
      reload,
    };
    onControllerChange?.(controller);
    return () => {
      onControllerChange?.(null);
    };
  }, [goBack, goForward, onControllerChange, openUrl, reload]);

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
          previous?.loading === snapshot.loading
        ) {
          return current;
        }
        return {
          ...current,
          [tabId]: {
            canGoBack: snapshot.canGoBack,
            canGoForward: snapshot.canGoForward,
            loading: snapshot.loading,
          },
        };
      });
      updateBrowserSession((current) => updateBrowserTab(current, tabId, snapshot));
    },
    [updateBrowserSession],
  );

  return (
    <section
      aria-hidden={!open}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border bg-card/70 px-3 py-2 sm:px-5 [-webkit-app-region:no-drag]">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5">
          {browserSession.tabs.map((tab) => {
            const runtime = tabRuntimeById[tab.id] ?? DEFAULT_BROWSER_TAB_RUNTIME_STATE;
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
                  {runtime.loading ? (
                    <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <GlobeIcon className="size-3 shrink-0" />
                  )}
                  <span className="truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => {
                    updateBrowserSession((current) => closeBrowserTab(current, tab.id, legacyUrl));
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
                  updateBrowserSession((current) => addBrowserTab(current, { activate: true }));
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

      <div className="flex items-center gap-2 border-b border-border/80 bg-card/70 px-3 py-2 sm:px-5 [-webkit-app-region:no-drag]">
        <div className="flex shrink-0 items-center gap-1.5">
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
          <Input
            ref={addressInputRef}
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            placeholder="Enter a URL or search the web"
            aria-label="Browser address bar"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button variant="outline" size="xs" type="submit">
            Open
          </Button>
        </form>

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
    </section>
  );
}
