import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { ServerProviderModel } from "@t3tools/contracts";

import {
  buildCursorSelectorFamilies,
  cursorFacetValues,
  pickCursorModelFromTraits,
  readCursorMetadataForModel,
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
  {
    slug: "claude-4.6-opus-fast",
    name: "Opus 4.6 Fast",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      fastMode: true,
      thinking: false,
      maxMode: false,
    },
  },
];

describe("cursorModelSelector", () => {
  it("groups exact Cursor models into families with the available variant axes", () => {
    const family = buildCursorSelectorFamilies(CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      models: CURSOR_MODELS,
      reasoningEffortOptions: ["medium", "high"],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      supportsMaxMode: true,
    });
  });

  it("resolves family selections plus options to an exact Cursor slug", () => {
    assert.equal(
      resolveExactCursorModelSelection({
        models: CURSOR_MODELS,
        model: "claude-4.6-opus",
        options: {
          reasoningEffort: "high",
        },
      }),
      "claude-4.6-opus-high",
    );
  });

  it("finds the matching family for an exact selected slug", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max-thinking");

    assert.equal(family?.familySlug, "claude-4.6-opus");
    assert.equal(family?.supportsThinkingToggle, true);
  });

  it("picks an exact slug from family facet selections and exposes metadata", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max");
    assert.ok(family);
    if (!family) {
      return;
    }

    const selected = pickCursorModelFromTraits({
      family,
      selections: {
        reasoningEffort: "medium",
        thinking: true,
        maxMode: true,
      },
    });

    assert.equal(selected?.slug, "claude-4.6-opus-max-thinking");
    assert.deepEqual(readCursorMetadataForModel(selected!), {
      familySlug: "claude-4.6-opus",
      familyName: "Opus 4.6",
      fastMode: false,
      thinking: true,
      maxMode: true,
    });
  });

  it("reads the selected traits for an exact Cursor slug", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max-thinking");

    assert.deepEqual(
      readCursorSelectedTraits({
        family,
        model: "claude-4.6-opus-max-thinking",
      }),
      {
        reasoningEffort: "medium",
        thinking: true,
        fastMode: false,
        maxMode: true,
      },
    );
  });

  it("filters available Cursor facet values against the other selected traits", () => {
    const family = resolveCursorSelectorFamily(CURSOR_MODELS, "claude-4.6-opus-max-thinking");
    assert.ok(family);
    if (!family) {
      return;
    }

    assert.deepEqual(
      cursorFacetValues(family, "thinking", {
        reasoningEffort: "medium",
        maxMode: true,
      }),
      ["false", "true"],
    );

    assert.deepEqual(
      cursorFacetValues(family, "fastMode", {
        reasoningEffort: "medium",
        maxMode: true,
      }),
      ["false"],
    );
  });
});
