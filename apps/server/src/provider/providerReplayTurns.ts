import { type ProviderReplayTurn } from "@t3tools/contracts";

import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";

type MutableReplayTurn = {
  prompt: string;
  attachmentNames: Array<string>;
  assistantParts: Array<string>;
};

function uniqueAttachmentNames(message: ProjectionThreadMessage): Array<string> {
  const seen = new Set<string>();
  const names: Array<string> = [];
  for (const attachment of message.attachments ?? []) {
    const normalized = attachment.name.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    names.push(normalized);
  }
  return names;
}

function finalizeReplayTurn(
  turn: MutableReplayTurn | null,
  replayTurns: Array<ProviderReplayTurn>,
): void {
  if (!turn) {
    return;
  }

  const prompt = turn.prompt.trim();
  if (prompt.length === 0 && turn.attachmentNames.length === 0) {
    return;
  }

  const assistantResponse = turn.assistantParts.join("\n\n").trim();
  replayTurns.push(
    assistantResponse.length > 0
      ? {
          prompt,
          attachmentNames: [...turn.attachmentNames],
          assistantResponse,
        }
      : {
          prompt,
          attachmentNames: [...turn.attachmentNames],
        },
  );
}

export function projectionMessagesToReplayTurns(
  messages: ReadonlyArray<ProjectionThreadMessage>,
): ReadonlyArray<ProviderReplayTurn> {
  const replayTurns: Array<ProviderReplayTurn> = [];
  let currentTurn: MutableReplayTurn | null = null;

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      finalizeReplayTurn(currentTurn, replayTurns);
      currentTurn = {
        prompt: message.text,
        attachmentNames: uniqueAttachmentNames(message),
        assistantParts: [],
      };
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    const assistantText = message.text.trim();
    if (assistantText.length > 0) {
      currentTurn.assistantParts.push(assistantText);
    }
  }

  finalizeReplayTurn(currentTurn, replayTurns);
  return replayTurns;
}
