import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  checkCursorProviderStatus,
  parseCursorModelsOutput,
  resolveCursorCliModelId,
} from "./CursorProvider.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

describe("CursorProvider", () => {
  it("parses Cursor model families and capability metadata", () => {
    const parsed = parseCursorModelsOutput(
      [
        "claude-4.6-opus - Claude 4.6 Opus",
        "claude-4.6-opus-fast - Claude 4.6 Opus Fast",
        "claude-4.6-opus-high-thinking - Claude 4.6 Opus High Thinking",
        "claude-4.6-opus-max-thinking - Claude 4.6 Opus Max Thinking (default)",
      ].join("\n"),
    );

    assert.deepEqual(
      parsed.map((model) => model.slug),
      [
        "claude-4.6-opus",
        "claude-4.6-opus-fast",
        "claude-4.6-opus-high-thinking",
        "claude-4.6-opus-max-thinking",
      ],
    );
    assert.deepEqual(parsed[0]?.capabilities, {
      reasoningEffortLevels: [
        { value: "high", label: "High", isDefault: false },
        { value: "medium", label: "Medium", isDefault: true },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });
    assert.deepEqual(parsed[3]?.cursorMetadata, {
      familySlug: "claude-4.6-opus",
      familyName: "Claude 4.6 Opus",
      fastMode: false,
      thinking: true,
      maxMode: true,
    });
  });

  it("resolves Cursor CLI model ids from family slugs plus options", () => {
    assert.equal(resolveCursorCliModelId({ model: "claude-4.6-opus" }), "claude-4.6-opus");
    assert.equal(
      resolveCursorCliModelId({
        model: "claude-4.6-opus",
        options: { reasoningEffort: "high", fastMode: true },
      }),
      "claude-4.6-opus-high-fast",
    );
    assert.equal(
      resolveCursorCliModelId({
        model: "claude-4.6-opus-none",
        options: { reasoningEffort: "medium", fastMode: true },
      }),
      "claude-4.6-opus-fast",
    );
  });

  it.effect("returns ready with discovered models when Cursor Agent is installed", () =>
    Effect.gen(function* () {
      const status = yield* checkCursorProviderStatus();

      assert.equal(status.provider, "cursor");
      assert.equal(status.installed, true);
      assert.equal(status.status, "ready");
      assert.equal(status.auth.status, "authenticated");
      assert.equal(status.auth.label, "dev@example.com");
      assert.equal(status.version, "cursor-agent 1.0.0");
      assert.equal(
        status.models.some((model) => model.slug === "claude-4.6-opus-fast"),
        true,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "cursor-agent 1.0.0\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return {
                stdout: [
                  "claude-4.6-opus - Claude 4.6 Opus",
                  "claude-4.6-opus-fast - Claude 4.6 Opus Fast",
                ].join("\n"),
                stderr: "",
                code: 0,
              };
            }
            if (joined === "about") {
              return { stdout: "User Email dev@example.com\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("returns unauthenticated when Cursor Agent about output says not logged in", () =>
    Effect.gen(function* () {
      const status = yield* checkCursorProviderStatus();

      assert.equal(status.status, "error");
      assert.equal(status.installed, true);
      assert.equal(status.auth.status, "unauthenticated");
      assert.equal(
        status.message,
        "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "cursor-agent 1.0.0\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "", stderr: "", code: 0 };
            }
            if (joined === "about") {
              return { stdout: "User Email not logged in\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect("returns unavailable when Cursor Agent is missing", () =>
    Effect.gen(function* () {
      const status = yield* checkCursorProviderStatus();

      assert.equal(status.status, "error");
      assert.equal(status.installed, false);
      assert.equal(status.auth.status, "unknown");
      assert.equal(
        status.message,
        "Cursor Agent (`cursor-agent`) is not installed or not on PATH.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          failingSpawnerLayer("spawn cursor-agent ENOENT"),
        ),
      ),
    ),
  );
});
