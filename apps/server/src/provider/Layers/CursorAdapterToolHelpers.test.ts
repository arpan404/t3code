import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildCursorToolData,
  cursorPermissionKindsForDecision,
  cursorPermissionKindsForRuntimeMode,
  describePermissionRequest,
  extractCursorToolCommand,
  extractCursorToolPath,
  parseCursorPermissionOptions,
  resolveCursorToolTitle,
  selectCursorPermissionOption,
} from "./CursorAdapterToolHelpers.ts";

describe("CursorAdapterToolHelpers", () => {
  it("extracts tool command and file path from raw tool payloads", () => {
    const record = {
      title: "`npm run lint`",
      kind: "execute",
      rawInput: {
        command: "`npm run lint`",
        path: "src/index.ts",
      },
    };

    assert.equal(extractCursorToolCommand(record), "npm run lint");
    assert.equal(extractCursorToolPath(record), "src/index.ts");
  });

  it("builds tool data by merging prior item state with normalized input", () => {
    const built = buildCursorToolData(
      {
        item: {
          title: "Previous title",
          kind: "execute",
        },
      },
      {
        title: "`npm run build`",
        kind: "execute",
        status: "completed",
        toolCallId: "tool-1",
        rawInput: {
          command: "npm run build",
          path: "apps/web",
        },
        rawOutput: {
          exitCode: 0,
        },
      },
    );

    assert.deepEqual(built, {
      command: "npm run build",
      path: "apps/web",
      input: {
        command: "npm run build",
        path: "apps/web",
      },
      result: {
        exitCode: 0,
      },
      item: {
        title: "npm run build",
        kind: "execute",
        status: "completed",
        toolCallId: "tool-1",
        command: "npm run build",
        path: "apps/web",
        input: {
          command: "npm run build",
          path: "apps/web",
        },
        result: {
          exitCode: 0,
        },
      },
    });
  });

  it("describes permission requests from tool calls and nested request payloads", () => {
    assert.equal(
      describePermissionRequest({
        toolCall: {
          title: "`git status`",
          kind: "execute",
          status: "pending",
        },
      }),
      "git status",
    );
    assert.equal(describePermissionRequest({ request: { path: "src/index.ts" } }), "src/index.ts");
  });

  it("parses and selects permission options using kinds and fallback matching", () => {
    const options = parseCursorPermissionOptions([
      { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow-session", name: "Allow for session" },
      { optionId: "deny-now", name: "Reject" },
    ]);

    assert.deepEqual(cursorPermissionKindsForDecision("acceptForSession"), [
      "allow_always",
      "allow_once",
    ]);
    assert.deepEqual(cursorPermissionKindsForRuntimeMode("approval-required"), [
      "allow_once",
      "allow_always",
    ]);
    assert.deepEqual(selectCursorPermissionOption(options, ["allow_always"]), {
      optionId: "allow-session",
      name: "Allow for session",
    });
    assert.deepEqual(selectCursorPermissionOption(options, ["reject_once"]), {
      optionId: "deny-now",
      name: "Reject",
    });
  });

  it("falls back to default titles when a raw title looks like a shell command", () => {
    assert.equal(resolveCursorToolTitle("command_execution", "`npm test`"), "Terminal");
    assert.equal(resolveCursorToolTitle("file_change", "Edit README"), "File change");
  });
});
