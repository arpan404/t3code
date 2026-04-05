import { Cause, Effect } from "effect";

type RunPromise = <A>(effect: Effect.Effect<A, never, never>) => Promise<A>;

export function runLoggedEffect<A, E>(options: {
  readonly runPromise: RunPromise;
  readonly effect: Effect.Effect<A, E, never>;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}): void {
  void options.runPromise(
    options.effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(options.message, {
          ...options.metadata,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.asVoid,
    ),
  );
}

export function logWarningEffect(options: {
  readonly runPromise: RunPromise;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}): void {
  void options.runPromise(
    Effect.logWarning(options.message, options.metadata ?? {}).pipe(Effect.asVoid),
  );
}
