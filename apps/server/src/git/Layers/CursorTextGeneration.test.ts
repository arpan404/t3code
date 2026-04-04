import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { expect } from "vitest";

import { TextGenerationError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "cursor" as const,
  model: "auto",
};

const CursorTextGenerationTestLayer = CursorTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-cursor-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeCursorBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    stdinMustContain?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cursorPath = `${dir}/cursor-agent`;
    yield* fs.writeFileString(
      cursorPath,
      [
        "#!/bin/sh",
        'args="$*"',
        'stdin_content="$(cat)"',
        ...(input.argsMustContain !== undefined
          ? [
              `if ! printf "%s" "$args" | grep -F -- ${JSON.stringify(input.argsMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "args missing expected content" >&2',
              "  exit 2",
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              "  exit 3",
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [`printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`]
          : []),
        "cat <<'__T3CODE_FAKE_CURSOR_OUTPUT__'",
        input.output,
        "__T3CODE_FAKE_CURSOR_OUTPUT__",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(cursorPath, 0o755);
    return cursorPath;
  });
}

function withFakeCursorBinary<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    stdinMustContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cursor-text-" });
      const cursorPath = yield* makeFakeCursorBinary(tempDir, input);
      const serverSettings = yield* ServerSettingsService;
      const previousSettings = yield* serverSettings.getSettings;
      yield* serverSettings.updateSettings({
        providers: {
          cursor: {
            binaryPath: cursorPath,
          },
        },
      });
      return {
        serverSettings,
        previousBinaryPath: previousSettings.providers.cursor.binaryPath,
      };
    }),
    () => effect,
    ({ serverSettings, previousBinaryPath }) =>
      serverSettings
        .updateSettings({
          providers: {
            cursor: {
              binaryPath: previousBinaryPath,
            },
          },
        })
        .pipe(Effect.asVoid),
  );
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGenerationLive", (it) => {
  it.effect("uses Cursor Agent headless json output for thread titles", () =>
    withFakeCursorBinary(
      {
        output: JSON.stringify({
          result: '\n```json\n{"title":"Fix Cursor text generation"}\n```',
        }),
        argsMustContain: "--model auto",
        stdinMustContain: "Return a JSON object with key: title.",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "fix the Cursor text generation backend",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Fix Cursor text generation");
      }),
    ),
  );

  it.effect("returns typed TextGenerationError when Cursor exits non-zero", () =>
    withFakeCursorBinary(
      {
        output: "",
        exitCode: 1,
        stderr: "cursor execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain(
            "Cursor Agent command failed: cursor execution failed",
          );
        }
      }),
    ),
  );
});
