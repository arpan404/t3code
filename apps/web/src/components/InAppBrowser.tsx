import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  Columns2Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  PinIcon,
  PictureInPicture2Icon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
} from "react";
import {
  useInAppBrowserState,
  type ActiveBrowserRuntimeState,
  type InAppBrowserController,
  type InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";
import { isContextMenuPointerDown } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import type { BrowserTabState } from "~/lib/browser/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  BrowserNewTabPanel,
  BrowserSettingsPanel,
  BrowserSuggestionList,
} from "./browser/BrowserChrome";
import { BrowserFavicon, BrowserTabWebview } from "./browser/BrowserWebviewSurface";
import {
  isBrowserInternalTabUrl,
  isBrowserNewTabUrl,
  isBrowserSettingsTabUrl,
} from "~/lib/browser/session";

export type {
  ActiveBrowserRuntimeState,
  InAppBrowserController,
  InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";

function SortableBrowserTab(props: {
  active: boolean;
  icon: ReactNode;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onContextMenuRequest: (tabId: string, position: { x: number; y: number }) => void;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  suppressClickForContextMenuRef: MutableRefObject<boolean>;
  tab: BrowserTabState;
}) {
  const {
    active,
    icon,
    onActivate,
    onClose,
    onContextMenuRequest,
    suppressClickAfterDragRef,
    suppressClickForContextMenuRef,
    tab,
  } = props;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: tab.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex min-w-0 max-w-64 items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors",
        active
          ? "border-input bg-background text-foreground shadow-xs/5"
          : "border-transparent bg-background/35 text-muted-foreground hover:border-border/70 hover:bg-background/60",
        isDragging && "z-20 opacity-80",
        isOver && !isDragging && "ring-1 ring-primary/40",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
        onPointerDownCapture={(event) => {
          suppressClickForContextMenuRef.current = false;
          if (
            isContextMenuPointerDown({
              button: event.button,
              ctrlKey: event.ctrlKey,
              isMac: /mac/i.test(navigator.platform),
            })
          ) {
            suppressClickForContextMenuRef.current = true;
            event.stopPropagation();
          }
        }}
        onClick={() => {
          if (suppressClickAfterDragRef.current) {
            suppressClickAfterDragRef.current = false;
            return;
          }
          if (suppressClickForContextMenuRef.current) {
            suppressClickForContextMenuRef.current = false;
            return;
          }
          onActivate(tab.id);
        }}
        onAuxClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          if (event.button !== 1) {
            return;
          }
          event.preventDefault();
          onClose(tab.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          suppressClickForContextMenuRef.current = true;
          onContextMenuRequest(tab.id, { x: event.clientX, y: event.clientY });
        }}
        title={tab.title}
        {...attributes}
        {...listeners}
      >
        {icon}
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Close ${tab.title}`}
        onClick={() => {
          onClose(tab.id);
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

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
  const {
    activateTab,
    activeRuntime,
    activeTab,
    activeTabIsInternal,
    activeTabIsNewTab,
    activeTabIsPinned,
    activeTabIsSettings,
    addressBarSuggestions,
    addressInputRef,
    applySuggestion,
    browserHistoryCount,
    browserResetKey,
    browserSearchEngine,
    browserSession,
    browserShellStyle,
    browserStatusLabel,
    clearHistory,
    closeTab,
    draftUrl,
    exportPinnedPages,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
    handlePipDragPointerDown,
    handlePipDragPointerEnd,
    handlePipDragPointerMove,
    handlePipResizePointerDown,
    handlePipResizePointerEnd,
    handlePipResizePointerMove,
    handleTabSnapshotChange,
    handleWebviewContextMenuFallbackRequest,
    importPinnedPages,
    isRepairingStorage,
    openActiveTabExternally,
    openBrowserSettingsTab,
    openNewTab,
    openPinnedPage,
    openTabContextMenu,
    openUrl,
    pinnedPages,
    reorderTabs,
    registerWebviewHandle,
    reload,
    removePinnedPage,
    repairBrowserStorage,
    selectSearchEngine,
    selectedSuggestionIndex,
    setDraftUrl,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    showAddressBarSuggestions,
    toggleDevTools,
    togglePinnedActivePage,
  } = useInAppBrowserState({
    mode,
    open,
    ...(onActiveRuntimeStateChange ? { onActiveRuntimeStateChange } : {}),
    ...(onControllerChange ? { onControllerChange } : {}),
    ...(viewportRef ? { viewportRef } : {}),
  });

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
  const tabDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const suppressTabClickAfterDragRef = useRef(false);
  const suppressTabClickForContextMenuRef = useRef(false);
  const handleTabDragStart = useCallback((_event: DragStartEvent) => {
    suppressTabClickAfterDragRef.current = true;
  }, []);
  const handleTabDragCancel = useCallback((_event: DragCancelEvent) => {}, []);
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      reorderTabs(String(active.id), String(over.id));
    },
    [reorderTabs],
  );

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
        onKeyDownCapture={handleBrowserKeyDownCapture}
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
                  disabled={activeTabIsInternal}
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
                  disabled={activeTabIsInternal || !activeRuntime.canGoBack}
                  aria-label="Go back"
                  data-browser-control
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={goForward}
                  disabled={activeTabIsInternal || !activeRuntime.canGoForward}
                  aria-label="Go forward"
                  data-browser-control
                >
                  <ArrowRightIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={reload}
                  disabled={activeTabIsInternal}
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
                    openActiveTabExternally();
                  }}
                  aria-label="Open current page externally"
                  disabled={!activeTab || activeTabIsInternal}
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
              <DndContext
                sensors={tabDnDSensors}
                collisionDetection={closestCenter}
                onDragStart={handleTabDragStart}
                onDragEnd={handleTabDragEnd}
                onDragCancel={handleTabDragCancel}
              >
                <SortableContext
                  items={browserSession.tabs.map((tab) => tab.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5">
                    {browserSession.tabs.map((tab) => {
                      const isActive = activeTab?.id === tab.id;
                      const icon = isBrowserSettingsTabUrl(tab.url) ? (
                        <Settings2Icon className="size-3 text-muted-foreground" />
                      ) : isBrowserNewTabUrl(tab.url) ? (
                        <PlusIcon className="size-3 text-muted-foreground" />
                      ) : (
                        <BrowserFavicon
                          url={tab.url}
                          title={tab.title}
                          className="size-3"
                          fallbackClassName="size-3 text-muted-foreground"
                        />
                      );

                      return (
                        <SortableBrowserTab
                          key={tab.id}
                          active={isActive}
                          icon={icon}
                          onActivate={activateTab}
                          onClose={closeTab}
                          onContextMenuRequest={(tabId, position) => {
                            void openTabContextMenu(tabId, position);
                          }}
                          suppressClickAfterDragRef={suppressTabClickAfterDragRef}
                          suppressClickForContextMenuRef={suppressTabClickForContextMenuRef}
                          tab={tab}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      onClick={openBrowserSettingsTab}
                      aria-label="Open browser settings tab"
                    >
                      <Settings2Icon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">Browser settings</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      onClick={openNewTab}
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
                        disabled={activeTabIsInternal}
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
                        disabled={activeTabIsInternal || !activeRuntime.canGoBack}
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
                        disabled={activeTabIsInternal || !activeRuntime.canGoForward}
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
                        disabled={activeTabIsInternal}
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
                className="relative flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  openUrl(draftUrl);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2 shadow-xs/5">
                  {activeTabFavicon}
                  <Input
                    ref={addressInputRef}
                    className="min-w-0 w-full flex-1 border-0 bg-transparent text-sm shadow-none before:shadow-none"
                    unstyled
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => {
                      window.setTimeout(() => {
                        setIsAddressBarFocused(false);
                      }, 100);
                    }}
                    onFocusCapture={() => {
                      setIsAddressBarFocused(true);
                    }}
                    onKeyDown={handleAddressBarKeyDown}
                    placeholder="Enter a URL or search the web"
                    aria-label="Browser address bar"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    title={draftUrl}
                  />
                </div>
                {showAddressBarSuggestions ? (
                  <BrowserSuggestionList
                    activeIndex={selectedSuggestionIndex}
                    onHighlight={setSelectedSuggestionIndex}
                    suggestions={addressBarSuggestions}
                    onSelect={applySuggestion}
                  />
                ) : null}
                {browserStatusLabel ? (
                  <span className="hidden shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 sm:inline-flex dark:text-amber-200">
                    {browserStatusLabel}
                  </span>
                ) : null}
              </form>

              <div className="flex shrink-0 items-center gap-1.5">
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
                        onClick={togglePinnedActivePage}
                        disabled={activeTabIsInternal || !activeTab}
                        aria-label={activeTabIsPinned ? "Unpin current page" : "Pin current page"}
                        className={cn(
                          activeTabIsPinned &&
                            "border-sky-500/60 bg-sky-500/12 text-sky-700 hover:bg-sky-500/18 dark:text-sky-200",
                        )}
                      >
                        <PinIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {activeTabIsPinned ? "Unpin current page" : "Pin current page"}
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
                          openActiveTabExternally();
                        }}
                        disabled={!activeTab || activeTabIsInternal}
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
          {activeTabIsNewTab ? (
            <BrowserNewTabPanel
              browserSearchEngine={browserSearchEngine}
              pinnedPages={pinnedPages}
              onOpenPinnedPage={openPinnedPage}
              onSubmitQuery={openUrl}
            />
          ) : null}
          {activeTabIsSettings ? (
            <BrowserSettingsPanel
              browserSearchEngine={browserSearchEngine}
              historyCount={browserHistoryCount}
              isRepairingStorage={isRepairingStorage}
              pinnedPages={pinnedPages}
              onClearHistory={clearHistory}
              onExportPinnedPages={exportPinnedPages}
              onImportPinnedPages={(file) => {
                void importPinnedPages(file);
              }}
              onOpenPinnedPage={openPinnedPage}
              onRemovePinnedPage={removePinnedPage}
              onRepairStorage={() => {
                void repairBrowserStorage();
              }}
              onSelectSearchEngine={selectSearchEngine}
            />
          ) : null}
          {browserSession.tabs
            .filter((tab) => !isBrowserInternalTabUrl(tab.url))
            .map((tab) => (
              <BrowserTabWebview
                key={`${browserResetKey}:${tab.id}`}
                active={!activeTabIsInternal && activeTab?.id === tab.id}
                onContextMenuFallbackRequest={handleWebviewContextMenuFallbackRequest}
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
