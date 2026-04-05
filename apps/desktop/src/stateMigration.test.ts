import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopBaseDir, resolveDesktopUserDataPath } from "./stateMigration";

describe("resolveDesktopBaseDir", () => {
  it("copies legacy .t3 state into .ace", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-desktop-base-"));
    mkdirSync(path.join(fakeHome, ".t3", "userdata"), { recursive: true });
    writeFileSync(path.join(fakeHome, ".t3", "userdata", "state.sqlite"), "legacy-db");

    const resolved = resolveDesktopBaseDir({ homeDir: fakeHome });

    expect(resolved).toBe(path.join(fakeHome, ".ace"));
    expect(existsSync(path.join(resolved, "userdata", "state.sqlite"))).toBe(true);
  });
});

describe("resolveDesktopUserDataPath", () => {
  it("copies legacy T3 Code profile data into the new ace profile dir", () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "ace-desktop-userdata-"));
    const appSupportDir = path.join(fakeHome, "Library", "Application Support");
    const legacyDir = path.join(appSupportDir, "T3 Code (Alpha)");
    mkdirSync(path.join(legacyDir, "Local Storage"), { recursive: true });
    writeFileSync(path.join(legacyDir, "Local Storage", "history.txt"), "legacy-history");

    const resolved = resolveDesktopUserDataPath({
      platform: "darwin",
      userDataDirName: "ace",
      legacyUserDataDirNames: ["T3 Code (Alpha)", "t3code"],
      homeDir: fakeHome,
    });

    expect(resolved).toBe(path.join(appSupportDir, "ace"));
    expect(readFileSync(path.join(resolved, "Local Storage", "history.txt"), "utf8")).toBe(
      "legacy-history",
    );
  });
});
