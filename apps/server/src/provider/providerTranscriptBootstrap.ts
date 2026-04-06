import { type ProviderReplayTurn } from "@t3tools/contracts";

export interface TranscriptBootstrapMessage {
  readonly role: "user" | "assistant";
  readonly text?: string;
  readonly attachmentNames?: ReadonlyArray<string>;
}

export type TranscriptReplayTurn = ProviderReplayTurn;

export interface TranscriptBootstrapResult {
  readonly text: string;
  readonly includedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

export function cloneReplayTurns(
  turns: ReadonlyArray<TranscriptReplayTurn> | undefined,
): Array<TranscriptReplayTurn> {
  return (turns ?? []).map((turn) =>
    turn.assistantResponse !== undefined
      ? {
          prompt: turn.prompt,
          attachmentNames: [...turn.attachmentNames],
          assistantResponse: turn.assistantResponse,
        }
      : {
          prompt: turn.prompt,
          attachmentNames: [...turn.attachmentNames],
        },
  );
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function attachmentSummary(message: TranscriptBootstrapMessage): string | null {
  const attachmentNames = message.attachmentNames?.filter((name) => name.trim().length > 0) ?? [];
  if (attachmentNames.length === 0) {
    return null;
  }

  const visibleNames = attachmentNames.slice(0, 3);
  const extraCount = attachmentNames.length - visibleNames.length;
  return `[Attached file${attachmentNames.length === 1 ? "" : "s"}: ${visibleNames.join(", ")}${extraCount > 0 ? ` (+${extraCount} more)` : ""}]`;
}

function buildMessageBlock(message: TranscriptBootstrapMessage): string {
  const label = message.role === "assistant" ? "ASSISTANT" : "USER";
  const text = message.text?.trim();
  const attachments = attachmentSummary(message);

  if (text && attachments) {
    return `${label}:\n${text}\n${attachments}`;
  }
  if (text) {
    return `${label}:\n${text}`;
  }
  if (attachments) {
    return `${label}:\n${attachments}`;
  }
  return `${label}:\n(empty message)`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

export function transcriptMessagesFromReplayTurns(
  turns: ReadonlyArray<TranscriptReplayTurn>,
): ReadonlyArray<TranscriptBootstrapMessage> {
  const messages: Array<TranscriptBootstrapMessage> = [];
  for (const turn of turns) {
    messages.push({
      role: "user",
      text: turn.prompt,
      attachmentNames: turn.attachmentNames,
    });
    const assistantResponse = turn.assistantResponse;
    if (typeof assistantResponse === "string" && assistantResponse.trim().length > 0) {
      messages.push({
        role: "assistant",
        text: assistantResponse,
      });
    }
  }
  return messages;
}

export function buildTranscriptBootstrapInput(
  previousMessages: ReadonlyArray<TranscriptBootstrapMessage>,
  latestPrompt: string,
  maxChars: number,
): TranscriptBootstrapResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly = latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }

  const newestFirstBlocks: string[] = [];
  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const message = previousMessages[index];
    if (!message) {
      continue;
    }
    newestFirstBlocks.push(buildMessageBlock(message));
  }

  if (newestFirstBlocks.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  let includedNewestFirst: string[] = [];
  for (const block of newestFirstBlocks) {
    const nextNewestFirst = [...includedNewestFirst, block];
    const nextChronological = nextNewestFirst.toReversed();
    const omittedCount = newestFirstBlocks.length - nextChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? `${OMITTED_SUMMARY(omittedCount)}\n\n${nextChronological.join("\n\n")}`
        : nextChronological.join("\n\n");
    if (!finalizeWithPrompt(transcriptBody, latestPrompt, budget)) {
      break;
    }
    includedNewestFirst = nextNewestFirst;
  }

  let includedChronological = includedNewestFirst.toReversed();
  while (true) {
    const omittedCount = newestFirstBlocks.length - includedChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? includedChronological.length > 0
          ? `${OMITTED_SUMMARY(omittedCount)}\n\n${includedChronological.join("\n\n")}`
          : OMITTED_SUMMARY(omittedCount)
        : includedChronological.join("\n\n");
    const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
    if (finalized) {
      return {
        text: finalized,
        includedCount: includedChronological.length,
        omittedCount,
        truncated: omittedCount > 0 || latestPrompt.length !== promptOnly.length,
      };
    }

    if (includedChronological.length === 0) {
      return {
        text: promptOnly,
        includedCount: 0,
        omittedCount: previousMessages.length,
        truncated: true,
      };
    }

    includedChronological = includedChronological.slice(1);
  }
}

export function buildBootstrapPromptFromReplayTurns(
  turns: ReadonlyArray<TranscriptReplayTurn>,
  latestPrompt: string,
  maxChars: number,
): TranscriptBootstrapResult {
  return buildTranscriptBootstrapInput(
    transcriptMessagesFromReplayTurns(turns),
    latestPrompt,
    maxChars,
  );
}
