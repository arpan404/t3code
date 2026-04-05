export const BROWSER_SPLIT_WIDTH_STORAGE_KEY = "ace:browser:split-width:v1";
export const DEFAULT_BROWSER_SPLIT_WIDTH = 720;
export const MIN_BROWSER_SPLIT_WIDTH = 420;
export const MIN_CHAT_SPLIT_WIDTH = 420;

export function clampBrowserSplitWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const maxWidth = Math.max(MIN_BROWSER_SPLIT_WIDTH, safeViewportWidth - MIN_CHAT_SPLIT_WIDTH);
  const normalizedWidth = Number.isFinite(width) ? Math.round(width) : DEFAULT_BROWSER_SPLIT_WIDTH;
  return Math.min(maxWidth, Math.max(MIN_BROWSER_SPLIT_WIDTH, normalizedWidth));
}
