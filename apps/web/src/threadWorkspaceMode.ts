export type ThreadWorkspaceMode = "chat" | "editor";

export function normalizeThreadWorkspaceMode(value: unknown): ThreadWorkspaceMode {
  return value === "editor" ? "editor" : "chat";
}
