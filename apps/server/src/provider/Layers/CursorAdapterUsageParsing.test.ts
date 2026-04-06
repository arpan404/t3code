import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildCursorTurnUsageSnapshot,
  buildCursorUsageSnapshot,
  cursorToolUseCount,
} from "./CursorAdapterUsageParsing.ts";

describe("CursorAdapterUsageParsing", () => {
  it("counts tool uses from the active turn", () => {
    assert.equal(
      cursorToolUseCount({
        toolCalls: new Map([
          ["tool-1", {}],
          ["tool-2", {}],
        ]),
      }),
      2,
    );
    assert.equal(cursorToolUseCount({ toolCalls: new Map() }), undefined);
  });

  it("builds a live usage snapshot from context-window updates", () => {
    assert.deepEqual(
      buildCursorUsageSnapshot(
        {
          used_tokens: 32000,
          token_limit: 128000,
        },
        { toolCalls: new Map([["tool-1", {}]]) },
      ),
      {
        usedTokens: 32000,
        maxTokens: 128000,
        lastUsedTokens: 32000,
        toolUses: 1,
      },
    );
  });

  it("derives completion token details from token_count metadata", () => {
    assert.deepEqual(
      buildCursorTurnUsageSnapshot(
        {
          usage: {
            token_count: {
              input_tokens: 1000,
              cached_read_tokens: 200,
              cached_write_tokens: 50,
              output_tokens: 120,
              thought_tokens: 30,
            },
          },
        },
        { toolCalls: new Map([["tool-1", {}]]) },
        {
          usedTokens: 32000,
          maxTokens: 128000,
          lastUsedTokens: 32000,
        },
      ),
      {
        usedTokens: 32000,
        maxTokens: 128000,
        lastUsedTokens: 1400,
        lastInputTokens: 1000,
        lastCachedInputTokens: 250,
        lastOutputTokens: 120,
        lastReasoningOutputTokens: 30,
        toolUses: 1,
      },
    );
  });
});
