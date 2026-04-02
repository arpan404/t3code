import {
  DEFAULT_BROWSER_SEARCH_ENGINE,
  type BrowserSearchEngine,
} from "@t3tools/contracts/settings";

const SEARCH_ENGINE_CONFIG = {
  brave: {
    homeUrl: "https://search.brave.com/",
    searchUrlPrefix: "https://search.brave.com/search?q=",
  },
  duckduckgo: {
    homeUrl: "https://duckduckgo.com/",
    searchUrlPrefix: "https://duckduckgo.com/?q=",
  },
  google: {
    homeUrl: "https://www.google.com/",
    searchUrlPrefix: "https://www.google.com/search?q=",
  },
  startpage: {
    homeUrl: "https://www.startpage.com/",
    searchUrlPrefix: "https://www.startpage.com/sp/search?query=",
  },
} satisfies Record<BrowserSearchEngine, { homeUrl: string; searchUrlPrefix: string }>;

const DEFAULT_BROWSER_HOME_URL = SEARCH_ENGINE_CONFIG[DEFAULT_BROWSER_SEARCH_ENGINE].homeUrl;
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
const DOMAIN_WITH_TLD_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:[/?#].*)?$/i;
const LOCAL_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+\.local)(?::\d+)?(?:\/.*)?$/i;

export { DEFAULT_BROWSER_HOME_URL };

export function normalizeBrowserHttpUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  if (value.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveBrowserHomeUrl(searchEngine: BrowserSearchEngine): string {
  return SEARCH_ENGINE_CONFIG[searchEngine].homeUrl;
}

function resolveBrowserSearchUrl(searchEngine: BrowserSearchEngine, value: string): string {
  return `${SEARCH_ENGINE_CONFIG[searchEngine].searchUrlPrefix}${encodeURIComponent(value)}`;
}

export type BrowserInputIntent = "home" | "navigate" | "search";

export function resolveBrowserInputTarget(
  rawValue: string,
  searchEngine: BrowserSearchEngine = DEFAULT_BROWSER_SEARCH_ENGINE,
): { intent: BrowserInputIntent; url: string } {
  const value = rawValue.trim();
  if (value.length === 0) {
    return {
      intent: "home",
      url: resolveBrowserHomeUrl(searchEngine),
    };
  }

  if (HTTP_SCHEME_PATTERN.test(value)) {
    const normalizedUrl = normalizeBrowserHttpUrl(value);
    if (normalizedUrl) {
      return {
        intent: "navigate",
        url: normalizedUrl,
      };
    }

    return {
      intent: "search",
      url: resolveBrowserSearchUrl(searchEngine, value),
    };
  }

  if (/\s/.test(value)) {
    return {
      intent: "search",
      url: resolveBrowserSearchUrl(searchEngine, value),
    };
  }

  if (!LOCAL_HOST_PATTERN.test(value) && !DOMAIN_WITH_TLD_PATTERN.test(value)) {
    return {
      intent: "search",
      url: resolveBrowserSearchUrl(searchEngine, value),
    };
  }

  const defaultScheme = LOCAL_HOST_PATTERN.test(value) ? "http://" : "https://";

  try {
    return {
      intent: "navigate",
      url: new URL(`${defaultScheme}${value}`).toString(),
    };
  } catch {
    return {
      intent: "search",
      url: resolveBrowserSearchUrl(searchEngine, value),
    };
  }
}

export function normalizeBrowserInput(
  rawValue: string,
  searchEngine: BrowserSearchEngine = DEFAULT_BROWSER_SEARCH_ENGINE,
): string {
  return resolveBrowserInputTarget(rawValue, searchEngine).url;
}
