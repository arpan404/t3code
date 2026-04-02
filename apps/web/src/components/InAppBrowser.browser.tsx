import "../index.css";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { BrowserTabState } from "~/lib/browser/session";
import { BROWSER_NEW_TAB_URL } from "~/lib/browser/session";
import { InAppBrowser } from "./InAppBrowser";

const { useInAppBrowserStateMock } = vi.hoisted(() => ({
  useInAppBrowserStateMock: vi.fn(),
}));

vi.mock("~/hooks/useInAppBrowserState", async () => {
  const actual = await vi.importActual<typeof import("~/hooks/useInAppBrowserState")>(
    "~/hooks/useInAppBrowserState",
  );

  return {
    ...actual,
    useInAppBrowserState: useInAppBrowserStateMock,
  };
});

function createTab(id: string, title: string): BrowserTabState {
  return {
    id,
    title,
    url: BROWSER_NEW_TAB_URL,
  };
}

function createHookState(tabs: readonly BrowserTabState[], activeTabId = tabs[0]?.id ?? null) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  return {
    activateTab: vi.fn(),
    activeRuntime: {
      canGoBack: false,
      canGoForward: false,
      devToolsOpen: false,
      loading: false,
    },
    activeTab,
    activeTabIsInternal: true,
    activeTabIsNewTab: true,
    activeTabIsPinned: false,
    activeTabIsSettings: false,
    addressBarSuggestions: [],
    addressInputRef: { current: null },
    applySuggestion: vi.fn(),
    browserHistoryCount: 0,
    browserResetKey: 0,
    browserSearchEngine: "google",
    browserSession: {
      activeTabId: activeTab?.id ?? "",
      panelHeight: 420,
      tabs,
    },
    browserShellStyle: undefined,
    browserStatusLabel: null,
    clearHistory: vi.fn(),
    closeTab: vi.fn(),
    draftUrl: "",
    exportPinnedPages: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    handleAddressBarKeyDown: vi.fn(),
    handleBrowserKeyDownCapture: vi.fn(),
    handlePipDragPointerDown: vi.fn(),
    handlePipDragPointerEnd: vi.fn(),
    handlePipDragPointerMove: vi.fn(),
    handlePipResizePointerDown: vi.fn(),
    handlePipResizePointerEnd: vi.fn(),
    handlePipResizePointerMove: vi.fn(),
    handleTabSnapshotChange: vi.fn(),
    handleWebviewContextMenuFallbackRequest: vi.fn(),
    importPinnedPages: vi.fn(),
    isRepairingStorage: false,
    openActiveTabExternally: vi.fn(),
    openBrowserSettingsTab: vi.fn(),
    openNewTab: vi.fn(),
    openPinnedPage: vi.fn(),
    openTabContextMenu: vi.fn().mockResolvedValue(undefined),
    openUrl: vi.fn(),
    pinnedPages: [],
    reorderTabs: vi.fn(),
    registerWebviewHandle: vi.fn(),
    reload: vi.fn(),
    removePinnedPage: vi.fn(),
    repairBrowserStorage: vi.fn(),
    selectSearchEngine: vi.fn(),
    selectedSuggestionIndex: 0,
    setDraftUrl: vi.fn(),
    setIsAddressBarFocused: vi.fn(),
    setSelectedSuggestionIndex: vi.fn(),
    showAddressBarSuggestions: false,
    toggleDevTools: vi.fn(),
    togglePinnedActivePage: vi.fn(),
  };
}

describe("InAppBrowser tab strip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the tab context menu on right click and closes tabs on middle click", async () => {
    const tabs = [createTab("tab-1", "Alpha Workspace"), createTab("tab-2", "Beta Docs")];
    const hookState = createHookState(tabs);
    useInAppBrowserStateMock.mockReturnValue(hookState);

    const screen = await render(
      <div style={{ position: "relative", width: "720px", height: "560px" }}>
        <InAppBrowser
          open
          mode="full"
          onClose={() => undefined}
          onMinimize={() => undefined}
          onRestore={() => undefined}
          onSplit={() => undefined}
        />
      </div>,
    );

    await screen.getByTitle("Alpha Workspace").click({ button: "right" });
    expect(hookState.openTabContextMenu).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );

    await screen.getByTitle("Beta Docs").click({ button: "middle" });
    expect(hookState.closeTab).toHaveBeenCalledWith("tab-2");
  });

  it("shows overflow controls and scrolls the tab strip", async () => {
    const tabs = Array.from({ length: 10 }, (_, index) =>
      createTab(`tab-${index + 1}`, `Research Surface ${index + 1}`),
    );
    const hookState = createHookState(tabs, tabs[tabs.length - 1]?.id);
    useInAppBrowserStateMock.mockReturnValue(hookState);

    const screen = await render(
      <div style={{ position: "relative", width: "360px", height: "560px" }}>
        <InAppBrowser
          open
          mode="full"
          onClose={() => undefined}
          onMinimize={() => undefined}
          onRestore={() => undefined}
          onSplit={() => undefined}
        />
      </div>,
    );

    await expect.element(screen.getByLabelText("Scroll tabs right")).toBeVisible();

    const tabStrip = document.querySelector('[data-testid="browser-tab-strip"]') as HTMLDivElement;
    expect(tabStrip).toBeTruthy();
    const initialScrollLeft = tabStrip.scrollLeft;

    await screen.getByLabelText("Scroll tabs right").click();

    await vi.waitFor(() => {
      expect(tabStrip.scrollLeft).toBeGreaterThan(initialScrollLeft);
    });
    await expect.element(screen.getByLabelText("Scroll tabs left")).toBeVisible();
  });
});
