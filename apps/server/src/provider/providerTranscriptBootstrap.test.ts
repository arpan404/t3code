import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildBootstrapPromptFromReplayTurns,
  buildTranscriptBootstrapInput,
  cloneReplayTurns,
  transcriptMessagesFromReplayTurns,
} from "./providerTranscriptBootstrap.ts";

describe("providerTranscriptBootstrap", () => {
  it("clones replay turns without preserving nested array references", () => {
    const turns = cloneReplayTurns([
      {
        prompt: "Prompt",
        attachmentNames: ["a.png"],
        assistantResponse: "Reply",
      },
    ]);

    const attachmentNames = turns[0]?.attachmentNames as Array<string> | undefined;
    attachmentNames?.push("b.png");

    assert.deepEqual(turns, [
      {
        prompt: "Prompt",
        attachmentNames: ["a.png", "b.png"],
        assistantResponse: "Reply",
      },
    ]);
  });

  it("converts replay turns into transcript messages", () => {
    assert.deepEqual(
      transcriptMessagesFromReplayTurns([
        {
          prompt: "Prompt",
          attachmentNames: ["a.png", "b.png"],
          assistantResponse: "Reply",
        },
      ]),
      [
        {
          role: "user",
          text: "Prompt",
          attachmentNames: ["a.png", "b.png"],
        },
        {
          role: "assistant",
          text: "Reply",
        },
      ],
    );
  });

  it("truncates older transcript content to fit the prompt budget", () => {
    const result = buildTranscriptBootstrapInput(
      [
        { role: "user", text: "First message" },
        { role: "assistant", text: "First response" },
        {
          role: "user",
          text: "Second message",
          attachmentNames: ["a.png", "b.png", "c.png", "d.png"],
        },
        { role: "assistant", text: "Second response" },
      ],
      "Latest prompt",
      260,
    );

    assert.equal(result.truncated, true);
    assert.equal(result.omittedCount > 0, true);
    assert.match(result.text, /Latest user request \(answer this now\):\nLatest prompt/);
  });

  it("builds a bootstrap prompt directly from replay turns", () => {
    const result = buildBootstrapPromptFromReplayTurns(
      [
        {
          prompt: "Original prompt",
          attachmentNames: ["diagram.png"],
          assistantResponse: "Original answer",
        },
      ],
      "New prompt",
      400,
    );

    assert.equal(result.includedCount, 2);
    assert.match(result.text, /Transcript context:/);
    assert.match(result.text, /Attached file: diagram\.png/);
    assert.match(result.text, /Latest user request \(answer this now\):\nNew prompt/);
  });
});
