import { describe, expect, it } from "vitest";

import { normalizeTextGenerationModelSelection } from "./RoutingTextGeneration";

describe("normalizeTextGenerationModelSelection", () => {
  it("preserves supported text-generation providers", () => {
    expect(
      normalizeTextGenerationModelSelection({
        provider: "githubCopilot",
        model: "gpt-5-mini",
      }),
    ).toEqual({
      provider: "githubCopilot",
      model: "gpt-5-mini",
    });
  });

  it("preserves Cursor selections now that Cursor has a real text-generation backend", () => {
    expect(
      normalizeTextGenerationModelSelection({
        provider: "cursor",
        model: "claude-4-sonnet",
      }),
    ).toEqual({
      provider: "cursor",
      model: "claude-4-sonnet",
    });
  });

  it("falls back OpenCode selections to the default Codex text-generation model", () => {
    expect(
      normalizeTextGenerationModelSelection({
        provider: "opencode",
        model: "auto",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });
});
