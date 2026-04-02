import { describe, expect, it } from "vitest";

import {
  buildTerminalColorMenuItems,
  buildTerminalContextMenuItems,
  buildTerminalIconMenuItems,
  buildTerminalSectionMenuItems,
  buildTerminalSidebarDensityItems,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("buildTerminalContextMenuItems", () => {
  it("includes VS Code-style terminal actions and disables split at the group limit", () => {
    expect(
      buildTerminalContextMenuItems({
        label: "bun dev",
        canSplit: false,
        hasCustomTitle: false,
      }),
    ).toEqual([
      { id: "split", label: "Split Terminal", disabled: true },
      { id: "new", label: "New Terminal" },
      { id: "duplicate", label: "Duplicate bun dev" },
      { id: "rename", label: "Rename bun dev" },
      { id: "clear", label: "Clear bun dev" },
      { id: "restart", label: "Restart bun dev" },
      { id: "close", label: "Close bun dev", destructive: true },
    ]);
  });

  it("adds reset title when the terminal has a custom name", () => {
    expect(
      buildTerminalContextMenuItems({
        label: "Workspace shell",
        canSplit: true,
        hasCustomTitle: true,
      }),
    ).toEqual([
      { id: "split", label: "Split Terminal", disabled: false },
      { id: "new", label: "New Terminal" },
      { id: "duplicate", label: "Duplicate Workspace shell" },
      { id: "rename", label: "Rename Workspace shell" },
      { id: "reset-title", label: "Reset Title" },
      { id: "clear", label: "Clear Workspace shell" },
      { id: "restart", label: "Restart Workspace shell" },
      { id: "close", label: "Close Workspace shell", destructive: true },
    ]);
  });
});

describe("buildTerminalIconMenuItems", () => {
  it("marks the selected icon for the submenu", () => {
    expect(buildTerminalIconMenuItems("server")).toEqual([
      { id: "terminal", label: "Terminal", current: false },
      { id: "code", label: "Code", current: false },
      { id: "server", label: "Server", current: true },
      { id: "database", label: "Database", current: false },
      { id: "globe", label: "Globe", current: false },
      { id: "wrench", label: "Wrench", current: false },
    ]);
  });

  it("falls back to the terminal icon when unset", () => {
    expect(buildTerminalIconMenuItems(null)[0]).toEqual({
      id: "terminal",
      label: "Terminal",
      current: true,
    });
  });
});

describe("buildTerminalColorMenuItems", () => {
  it("marks the selected color for the submenu", () => {
    expect(buildTerminalColorMenuItems("emerald")).toEqual([
      { id: "default", label: "Default", current: false },
      { id: "emerald", label: "Emerald", current: true },
      { id: "amber", label: "Amber", current: false },
      { id: "sky", label: "Sky", current: false },
      { id: "rose", label: "Rose", current: false },
      { id: "violet", label: "Violet", current: false },
    ]);
  });

  it("falls back to the default color when unset", () => {
    expect(buildTerminalColorMenuItems(null)[0]).toEqual({
      id: "default",
      label: "Default",
      current: true,
    });
  });
});

describe("buildTerminalSectionMenuItems", () => {
  it("includes bulk terminal actions", () => {
    expect(buildTerminalSectionMenuItems()).toEqual([
      { id: "clear-all", label: "Clear All Terminals" },
      { id: "close-all", label: "Kill All Terminals", destructive: true },
    ]);
  });
});

describe("buildTerminalSidebarDensityItems", () => {
  it("marks compact density when requested", () => {
    expect(buildTerminalSidebarDensityItems("compact")).toEqual([
      { id: "comfortable", label: "Comfortable", current: false },
      { id: "compact", label: "Compact", current: true },
    ]);
  });

  it("defaults to comfortable density", () => {
    expect(buildTerminalSidebarDensityItems()).toEqual([
      { id: "comfortable", label: "Comfortable", current: true },
      { id: "compact", label: "Compact", current: false },
    ]);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });
});
