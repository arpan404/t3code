import { describe, expect, it } from "vitest";

import { permissionOptionIdForRuntimeMode } from "./CursorAdapter";

describe("permissionOptionIdForRuntimeMode", () => {
  it("auto-approves Cursor ACP tool permissions for full-access sessions", () => {
    expect(permissionOptionIdForRuntimeMode("full-access")).toEqual({
      primary: "allow-always",
      decision: "acceptForSession",
    });
  });

  it("keeps manual approval flow for approval-required sessions", () => {
    expect(permissionOptionIdForRuntimeMode("approval-required")).toEqual({
      primary: "allow-once",
      decision: "accept",
    });
  });
});
