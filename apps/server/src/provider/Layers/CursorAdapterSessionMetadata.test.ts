import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  EMPTY_CURSOR_SESSION_METADATA,
  buildCursorSessionMetadata,
  cursorSessionMetadataSnapshot,
  findCursorConfigOption,
  parseCursorAvailableCommands,
  parseCursorConfigOptions,
  parseCursorInitializeState,
  parseCursorSessionModeState,
  parseCursorSessionModelState,
} from "./CursorAdapterSessionMetadata.ts";

describe("CursorAdapterSessionMetadata", () => {
  it("parses initialize state and filters invalid auth methods", () => {
    const parsed = parseCursorInitializeState({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }, { id: "   " }, null],
    });

    assert.deepEqual(parsed, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
    });
  });

  it("parses mode and model state only when meaningful values exist", () => {
    assert.equal(parseCursorSessionModeState(undefined), undefined);
    assert.equal(parseCursorSessionModelState(undefined), undefined);

    assert.deepEqual(
      parseCursorSessionModeState({
        currentModeId: "plan",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan" }, { bad: true }],
      }),
      {
        currentModeId: "plan",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan" }],
      },
    );

    assert.deepEqual(
      parseCursorSessionModelState({
        currentModelId: "gpt-5-mini[]",
        availableModels: [
          { modelId: "gpt-5-mini[]", name: "GPT-5 mini (current, default)" },
          { bad: true },
        ],
      }),
      {
        currentModelId: "gpt-5-mini[]",
        availableModels: [{ modelId: "gpt-5-mini[]", name: "GPT-5 mini" }],
      },
    );
  });

  it("strips Cursor current/default suffixes from config option labels", () => {
    const configOptions = parseCursorConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "composer-2-fast[]",
        options: [
          { value: "composer-2-fast[]", name: "Composer 2 Fast (current, default)" },
          { value: "gpt-5.1-codex-max[]", name: "GPT-5.1 Codex Max (default)" },
        ],
      },
    ]);

    assert.deepEqual(configOptions, [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "composer-2-fast[]",
        options: [
          { value: "composer-2-fast[]", name: "Composer 2 Fast" },
          { value: "gpt-5.1-codex-max[]", name: "GPT-5.1 Codex Max" },
        ],
      },
    ]);
  });

  it("builds metadata by merging config options with explicit session state", () => {
    const configOptions = parseCursorConfigOptions([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        currentValue: "agent",
        options: [
          { value: "agent", name: "Agent" },
          { value: "plan", name: "Plan" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5-mini[]",
        options: [
          { value: "gpt-5-mini[]", name: "GPT-5 mini" },
          { value: "claude-4.6-opus[]", name: "Claude 4.6 Opus" },
        ],
      },
    ]);

    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      initialize: parseCursorInitializeState({
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      }),
      configOptions,
      currentModeId: "plan",
      currentModelId: "claude-4.6-opus[]",
      availableCommands: parseCursorAvailableCommands([
        { name: "search", description: "Search files" },
      ]),
    });

    assert.deepEqual(findCursorConfigOption(metadata.configOptions, { category: "mode" }), {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "plan",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    });
    assert.equal(metadata.modes?.currentModeId, "plan");
    assert.equal(metadata.models?.currentModelId, "claude-4.6-opus[]");
    assert.equal(metadata.defaultModeId, "plan");
    assert.deepEqual(metadata.availableCommands, [{ name: "search", description: "Search files" }]);
  });

  it("creates a compact metadata snapshot that omits empty optional fields", () => {
    const metadata = buildCursorSessionMetadata({
      previous: EMPTY_CURSOR_SESSION_METADATA,
      configOptions: [],
    });

    assert.deepEqual(cursorSessionMetadataSnapshot(metadata), {
      initialize: metadata.initialize,
      configOptions: [],
    });
  });
});
