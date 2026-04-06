import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import {
  describeCursorAdapterCause,
  findKnownCursorAdapterError,
  isMissingCursorSessionError,
} from "./CursorAdapterErrors.ts";

describe("CursorAdapterErrors", () => {
  it("finds known adapter errors through nested causes", () => {
    const known = new ProviderAdapterRequestError({
      provider: "cursor",
      method: "session/load",
      detail: "Session not found: dead-session",
    });

    const nested = new Error("outer wrapper", {
      cause: new Error("An error occurred in Effect.tryPromise", { cause: known }),
    });

    assert.strictEqual(findKnownCursorAdapterError(nested), known);
  });

  it("describes the first meaningful error message in a cause chain", () => {
    const cause = new Error("An error occurred in Effect.try", {
      cause: new ProviderAdapterProcessError({
        provider: "cursor",
        threadId: "thread-1",
        detail: "cursor-agent exited unexpectedly",
      }),
    });

    assert.equal(
      describeCursorAdapterCause(cause),
      "Provider adapter process error (cursor) for thread thread-1: cursor-agent exited unexpectedly",
    );
  });

  it("detects missing remote session errors from request failures and plain messages, but excludes local adapter thread misses", () => {
    const missingAdapterThreadError = new ProviderAdapterSessionNotFoundError({
      provider: "cursor",
      threadId: "thread-404",
    });
    const missingRequestError = new ProviderAdapterRequestError({
      provider: "cursor",
      method: "session/load",
      detail: "Session not found: abc123",
    });

    assert.equal(isMissingCursorSessionError(missingAdapterThreadError), false);
    assert.equal(isMissingCursorSessionError(missingRequestError), true);
    assert.equal(
      isMissingCursorSessionError(new Error("Request failed: Session not found: abc123")),
      true,
    );
    assert.equal(isMissingCursorSessionError(new Error("Unknown session handle")), true);
    assert.equal(isMissingCursorSessionError(new Error("permission denied")), false);
  });
});
