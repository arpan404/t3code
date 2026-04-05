import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, vi } from "vitest";

import { resolveBaseDir } from "./os-jank";

afterEach(() => {
  vi.restoreAllMocks();
});

it.layer(NodeServices.layer)("resolveBaseDir", (it) => {
  it.effect("migrates legacy .t3 state into the default .ace base dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-os-jank-home-"));
      const legacyBaseDir = path.join(fakeHome, ".t3");
      mkdirSync(path.join(legacyBaseDir, "userdata"), { recursive: true });
      mkdirSync(path.join(legacyBaseDir, "worktrees"), { recursive: true });
      writeFileSync(path.join(legacyBaseDir, "userdata", "state.sqlite"), "legacy-db");
      writeFileSync(path.join(legacyBaseDir, "worktrees", "thread.txt"), "legacy-thread");

      vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      const resolved = yield* resolveBaseDir(undefined);
      expect(resolved).toBe(path.join(fakeHome, ".ace"));
      expect(yield* fs.exists(path.join(resolved, "userdata", "state.sqlite"))).toBe(true);
      expect(yield* fs.exists(path.join(resolved, "worktrees", "thread.txt"))).toBe(true);
    }),
  );

  it.effect("merges missing legacy files into an existing .ace base dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-os-jank-merge-home-"));
      const legacyBaseDir = path.join(fakeHome, ".t3");
      const aceBaseDir = path.join(fakeHome, ".ace");

      mkdirSync(path.join(legacyBaseDir, "userdata"), { recursive: true });
      mkdirSync(path.join(aceBaseDir, "userdata"), { recursive: true });
      writeFileSync(path.join(legacyBaseDir, "userdata", "state.sqlite"), "legacy-db");
      writeFileSync(path.join(aceBaseDir, "userdata", "settings.json"), "{}");

      vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      const resolved = yield* resolveBaseDir(undefined);
      expect(resolved).toBe(aceBaseDir);
      expect(yield* fs.exists(path.join(resolved, "userdata", "state.sqlite"))).toBe(true);
      expect(yield* fs.exists(path.join(resolved, "userdata", "settings.json"))).toBe(true);
    }),
  );
});
