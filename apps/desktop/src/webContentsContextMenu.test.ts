import { describe, expect, it, vi } from "vitest";

import { buildWebContentsContextMenuTemplate } from "./webContentsContextMenu";

describe("buildWebContentsContextMenuTemplate", () => {
  it("adds link actions ahead of edit actions when a link is present", () => {
    const template = buildWebContentsContextMenuTemplate(
      {
        dictionarySuggestions: [],
        editFlags: {
          canCopy: true,
          canCut: false,
          canPaste: false,
          canSelectAll: true,
        },
        misspelledWord: "",
      },
      {
        onCopyLink: vi.fn(),
        onOpenLink: vi.fn(),
        onReplaceMisspelling: vi.fn(),
      },
    );

    expect(template).toMatchObject([
      { label: "Open Link Externally" },
      { label: "Copy Link Address" },
      { type: "separator" },
      { role: "cut", enabled: false },
      { role: "copy", enabled: true },
      { role: "paste", enabled: false },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("adds spelling suggestions and fallback text for misspellings", () => {
    const withSuggestions = buildWebContentsContextMenuTemplate(
      {
        dictionarySuggestions: ["right", "write"],
        editFlags: {
          canCopy: true,
          canCut: true,
          canPaste: true,
          canSelectAll: true,
        },
        misspelledWord: "rihgt",
      },
      {
        onReplaceMisspelling: vi.fn(),
      },
    );

    expect(withSuggestions[0]).toMatchObject({ label: "right" });
    expect(withSuggestions[1]).toMatchObject({ label: "write" });
    expect(withSuggestions[2]).toMatchObject({ type: "separator" });

    const withoutSuggestions = buildWebContentsContextMenuTemplate(
      {
        dictionarySuggestions: [],
        editFlags: {
          canCopy: true,
          canCut: true,
          canPaste: true,
          canSelectAll: true,
        },
        misspelledWord: "rihgt",
      },
      {
        onReplaceMisspelling: vi.fn(),
      },
    );

    expect(withoutSuggestions[0]).toMatchObject({ label: "No suggestions", enabled: false });
    expect(withoutSuggestions[1]).toMatchObject({ type: "separator" });
  });
});