import { describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_HOME_URL, normalizeBrowserInput } from "./browserUrl";

describe("normalizeBrowserInput", () => {
  it("falls back to the browser home page for empty input", () => {
    expect(normalizeBrowserInput("   ")).toBe(DEFAULT_BROWSER_HOME_URL);
  });

  it("normalizes bare hostnames to https URLs", () => {
    expect(normalizeBrowserInput("example.com")).toBe("https://example.com/");
  });

  it("keeps explicit http URLs intact", () => {
    expect(normalizeBrowserInput("http://example.com/test")).toBe("http://example.com/test");
  });

  it("defaults localhost-like addresses to http for local testing", () => {
    expect(normalizeBrowserInput("localhost:4173")).toBe("http://localhost:4173/");
  });

  it("treats search phrases as search queries", () => {
    expect(normalizeBrowserInput("playwright locator docs")).toBe(
      "https://duckduckgo.com/?q=playwright%20locator%20docs",
    );
  });
});
