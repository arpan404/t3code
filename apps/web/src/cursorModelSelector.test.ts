import { describe, expect, it } from "vitest";
import type { ServerProviderModel } from "@ace/contracts";
import {
  buildCursorSelectorFamilies,
  pickCursorModelFromTraits,
  readCursorSelectedTraits,
  resolveCursorSelectorFamily,
  resolveExactCursorModelSelection,
} from "./cursorModelSelector";

const CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-4.6-opus-high",
    name: "Opus 4.6 High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      reasoningEffort: "high",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "claude-4.6-opus-high-thinking",
    name: "Opus 4.6 High Thinking",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      reasoningEffort: "high",
      fastMode: false,
      thinking: true,
      maxMode: false,
    },
  },
  {
    slug: "claude-4.6-opus-max",
    name: "Opus 4.6 Max",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      fastMode: false,
      thinking: false,
      maxMode: true,
    },
  },
  {
    slug: "claude-4.6-opus-max-thinking",
    name: "Opus 4.6 Max Thinking",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      fastMode: false,
      thinking: true,
      maxMode: true,
    },
  },
];

describe("cursorModelSelector", () => {
  it("groups exact Cursor models into families with available variant axes", () => {
    const family = buildCursorSelectorFamilies(CURSOR_MODELS)[0];
    expect(family).toMatchObject({
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      supportsThinkingToggle: true,
      supportsMaxMode: true,
    });
    expect(family?.reasoningEffortOptions).toEqual(["medium", "high"]);
  });

  it("resolves legacy family selections plus options to an exact Cursor slug", () => {
    expect(
      resolveExactCursorModelSelection({
        models: CURSOR_MODELS,
        model: "claude-4.6-opus",
        options: {
          reasoningEffort: "high",
        },
      }),
    ).toBe("claude-4.6-opus-high");
  });

  it("reads selected traits from the exact current Cursor slug", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max-thinking");
    expect(
      readCursorSelectedTraits({
        family,
        model: "claude-4.6-opus-max-thinking",
      }),
    ).toEqual({
      reasoningEffort: "medium",
      thinking: true,
      maxMode: true,
    });
  });

  it("picks an exact slug from family facet selections", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max");
    expect(family).not.toBeNull();
    if (!family) {
      return;
    }
    expect(
      pickCursorModelFromTraits({
        family,
        selections: {
          reasoningEffort: "medium",
          thinking: true,
          maxMode: true,
        },
      })?.slug,
    ).toBe("claude-4.6-opus-max-thinking");
  });
});
