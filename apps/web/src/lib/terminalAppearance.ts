export const TERMINAL_ICON_OPTIONS = [
  { id: "terminal", label: "Terminal" },
  { id: "code", label: "Code" },
  { id: "server", label: "Server" },
  { id: "database", label: "Database" },
  { id: "globe", label: "Globe" },
  { id: "wrench", label: "Wrench" },
] as const;

export const TERMINAL_COLOR_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "emerald", label: "Emerald" },
  { id: "amber", label: "Amber" },
  { id: "sky", label: "Sky" },
  { id: "rose", label: "Rose" },
  { id: "violet", label: "Violet" },
] as const;

export type TerminalIconName = (typeof TERMINAL_ICON_OPTIONS)[number]["id"];
export type TerminalColorName = (typeof TERMINAL_COLOR_OPTIONS)[number]["id"];

const TERMINAL_ICON_ID_SET = new Set<TerminalIconName>(
  TERMINAL_ICON_OPTIONS.map((option) => option.id),
);
const TERMINAL_COLOR_ID_SET = new Set<TerminalColorName>(
  TERMINAL_COLOR_OPTIONS.map((option) => option.id),
);

export function normalizeTerminalIconName(
  value: string | null | undefined,
): TerminalIconName | null {
  if (typeof value !== "string") return null;
  return TERMINAL_ICON_ID_SET.has(value as TerminalIconName) ? (value as TerminalIconName) : null;
}

export function normalizeTerminalColorName(
  value: string | null | undefined,
): TerminalColorName | null {
  if (typeof value !== "string") return null;
  return TERMINAL_COLOR_ID_SET.has(value as TerminalColorName)
    ? (value as TerminalColorName)
    : null;
}
