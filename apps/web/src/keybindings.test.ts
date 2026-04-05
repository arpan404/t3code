import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  formatShortcutLabel,
  isChatNewShortcut,
  isChatNewLocalShortcut,
  isDiffToggleShortcut,
  isOpenFavoriteEditorShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  shortcutLabelForCommand,
  terminalNavigationShortcutData,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("b"),
    command: "browser.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("["),
    command: "browser.back",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("]"),
    command: "browser.forward",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("r"),
    command: "browser.reload",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("i", { shiftKey: true }),
    command: "browser.devtools",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "browser.duplicateTab",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("[", { altKey: true }),
    command: "browser.moveTabLeft",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  {
    shortcut: modShortcut("]", { altKey: true }),
    command: "browser.moveTabRight",
    whenAst: whenAnd(whenIdentifier("browserOpen"), whenNot(whenIdentifier("terminalFocus"))),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("n", { altKey: true }), command: "editor.newFile" },
  { shortcut: modShortcut("n", { altKey: true, shiftKey: true }), command: "editor.newFolder" },
  {
    shortcut: {
      key: "f2",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
    command: "editor.rename",
    whenAst: whenIdentifier("editorFocus"),
  },
  { shortcut: modShortcut("\\"), command: "editor.split", whenAst: whenIdentifier("editorFocus") },
  {
    shortcut: {
      key: "z",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
    command: "editor.toggleWordWrap",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "editor.closeTab",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("t", { shiftKey: true }),
    command: "editor.reopenClosedTab",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("arrowleft", { altKey: true }),
    command: "editor.focusPreviousWindow",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("arrowright", { altKey: true }),
    command: "editor.focusNextWindow",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: {
      key: "arrowleft",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      modKey: false,
    },
    command: "editor.previousTab",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: {
      key: "arrowright",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      modKey: false,
    },
    command: "editor.nextTab",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("arrowleft", { altKey: true, shiftKey: true }),
    command: "editor.moveTabLeft",
    whenAst: whenIdentifier("editorFocus"),
  },
  {
    shortcut: modShortcut("arrowright", { altKey: true, shiftKey: true }),
    command: "editor.moveTabRight",
    whenAst: whenIdentifier("editorFocus"),
  },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
]);

describe("isTerminalToggleShortcut", () => {
  it("matches Cmd+J on macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
  });

  it("matches Ctrl+J on non-macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ ctrlKey: true }), DEFAULT_BINDINGS, { platform: "Win32" }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("requires terminalFocus for default split/new/close bindings", () => {
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "d", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("matches split/new when terminalFocus is true", () => {
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "d", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });

  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "terminal.new", whenAst: whenIdentifier("true") },
      { shortcut: modShortcut("m"), command: "terminal.new", whenAst: whenIdentifier("false") },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
  });
});

describe("editor workspace shortcuts", () => {
  it("resolves alt+z to word wrap toggle", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "z", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { editorFocus: true },
      }),
      "editor.toggleWordWrap",
    );
  });

  it("resolves F2 to rename when editor focus is active", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "F2" }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { editorFocus: true },
      }),
      "editor.rename",
    );
  });

  it("resolves Cmd+W to close the active editor tab", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { editorFocus: true },
      }),
      "editor.closeTab",
    );
  });

  it("resolves Cmd+Shift+T to reopen the last closed editor tab", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "t", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { editorFocus: true },
      }),
      "editor.reopenClosedTab",
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the effective binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+Shift+\\",
    );
  });

  it("returns effective labels for non-terminal commands", () => {
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⇧⌘O");
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "diff.toggle", "Linux"), "Ctrl+D");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.toggle", "Linux"),
      "Ctrl+B",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.devtools", {
        platform: "MacIntel",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "⇧⌘I",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.duplicateTab", {
        platform: "MacIntel",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "⇧⌘D",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.moveTabLeft", {
        platform: "MacIntel",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "⌥⌘[",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "browser.moveTabRight", {
        platform: "MacIntel",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "⌥⌘]",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.split", {
        platform: "Linux",
        context: { editorFocus: true },
      }),
      "Ctrl+\\",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.focusNextWindow", {
        platform: "MacIntel",
        context: { editorFocus: true },
      }),
      "⌥⌘Right",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.nextTab", {
        platform: "Linux",
        context: { editorFocus: true },
      }),
      "Alt+Shift+Right",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.jump.3", "MacIntel"),
      "⌘3",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.previous", "Linux"),
      "Ctrl+Shift+[",
    );
  });

  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("maps jump commands to visible thread indices", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(2), "thread.jump.3");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.1"), 0);
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.3"), 2);
    assert.isNull(threadJumpIndexFromCommand("thread.next"));
  });

  it("maps traversal commands to directions", () => {
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.previous"), "previous");
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.next"), "next");
    assert.isNull(threadTraversalDirectionFromCommand("thread.jump.1"));
    assert.isNull(threadTraversalDirectionFromCommand(null));
  });

  it("shows jump hints only when configured modifiers match", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      shouldShowThreadJumpHints(event({ metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches chat.new shortcut", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "o", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "o", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches chat.newLocal shortcut", () => {
    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "n", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches diff.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("resolves browser shortcuts with browserOpen context", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "b", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: false, terminalFocus: false },
      }),
      "browser.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.forward",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.reload",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "i", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.devtools",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.duplicateTab",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", ctrlKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.moveTabLeft",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", ctrlKey: true, altKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { browserOpen: true, terminalFocus: false },
      }),
      "browser.moveTabRight",
    );
  });

  it("resolves editor shortcuts only with editorFocus context", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { editorFocus: true },
      }),
      "editor.split",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "ArrowRight", ctrlKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "Linux",
          context: { editorFocus: true },
        },
      ),
      "editor.focusNextWindow",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "ArrowLeft", altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "Linux",
          context: { editorFocus: true },
        },
      ),
      "editor.previousTab",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { editorFocus: false },
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("resolveShortcutCommand", () => {
  it("returns dynamic script commands", () => {
    const keybindings = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
  });

  it("matches bracket shortcuts using the physical key code", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
        },
      ),
      "thread.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "Linux",
        },
      ),
      "thread.next",
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "MacIntel"),
      "⇧⌘D",
    );
  });

  it("formats labels for non-macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "Linux"),
      "Ctrl+Shift+D",
    );
  });

  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L on all platforms", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "Linux"));
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "MacIntel"));
  });

  it("matches Cmd+K on macOS", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "k", metaKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(
      isTerminalClearShortcut(event({ type: "keyup", key: "l", ctrlKey: true }), "Linux"),
    );
  });
});

describe("terminalNavigationShortcutData", () => {
  it("maps Option+Arrow on macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "MacIntel"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "MacIntel"),
      "\u001bf",
    );
  });

  it("maps Cmd+Arrow on macOS to line movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "MacIntel"),
      "\u0001",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", metaKey: true }), "MacIntel"),
      "\u0005",
    );
  });

  it("maps Ctrl+Arrow on non-macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", ctrlKey: true }), "Win32"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", ctrlKey: true }), "Linux"),
      "\u001bf",
    );
  });

  it("rejects unsupported combinations", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ key: "ArrowLeft", shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "Linux"),
    );
    assert.isNull(terminalNavigationShortcutData(event({ key: "a", altKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ type: "keyup", key: "ArrowLeft", altKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "terminal.toggle" }]);
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }),
    );
  });
});
