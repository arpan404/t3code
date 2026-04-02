import type { BrowserSearchEngine } from "@t3tools/contracts/settings";

import type { BrowserSuggestion } from "~/lib/browser/history";

export const IN_APP_BROWSER_PARTITION = "persist:t3-browser";
export const PIP_MARGIN_PX = 16;
export const MIN_PIP_WIDTH_PX = 320;
export const MIN_PIP_HEIGHT_PX = 216;
export const DEFAULT_PIP_WIDTH_PX = 440;
export const DEFAULT_PIP_HEIGHT_PX = 280;

export const BROWSER_SEARCH_ENGINE_OPTIONS: Array<{
  label: string;
  value: BrowserSearchEngine;
}> = [
  { label: "DuckDuckGo", value: "duckduckgo" },
  { label: "Google", value: "google" },
  { label: "Brave Search", value: "brave" },
  { label: "Startpage", value: "startpage" },
];

export type BrowserWebview = HTMLElement & {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  closeDevTools: () => void;
  getTitle: () => string;
  getURL: () => string;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpened: () => boolean;
  isLoading: () => boolean;
  loadURL: (url: string) => Promise<void>;
  openDevTools: (options?: { mode?: "detach" | "left" | "right" | "bottom" | "undocked" }) => void;
  reload: () => void;
  stop: () => void;
};

export type BrowserTabRuntimeState = {
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen: boolean;
  loading: boolean;
};

export type BrowserTabSnapshot = BrowserTabRuntimeState & {
  title: string;
  url: string;
};

export type BrowserTabHandle = {
  closeDevTools: () => void;
  goBack: () => void;
  goForward: () => void;
  isDevToolsOpen: () => boolean;
  navigate: (url: string) => void;
  openDevTools: () => void;
  reload: () => void;
  stop: () => void;
};

export type BrowserWebviewContextMenuAction =
  | "back"
  | "copy-address"
  | "devtools"
  | "forward"
  | "new-tab"
  | "open-external"
  | "reload";

export type BrowserTabContextMenuAction =
  | "close"
  | "close-others"
  | "close-right"
  | "copy-address"
  | "duplicate"
  | "move-left"
  | "move-right"
  | "new-tab"
  | "open-external"
  | "pin-page"
  | "reload"
  | "unpin-page";

export const DEFAULT_BROWSER_TAB_RUNTIME_STATE: BrowserTabRuntimeState = {
  canGoBack: false,
  canGoForward: false,
  devToolsOpen: false,
  loading: false,
};

export function resolveSuggestionKindLabel(kind: BrowserSuggestion["kind"]): string {
  switch (kind) {
    case "history":
      return "History";
    case "home":
      return "Home";
    case "navigate":
      return "Address";
    case "pinned":
      return "Pinned";
    case "search":
      return "Search";
    case "tab":
      return "Tab";
    default:
      return "Suggestion";
  }
}
