const DEFAULT_BROWSER_HOME_URL = "https://duckduckgo.com/";
const SEARCH_URL_PREFIX = "https://duckduckgo.com/?q=";
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
const LOCAL_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+\.local)(?::\d+)?(?:\/.*)?$/i;

export { DEFAULT_BROWSER_HOME_URL };

export function normalizeBrowserInput(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0) {
    return DEFAULT_BROWSER_HOME_URL;
  }

  if (HTTP_SCHEME_PATTERN.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      return `${SEARCH_URL_PREFIX}${encodeURIComponent(value)}`;
    }

    return `${SEARCH_URL_PREFIX}${encodeURIComponent(value)}`;
  }

  if (/\s/.test(value)) {
    return `${SEARCH_URL_PREFIX}${encodeURIComponent(value)}`;
  }

  const defaultScheme = LOCAL_HOST_PATTERN.test(value) ? "http://" : "https://";

  try {
    return new URL(`${defaultScheme}${value}`).toString();
  } catch {
    return `${SEARCH_URL_PREFIX}${encodeURIComponent(value)}`;
  }
}
