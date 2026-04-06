import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

vi.mock("./acpClient.ts", () => ({
  startAcpClient: vi.fn(() => ({ client: true })),
}));

import { startAcpClient } from "./acpClient.ts";
import { startCursorAcpClient } from "./cursorAcp.ts";

describe("cursorAcp", () => {
  afterEach(() => {
    vi.mocked(startAcpClient).mockReset();
  });

  it("starts ACP with the cursor subcommand and optional model", () => {
    const client = startCursorAcpClient({
      binaryPath: "/opt/bin/cursor-agent",
      model: "gpt-5-mini",
    });

    assert.deepEqual(client, { client: true });
    assert.deepEqual(vi.mocked(startAcpClient).mock.calls[0]?.[0], {
      binaryPath: "/opt/bin/cursor-agent",
      args: ["--model", "gpt-5-mini", "acp"],
      env: {
        NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
      },
    });
  });
});
