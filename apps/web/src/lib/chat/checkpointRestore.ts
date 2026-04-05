import { type ProviderKind } from "@ace/contracts";

export const TRANSCRIPT_REBUILD_PROVIDERS = new Set<ProviderKind>([
  "githubCopilot",
  "cursor",
  "gemini",
  "opencode",
]);

export function usesTranscriptRebuildRestore(provider: ProviderKind | null | undefined): boolean {
  return provider !== null && provider !== undefined && TRANSCRIPT_REBUILD_PROVIDERS.has(provider);
}

export function buildCheckpointRestoreConfirmation(
  provider: ProviderKind | null | undefined,
  turnCount: number,
): string {
  if (usesTranscriptRebuildRestore(provider)) {
    return [
      `Restore this thread to checkpoint ${turnCount}?`,
      "This will discard newer messages and turn diffs in this thread.",
      "Files will be restored to that checkpoint, and the next provider turn will rebuild context from the saved transcript instead of rewinding remote history.",
      "This action cannot be undone.",
    ].join("\n");
  }

  return [
    `Revert this thread to checkpoint ${turnCount}?`,
    "This will discard newer messages and turn diffs in this thread.",
    "This action cannot be undone.",
  ].join("\n");
}

export function checkpointRestoreActionTitle(provider: ProviderKind | null | undefined): string {
  return usesTranscriptRebuildRestore(provider)
    ? "Restore files and rebuild from this message"
    : "Revert to this message";
}

export function checkpointRestoreFailureMessage(provider: ProviderKind | null | undefined): string {
  return usesTranscriptRebuildRestore(provider)
    ? "Failed to restore thread state."
    : "Failed to revert thread state.";
}
