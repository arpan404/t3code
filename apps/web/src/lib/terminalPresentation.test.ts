import { describe, expect, it } from "vitest";

import {
  applyTerminalInputToBuffer,
  buildTerminalFallbackTitle,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
  normalizeTerminalPaneRatios,
  resizeTerminalPaneRatios,
} from "./terminalPresentation";

describe("deriveTerminalTitleFromCommand", () => {
  it("extracts useful titles from common package manager commands", () => {
    expect(deriveTerminalTitleFromCommand("bun run dev")).toBe("bun dev");
    expect(deriveTerminalTitleFromCommand("npm test")).toBe("npm test");
    expect(deriveTerminalTitleFromCommand("pnpm lint && pnpm typecheck")).toBe("pnpm lint");
  });

  it("handles git, docker compose, and script runtimes", () => {
    expect(deriveTerminalTitleFromCommand("git status")).toBe("git status");
    expect(deriveTerminalTitleFromCommand("docker compose up")).toBe("docker compose up");
    expect(deriveTerminalTitleFromCommand("python scripts/release.py")).toBe("python release.py");
  });
});

describe("applyTerminalInputToBuffer", () => {
  it("tracks typed text and yields a submitted command on enter", () => {
    const first = applyTerminalInputToBuffer("", "bun run dev");
    expect(first).toEqual({ buffer: "bun run dev", submittedCommand: null });
    const second = applyTerminalInputToBuffer(first.buffer, "\r");
    expect(second).toEqual({ buffer: "", submittedCommand: "bun run dev" });
  });

  it("supports backspace and clear shortcuts", () => {
    expect(applyTerminalInputToBuffer("bun run devx", "\u007f")).toEqual({
      buffer: "bun run dev",
      submittedCommand: null,
    });
    expect(applyTerminalInputToBuffer("bun run dev", "\u0015")).toEqual({
      buffer: "",
      submittedCommand: null,
    });
  });
});

describe("extractTerminalOscTitle", () => {
  it("reads OSC 0 and OSC 2 terminal titles", () => {
    expect(extractTerminalOscTitle("\u001b]0;bun dev\u0007")).toBe("bun dev");
    expect(extractTerminalOscTitle("\u001b]2;git status\u001b\\")).toBe("git status");
  });
});

describe("terminal pane ratios", () => {
  it("normalizes invalid ratio input", () => {
    expect(normalizeTerminalPaneRatios([], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("resizes adjacent panes while preserving the total", () => {
    const resized = resizeTerminalPaneRatios({
      ratios: [0.5, 0.5],
      dividerIndex: 0,
      deltaPx: 120,
      containerWidthPx: 600,
      minPaneWidthPx: 160,
    });
    expect(resized[0]).toBeCloseTo(0.7, 2);
    expect(resized[1]).toBeCloseTo(0.3, 2);
  });
});

describe("buildTerminalFallbackTitle", () => {
  it("uses the cwd for the default terminal and a shell label for extra terminals", () => {
    expect(buildTerminalFallbackTitle("/Users/arpanbhandari/Code/t3code", "default")).toBe(
      "t3code",
    );
    expect(buildTerminalFallbackTitle("/Users/arpanbhandari/Code/t3code", "terminal-2")).toBe(
      "t3code shell",
    );
  });
});
