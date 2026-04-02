import { describe, expect, it } from "vitest";

import {
  BROWSER_NEW_TAB_TITLE,
  BROWSER_NEW_TAB_URL,
  BROWSER_SETTINGS_TAB_URL,
  DEFAULT_BROWSER_PANEL_HEIGHT,
  addBrowserTab,
  clampBrowserPanelHeight,
  closeOtherBrowserTabs,
  closeTabsToRight,
  closeBrowserTab,
  createBrowserNewTab,
  createBrowserSessionState,
  duplicateBrowserTab,
  createBrowserSettingsTab,
  isBrowserNewTabUrl,
  isBrowserSettingsTabUrl,
  normalizeBrowserSessionState,
  moveBrowserTab,
  reorderBrowserTab,
  resolveBrowserTabTitle,
  updateBrowserTab,
} from "./session";

describe("browser session", () => {
  it("defaults to an internal new tab page", () => {
    const state = createBrowserSessionState();

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.url).toBe(BROWSER_NEW_TAB_URL);
    expect(state.tabs[0]?.title).toBe(BROWSER_NEW_TAB_TITLE);
  });

  it("creates a single initial tab", () => {
    const state = createBrowserSessionState("https://example.com/");

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(state.panelHeight).toBe(DEFAULT_BROWSER_PANEL_HEIGHT);
  });

  it("adds a new active tab by default", () => {
    const state = addBrowserTab(createBrowserSessionState(), {
      url: "https://openai.com/",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(state.tabs[1]?.url).toBe("https://openai.com/");
  });

  it("creates a new-tab page when no URL is provided", () => {
    const state = addBrowserTab(createBrowserSessionState("https://example.com/"));

    expect(state.tabs[1]?.url).toBe(BROWSER_NEW_TAB_URL);
    expect(state.tabs[1]?.title).toBe(BROWSER_NEW_TAB_TITLE);
  });

  it("updates tab title and url", () => {
    const state = createBrowserSessionState();
    const tabId = state.tabs[0]!.id;

    const updated = updateBrowserTab(state, tabId, {
      title: "Docs",
      url: "https://example.com/docs",
    });

    expect(updated.tabs[0]).toEqual({
      id: tabId,
      title: "Docs",
      url: "https://example.com/docs",
    });
  });

  it("duplicates a tab next to the source", () => {
    const initial = addBrowserTab(createBrowserSessionState("https://example.com/"), {
      url: "https://openai.com/",
    });
    const sourceTabId = initial.tabs[1]!.id;

    const duplicated = duplicateBrowserTab(initial, sourceTabId);

    expect(duplicated.tabs).toHaveLength(3);
    expect(duplicated.tabs[1]?.url).toBe("https://openai.com/");
    expect(duplicated.tabs[2]?.url).toBe("https://openai.com/");
    expect(duplicated.tabs[1]?.id).toBe(sourceTabId);
    expect(duplicated.tabs[2]?.id).not.toBe(sourceTabId);
    expect(duplicated.activeTabId).toBe(duplicated.tabs[2]?.id);
  });

  it("reorders tabs while preserving the active tab id", () => {
    const state = addBrowserTab(
      addBrowserTab(createBrowserSessionState("https://example.com/"), {
        url: "https://openai.com/",
      }),
      { url: "https://github.com/" },
    );

    const reordered = reorderBrowserTab(state, state.tabs[2]!.id, state.tabs[0]!.id);

    expect(reordered.tabs.map((tab) => tab.url)).toEqual([
      "https://github.com/",
      "https://example.com/",
      "https://openai.com/",
    ]);
    expect(reordered.activeTabId).toBe(state.activeTabId);
  });

  it("moves tabs left and right", () => {
    const state = addBrowserTab(
      addBrowserTab(createBrowserSessionState("https://example.com/"), {
        url: "https://openai.com/",
      }),
      { url: "https://github.com/" },
    );

    const movedLeft = moveBrowserTab(state, state.tabs[2]!.id, -1);
    expect(movedLeft.tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/",
      "https://github.com/",
      "https://openai.com/",
    ]);

    const movedRight = moveBrowserTab(movedLeft, movedLeft.tabs[1]!.id, 1);
    expect(movedRight.tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/",
      "https://openai.com/",
      "https://github.com/",
    ]);
  });

  it("closes all tabs except the requested tab", () => {
    const state = addBrowserTab(
      addBrowserTab(createBrowserSessionState("https://example.com/"), {
        url: "https://openai.com/",
      }),
      { url: "https://github.com/" },
    );

    const next = closeOtherBrowserTabs(state, state.tabs[1]!.id);

    expect(next.tabs).toEqual([state.tabs[1]!]);
    expect(next.activeTabId).toBe(state.tabs[1]!.id);
  });

  it("closes tabs to the right of the requested tab", () => {
    const state = addBrowserTab(
      addBrowserTab(createBrowserSessionState("https://example.com/"), {
        url: "https://openai.com/",
      }),
      { url: "https://github.com/" },
    );

    const next = closeTabsToRight(state, state.tabs[1]!.id);

    expect(next.tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/",
      "https://openai.com/",
    ]);
    expect(next.activeTabId).toBe(state.tabs[1]!.id);
  });

  it("closes the active tab and selects the previous one", () => {
    const initial = createBrowserSessionState("https://example.com/");
    const next = addBrowserTab(initial, { url: "https://openai.com/" });

    const closed = closeBrowserTab(next, next.activeTabId, "https://example.com/");

    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).toBe(closed.tabs[0]?.id);
    expect(closed.tabs[0]?.url).toBe("https://example.com/");
  });

  it("normalizes duplicate or invalid tabs", () => {
    const duplicated = createBrowserSessionState("https://example.com/");
    const normalized = normalizeBrowserSessionState(
      {
        activeTabId: "missing",
        panelHeight: 9999,
        tabs: [
          duplicated.tabs[0]!,
          duplicated.tabs[0]!,
          { id: "error", title: "Broken", url: "chrome-error://chromewebdata/" },
          { id: "", title: "", url: "" },
        ],
      },
      "https://example.com/",
      800,
    );

    expect(normalized.tabs).toHaveLength(2);
    expect(normalized.activeTabId).toBe(normalized.tabs[0]?.id);
    expect(normalized.panelHeight).toBe(clampBrowserPanelHeight(9999, 800));
    expect(normalized.tabs[1]?.url).toBe("https://example.com/");
  });

  it("preserves the settings tab while repairing invalid stored URLs", () => {
    const normalized = normalizeBrowserSessionState(
      {
        activeTabId: "settings-tab",
        panelHeight: DEFAULT_BROWSER_PANEL_HEIGHT,
        tabs: [
          {
            id: "settings-tab",
            title: "Broken title",
            url: BROWSER_SETTINGS_TAB_URL,
          },
          {
            id: "bad-tab",
            title: "Error page",
            url: "chrome-error://chromewebdata/",
          },
        ],
      },
      "https://example.com/",
    );

    expect(normalized.activeTabId).toBe("settings-tab");
    expect(normalized.tabs).toEqual([
      {
        id: "settings-tab",
        title: "Browser settings",
        url: BROWSER_SETTINGS_TAB_URL,
      },
      {
        id: "bad-tab",
        title: "Error page",
        url: "https://example.com/",
      },
    ]);
  });

  it("creates a dedicated browser settings tab", () => {
    const tab = createBrowserSettingsTab("settings-tab");

    expect(tab).toEqual({
      id: "settings-tab",
      title: "Browser settings",
      url: BROWSER_SETTINGS_TAB_URL,
    });
    expect(isBrowserSettingsTabUrl(tab.url)).toBe(true);
    expect(resolveBrowserTabTitle(tab.url)).toBe("Browser settings");
  });

  it("creates a dedicated new-tab page", () => {
    const tab = createBrowserNewTab("new-tab");

    expect(tab).toEqual({
      id: "new-tab",
      title: BROWSER_NEW_TAB_TITLE,
      url: BROWSER_NEW_TAB_URL,
    });
    expect(isBrowserNewTabUrl(tab.url)).toBe(true);
    expect(resolveBrowserTabTitle(tab.url)).toBe(BROWSER_NEW_TAB_TITLE);
  });
});
