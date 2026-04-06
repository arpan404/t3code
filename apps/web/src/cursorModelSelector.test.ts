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

const EFFORT_ONLY_CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4-nano-none",
    name: "GPT-5.4 Nano None",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.4-nano",
      familyName: "GPT-5.4 Nano",
      reasoningEffort: "medium",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.4-nano-medium",
    name: "GPT-5.4 Nano",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.4-nano",
      familyName: "GPT-5.4 Nano",
      reasoningEffort: "medium",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.4-nano-high",
    name: "GPT-5.4 Nano High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.4-nano",
      familyName: "GPT-5.4 Nano",
      reasoningEffort: "high",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
];

const SPARK_CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.3-codex-spark-preview-low",
    name: "GPT-5.3 Codex Spark Low",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex-spark-preview",
      familyName: "GPT-5.3 Codex Spark",
      reasoningEffort: "low",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.3-codex-spark-preview",
    name: "GPT-5.3 Codex Spark",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex-spark-preview",
      familyName: "GPT-5.3 Codex Spark",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.3-codex-spark-preview-high",
    name: "GPT-5.3 Codex Spark High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex-spark-preview",
      familyName: "GPT-5.3 Codex Spark",
      reasoningEffort: "high",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.3-codex-spark-preview-xhigh",
    name: "GPT-5.3 Codex Spark Extra High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex-spark-preview",
      familyName: "GPT-5.3 Codex Spark",
      reasoningEffort: "xhigh",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
];

const HIGH_ONLY_CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.3-codex-high",
    name: "GPT-5.3 Codex High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex",
      familyName: "GPT-5.3 Codex",
      reasoningEffort: "high",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.3-codex-xhigh",
    name: "GPT-5.3 Codex Extra High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.3-codex",
      familyName: "GPT-5.3 Codex",
      reasoningEffort: "xhigh",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
];

const CODEX_MAX_CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.1-codex-max-low",
    name: "GPT-5.1 Codex Max Low",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      reasoningEffort: "low",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.1-codex-max-medium",
    name: "GPT-5.1 Codex Max",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      reasoningEffort: "medium",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.1-codex-max-high",
    name: "GPT-5.1 Codex Max High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      reasoningEffort: "high",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.1-codex-max-high-fast",
    name: "GPT-5.1 Codex Max High Fast",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      reasoningEffort: "high",
      fastMode: true,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "gpt-5.1-codex-max-xhigh",
    name: "GPT-5.1 Codex Max Extra High",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      reasoningEffort: "xhigh",
      fastMode: false,
      thinking: false,
      maxMode: false,
    },
  },
];

const FAST_ONLY_CURSOR_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "composer-2-fast",
    name: "Composer 2 Fast",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "composer-2",
      familyName: "Composer 2",
      fastMode: true,
      thinking: false,
      maxMode: false,
    },
  },
  {
    slug: "composer-2",
    name: "Composer 2",
    isCustom: false,
    capabilities: null,
    cursorMetadata: {
      familySlug: "composer-2",
      familyName: "Composer 2",
      fastMode: false,
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

    assert.deepEqual(
      cursorFacetValues(family, "thinking", {
        reasoningEffort: "high",
      }),
      ["false", "true"],
    );
  });

  it("does not invent a thinking toggle for effort-only Cursor families", () => {
    const family = buildCursorSelectorFamilies(EFFORT_ONLY_CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "gpt-5.4-nano",
      familyName: "GPT-5.4 Nano",
      models: EFFORT_ONLY_CURSOR_MODELS,
      reasoningEffortOptions: ["medium", "high"],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      supportsMaxMode: false,
    });

    assert.deepEqual(
      readCursorSelectedTraits({
        family,
        model: "gpt-5.4-nano-medium",
      }),
      {
        reasoningEffort: "medium",
      },
    );
  });

  it("keeps all explicit Spark Preview effort variants available in the selector", () => {
    const family = buildCursorSelectorFamilies(SPARK_CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "gpt-5.3-codex-spark-preview",
      familyName: "GPT-5.3 Codex Spark",
      models: SPARK_CURSOR_MODELS,
      reasoningEffortOptions: ["low", "medium", "high", "xhigh"],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      supportsMaxMode: false,
    });

    const selectedTraits = readCursorSelectedTraits({
      family,
      model: "gpt-5.3-codex-spark-preview",
    });

    assert.deepEqual(selectedTraits, {
      reasoningEffort: "medium",
    });
    assert.deepEqual(cursorFacetValues(family, "reasoningEffort", selectedTraits), [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.equal(
      pickCursorModelFromTraits({
        family,
        selections: { reasoningEffort: "xhigh" },
      })?.slug,
      "gpt-5.3-codex-spark-preview-xhigh",
    );
  });

  it("does not synthesize medium for high-xhigh only Cursor families", () => {
    const family = buildCursorSelectorFamilies(HIGH_ONLY_CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "gpt-5.3-codex",
      familyName: "GPT-5.3 Codex",
      models: HIGH_ONLY_CURSOR_MODELS,
      reasoningEffortOptions: ["high", "xhigh"],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      supportsMaxMode: false,
    });

    assert.deepEqual(
      cursorFacetValues(family, "reasoningEffort", {
        reasoningEffort: "high",
      }),
      ["high", "xhigh"],
    );
    assert.equal(
      resolveExactCursorModelSelection({
        models: HIGH_ONLY_CURSOR_MODELS,
        model: "gpt-5.3-codex",
        options: { reasoningEffort: "xhigh" },
      }),
      "gpt-5.3-codex-xhigh",
    );
  });

  it("treats Codex Max as the family name for max-only Cursor families", () => {
    const family = buildCursorSelectorFamilies(CODEX_MAX_CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "gpt-5.1-codex-max",
      familyName: "GPT-5.1 Codex Max",
      models: CODEX_MAX_CURSOR_MODELS,
      reasoningEffortOptions: ["low", "medium", "high", "xhigh"],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      supportsMaxMode: false,
    });

    assert.deepEqual(
      readCursorSelectedTraits({
        family,
        model: "gpt-5.1-codex-max-medium",
      }),
      {
        reasoningEffort: "medium",
        fastMode: false,
      },
    );

    assert.equal(
      resolveExactCursorModelSelection({
        models: CODEX_MAX_CURSOR_MODELS,
        model: "gpt-5.1-codex-max",
        options: { reasoningEffort: "high", fastMode: true },
      }),
      "gpt-5.1-codex-max-high-fast",
    );
  });

  it("supports fast-only Cursor families like Composer 2", () => {
    const family = buildCursorSelectorFamilies(FAST_ONLY_CURSOR_MODELS)[0];

    assert.deepEqual(family, {
      familySlug: "composer-2",
      familyName: "Composer 2",
      models: FAST_ONLY_CURSOR_MODELS,
      reasoningEffortOptions: [],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      supportsMaxMode: false,
    });

    assert.deepEqual(
      readCursorSelectedTraits({
        family,
        model: "composer-2",
      }),
      {
        fastMode: false,
      },
    );
    assert.deepEqual(cursorFacetValues(family, "fastMode", { fastMode: false }), ["false", "true"]);
    assert.equal(
      pickCursorModelFromTraits({
        family,
        selections: { fastMode: true },
      })?.slug,
      "composer-2-fast",
    );
    assert.equal(
      resolveExactCursorModelSelection({
        models: FAST_ONLY_CURSOR_MODELS,
        model: "composer-2",
        options: { fastMode: true },
      }),
      "composer-2-fast",
    );
  });
});
