import * as Schema from "effect/Schema";

import { getLocalStorageItem } from "~/hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";
import { DEFAULT_BROWSER_HOME_URL, normalizeBrowserHttpUrl } from "~/lib/browser/url";

export const BROWSER_SESSION_STORAGE_KEY = "t3code:browser:session:v1";
export const LEGACY_BROWSER_LAST_URL_STORAGE_KEY = "t3code:browser:last-url";
export const BROWSER_NEW_TAB_URL = "t3://browser/new-tab";
export const BROWSER_NEW_TAB_TITLE = "New tab";
export const BROWSER_SETTINGS_TAB_URL = "t3://browser/settings";
export const BROWSER_SETTINGS_TAB_TITLE = "Browser settings";
export const DEFAULT_BROWSER_PANEL_HEIGHT = 360;
export const MIN_BROWSER_PANEL_HEIGHT = 288;

const BROWSER_PANEL_HEIGHT_MAX_RATIO = 0.72;
const BROWSER_PANEL_HEIGHT_VIEWPORT_OFFSET = 220;

export const BrowserTabStateSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
});
export type BrowserTabState = typeof BrowserTabStateSchema.Type;

export const BrowserSessionStorageSchema = Schema.Struct({
  activeTabId: Schema.String,
  panelHeight: Schema.Number,
  tabs: Schema.Array(BrowserTabStateSchema),
});
export type BrowserSessionStorage = typeof BrowserSessionStorageSchema.Type;

export function isBrowserNewTabUrl(url: string): boolean {
  return url === BROWSER_NEW_TAB_URL;
}

export function isBrowserSettingsTabUrl(url: string): boolean {
  return url === BROWSER_SETTINGS_TAB_URL;
}

export function isBrowserInternalTabUrl(url: string): boolean {
  return isBrowserNewTabUrl(url) || isBrowserSettingsTabUrl(url);
}

export function resolveBrowserTabTitle(url: string, title?: string | null): string {
  if (isBrowserNewTabUrl(url)) {
    return BROWSER_NEW_TAB_TITLE;
  }

  if (isBrowserSettingsTabUrl(url)) {
    return BROWSER_SETTINGS_TAB_TITLE;
  }

  const normalizedTitle = title?.trim();
  if (normalizedTitle && normalizedTitle.length > 0) {
    return normalizedTitle;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "").trim();
    if (hostname.length > 0) {
      return hostname;
    }
  } catch {
    // Fall back to a generic title when the current URL cannot be parsed.
  }

  return "New tab";
}

export function createBrowserSettingsTab(id = randomUUID()): BrowserTabState {
  return {
    id,
    title: BROWSER_SETTINGS_TAB_TITLE,
    url: BROWSER_SETTINGS_TAB_URL,
  };
}

export function createBrowserNewTab(id = randomUUID()): BrowserTabState {
  return {
    id,
    title: BROWSER_NEW_TAB_TITLE,
    url: BROWSER_NEW_TAB_URL,
  };
}

export function clampBrowserPanelHeight(
  height: number | null | undefined,
  viewportHeight = 900,
): number {
  const safeViewportHeight =
    Number.isFinite(viewportHeight) && viewportHeight > 0 ? Math.round(viewportHeight) : 900;
  const maxHeight = Math.max(
    MIN_BROWSER_PANEL_HEIGHT,
    Math.min(
      Math.round(safeViewportHeight * BROWSER_PANEL_HEIGHT_MAX_RATIO),
      safeViewportHeight - BROWSER_PANEL_HEIGHT_VIEWPORT_OFFSET,
    ),
  );
  const safeHeight =
    typeof height === "number" && Number.isFinite(height)
      ? Math.round(height)
      : DEFAULT_BROWSER_PANEL_HEIGHT;
  return Math.max(MIN_BROWSER_PANEL_HEIGHT, Math.min(maxHeight, safeHeight));
}

export function createBrowserTabState(
  url = DEFAULT_BROWSER_HOME_URL,
  id = randomUUID(),
): BrowserTabState {
  const normalizedUrl = normalizeStoredBrowserTabUrl(url, DEFAULT_BROWSER_HOME_URL);
  return {
    id,
    url: normalizedUrl,
    title: resolveBrowserTabTitle(normalizedUrl),
  };
}

function normalizeStoredBrowserTabUrl(url: string, fallbackUrl: string): string {
  if (isBrowserInternalTabUrl(url)) {
    return url;
  }

  return normalizeBrowserHttpUrl(url) ?? fallbackUrl;
}

export function createBrowserSessionState(initialUrl = BROWSER_NEW_TAB_URL): BrowserSessionStorage {
  const initialTab = createBrowserTabState(initialUrl);
  return {
    activeTabId: initialTab.id,
    panelHeight: DEFAULT_BROWSER_PANEL_HEIGHT,
    tabs: [initialTab],
  };
}

export function resolveLegacyBrowserUrl(): string {
  return (
    getLocalStorageItem(LEGACY_BROWSER_LAST_URL_STORAGE_KEY, Schema.String) ??
    DEFAULT_BROWSER_HOME_URL
  );
}

