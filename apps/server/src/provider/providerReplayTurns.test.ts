import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { projectionMessagesToReplayTurns } from "./providerReplayTurns.ts";

describe("projectionMessagesToReplayTurns", () => {
  it("groups user prompts with subsequent assistant responses and unique attachment names", () => {
    const turns = projectionMessagesToReplayTurns([
      {
        role: "system",
        text: "ignore me",
      },
      {
        role: "user",
        text: "First prompt",
        attachments: [{ name: "diagram.png" }, { name: "diagram.png" }, { name: "notes.md" }],
      },
      {
        role: "assistant",
        text: "First reply",
      },
      {
        role: "assistant",
        text: "Additional reply",
      },
      {
        role: "user",
        text: "Second prompt",
        attachments: [],
      },
    ] as never);

    assert.deepEqual(turns, [
      {
        prompt: "First prompt",
        attachmentNames: ["diagram.png", "notes.md"],
        assistantResponse: "First reply\n\nAdditional reply",
      },
      {
        prompt: "Second prompt",
        attachmentNames: [],
      },
    ]);
  });

  it("ignores assistant messages before the first user turn", () => {
    const turns = projectionMessagesToReplayTurns([
      { role: "assistant", text: "orphan" },
      { role: "user", text: "Prompt", attachments: [] },
      { role: "assistant", text: "Reply" },
    ] as never);

    assert.deepEqual(turns, [
      {
        prompt: "Prompt",
        attachmentNames: [],
        assistantResponse: "Reply",
      },
    ]);
  });
});
