import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_PANEL_HEIGHT,
  addBrowserTab,
  clampBrowserPanelHeight,
  closeBrowserTab,
  createBrowserSessionState,
  normalizeBrowserSessionState,
  updateBrowserTab,
} from "./browserSession";

describe("browserSession", () => {
  it("creates a default session with one active tab", () => {
    const state = createBrowserSessionState("https://example.com/");

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(state.tabs[0]?.url).toBe("https://example.com/");
    expect(state.panelHeight).toBe(DEFAULT_BROWSER_PANEL_HEIGHT);
  });

  it("adds a tab and activates it by default", () => {
    const state = addBrowserTab(createBrowserSessionState(), {
      url: "https://example.com/docs",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(state.tabs[1]?.url).toBe("https://example.com/docs");
  });

  it("updates a tab title and URL", () => {
    const state = createBrowserSessionState();
    const tabId = state.tabs[0]?.id ?? "";

    const next = updateBrowserTab(state, tabId, {
      url: "https://github.com/openai/codex",
      title: "Codex",
    });

    expect(next.tabs[0]).toMatchObject({
      id: tabId,
      title: "Codex",
      url: "https://github.com/openai/codex",
    });
  });

  it("keeps at least one tab when closing the final tab", () => {
    const state = createBrowserSessionState("https://example.com/");
    const next = closeBrowserTab(state, state.tabs[0]?.id ?? "");

    expect(next.tabs).toHaveLength(1);
    expect(next.activeTabId).toBe(next.tabs[0]?.id);
  });

  it("normalizes duplicate tabs and invalid active ids", () => {
    const duplicated = createBrowserSessionState("https://example.com/");
    const normalized = normalizeBrowserSessionState(
      {
        activeTabId: "missing",
        panelHeight: 9999,
        tabs: [duplicated.tabs[0]!, duplicated.tabs[0]!],
      },
      "https://example.com/",
      800,
    );

    expect(normalized.tabs).toHaveLength(1);
    expect(normalized.activeTabId).toBe(normalized.tabs[0]?.id);
    expect(normalized.panelHeight).toBe(clampBrowserPanelHeight(9999, 800));
  });
});
