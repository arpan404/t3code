import type { MenuItemConstructorOptions } from "electron";

type EditableContextMenuParams = {
  dictionarySuggestions: readonly string[];
  editFlags: {
    canCopy: boolean;
    canCut: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
  misspelledWord: string;
};

interface BuildWebContentsContextMenuOptions {
  onCopyLink?: () => void;
  onOpenLink?: () => void;
  onReplaceMisspelling: (suggestion: string) => void;
}

export function buildWebContentsContextMenuTemplate(
  params: EditableContextMenuParams,
  options: BuildWebContentsContextMenuOptions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (options.onOpenLink) {
    template.push({
      label: "Open Link Externally",
      click: options.onOpenLink,
    });
  }
  if (options.onCopyLink) {
    template.push({
      label: "Copy Link Address",
      click: options.onCopyLink,
    });
  }
  if (template.length > 0) {
    template.push({ type: "separator" });
  }

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({
        label: suggestion,
        click: () => options.onReplaceMisspelling(suggestion),
      });
    }
    if (params.dictionarySuggestions.length === 0) {
      template.push({ label: "No suggestions", enabled: false });
    }
    template.push({ type: "separator" });
  }

  template.push(
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );

  return template;
}