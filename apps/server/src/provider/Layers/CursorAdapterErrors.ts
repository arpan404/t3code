import { Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";

export const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
export const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
export const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
export const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);

function nextCause(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || !("cause" in value)) {
    return undefined;
  }
  const cause = (value as { readonly cause?: unknown }).cause;
  return cause === value ? undefined : cause;
}

function causeChain(cause: unknown): ReadonlyArray<unknown> {
  const chain: Array<unknown> = [];
  let current: unknown = cause;
  let depth = 0;
  while (current !== undefined && depth < 8) {
    chain.push(current);
    current = nextCause(current);
    depth += 1;
  }
  return chain;
}

export function findKnownCursorAdapterError(
  cause: unknown,
):
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError
  | undefined {
  for (const candidate of causeChain(cause)) {
    if (
      isProviderAdapterValidationError(candidate) ||
      isProviderAdapterSessionNotFoundError(candidate) ||
      isProviderAdapterRequestError(candidate) ||
      isProviderAdapterProcessError(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

export function describeCursorAdapterCause(cause: unknown): string {
  for (const candidate of causeChain(cause)) {
    if (!(candidate instanceof Error)) {
      continue;
    }
    if (
      candidate.message !== "An error occurred in Effect.try" &&
      candidate.message !== "An error occurred in Effect.tryPromise"
    ) {
      return candidate.message;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function isMissingCursorSessionError(cause: unknown): boolean {
  const message = describeCursorAdapterCause(cause).toLowerCase();
  return (
    message.includes("session not found") ||
    message.includes("unknown session") ||
    (message.includes("not found") && message.includes("session"))
  );
}