export function normalizeBrowserSessionState(
  state: BrowserSessionStorage,
  initialUrl = DEFAULT_BROWSER_HOME_URL,
  viewportHeight = 900,
): BrowserSessionStorage {
  const uniqueTabs = new Map<string, BrowserTabState>();
  for (const tab of state.tabs) {
    if (typeof tab.id !== "string" || tab.id.trim().length === 0) {
      continue;
    }
    const normalizedUrl = normalizeStoredBrowserTabUrl(tab.url, initialUrl);
    uniqueTabs.set(tab.id, {
      id: tab.id,
      url: normalizedUrl,
      title: resolveBrowserTabTitle(normalizedUrl, tab.title),
    });
  }

  const tabs = uniqueTabs.size > 0 ? [...uniqueTabs.values()] : [createBrowserTabState(initialUrl)];
  const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : (tabs[0]?.id ?? createBrowserTabState(initialUrl).id);

  return {
    activeTabId,
    panelHeight: clampBrowserPanelHeight(state.panelHeight, viewportHeight),
    tabs,
  };
}

export function setActiveBrowserTab(
  state: BrowserSessionStorage,
  tabId: string,
): BrowserSessionStorage {
  if (!state.tabs.some((tab) => tab.id === tabId) || state.activeTabId === tabId) {
    return state;
  }
  return {
    ...state,
    activeTabId: tabId,
  };
}

export function addBrowserTab(
  state: BrowserSessionStorage,
  options?: { activate?: boolean; url?: string },
): BrowserSessionStorage {
  const nextTab = createBrowserTabState(options?.url ?? BROWSER_NEW_TAB_URL);
  return {
    ...state,
    activeTabId: options?.activate === false ? state.activeTabId : nextTab.id,
    tabs: [...state.tabs, nextTab],
  };
}

export function duplicateBrowserTab(
  state: BrowserSessionStorage,
  tabId: string,
): BrowserSessionStorage {
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (sourceIndex === -1) {
    return state;
  }

  const sourceTab = state.tabs[sourceIndex]!;
  const duplicatedTabBase = createBrowserTabState(sourceTab.url);
  const duplicatedTab = {
    ...duplicatedTabBase,
    title: sourceTab.title,
  };
  const tabs = [...state.tabs];
  tabs.splice(sourceIndex + 1, 0, duplicatedTab);
  return {
    ...state,
    activeTabId: duplicatedTab.id,
    tabs,
  };
}

export function reorderBrowserTab(
  state: BrowserSessionStorage,
  draggedTabId: string,
  targetTabId: string,
): BrowserSessionStorage {
  if (draggedTabId === targetTabId) {
    return state;
  }

  const draggedIndex = state.tabs.findIndex((tab) => tab.id === draggedTabId);
  const targetIndex = state.tabs.findIndex((tab) => tab.id === targetTabId);
  if (draggedIndex === -1 || targetIndex === -1) {
    return state;
  }

  const tabs = [...state.tabs];
  const [draggedTab] = tabs.splice(draggedIndex, 1);
  if (!draggedTab) {
    return state;
  }
  tabs.splice(targetIndex, 0, draggedTab);
  return {
    ...state,
    tabs,
  };
}

export function moveBrowserTab(
  state: BrowserSessionStorage,
  tabId: string,
  direction: -1 | 1,
): BrowserSessionStorage {
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (sourceIndex === -1) {
    return state;
  }

  const targetIndex = sourceIndex + direction;
  if (targetIndex < 0 || targetIndex >= state.tabs.length) {
    return state;
  }

  return reorderBrowserTab(state, tabId, state.tabs[targetIndex]!.id);
}

export function closeOtherBrowserTabs(
  state: BrowserSessionStorage,
  tabId: string,
  initialUrl = BROWSER_NEW_TAB_URL,
): BrowserSessionStorage {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) {
    return state;
  }

  return normalizeBrowserSessionState(
    {
      ...state,
      activeTabId: tab.id,
      tabs: [tab],
    },
    initialUrl,
  );
}

export function closeTabsToRight(
  state: BrowserSessionStorage,
  tabId: string,
  initialUrl = BROWSER_NEW_TAB_URL,
): BrowserSessionStorage {
  const targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (targetIndex === -1 || targetIndex === state.tabs.length - 1) {
    return state;
  }

  const tabs = state.tabs.slice(0, targetIndex + 1);
  const nextActiveTabId = tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : tabId;
  return normalizeBrowserSessionState(
    {
      ...state,
      activeTabId: nextActiveTabId,
      tabs,
    },
    initialUrl,
  );
}

export function updateBrowserTab(
  state: BrowserSessionStorage,
  tabId: string,
  patch: Partial<Pick<BrowserTabState, "title" | "url">>,
): BrowserSessionStorage {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    const nextUrl =
      typeof patch.url === "string" ? normalizeStoredBrowserTabUrl(patch.url, tab.url) : tab.url;
    const nextTitle = resolveBrowserTabTitle(nextUrl, patch.title ?? tab.title);
    if (tab.url === nextUrl && tab.title === nextTitle) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      url: nextUrl,
      title: nextTitle,
    };
  });

  return changed ? { ...state, tabs } : state;
}

export function closeBrowserTab(
  state: BrowserSessionStorage,
  tabId: string,
  initialUrl = DEFAULT_BROWSER_HOME_URL,
): BrowserSessionStorage {
  const removedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (removedIndex === -1) {
    return state;
  }

  const remainingTabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (remainingTabs.length === 0) {
    return createBrowserSessionState(initialUrl);
  }

  if (state.activeTabId !== tabId) {
    return {
      ...state,
      tabs: remainingTabs,
    };
  }

  const nextActiveTab = remainingTabs[Math.max(0, removedIndex - 1)] ?? remainingTabs[0]!;
  return {
    ...state,
    activeTabId: nextActiveTab.id,
    tabs: remainingTabs,
  };
}
