import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";
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

  it("falls back unsupported Cursor selections to Codex defaults", () => {
    expect(
      normalizeTextGenerationModelSelection({
        provider: "cursor",
        model: "claude-4-sonnet",
      }),
    ).toEqual({
      provider: "codex",
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    });
  });
});
