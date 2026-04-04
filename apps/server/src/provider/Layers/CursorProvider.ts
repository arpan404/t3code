import type { CursorSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CursorProvider } from "../Services/CursorProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@t3tools/contracts";

const PROVIDER = "cursor" as const;
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "composer-2-fast",
    name: "Composer 2 Fast",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 Mini",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "claude-4-sonnet",
    name: "Sonnet 4",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "claude-4-sonnet-thinking",
    name: "Sonnet 4 Thinking",
    isCustom: false,
    capabilities: null,
  },
];

function parseCursorVersion(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string | null {
  return (
    nonEmptyTrimmed(result.stdout.split("\n").find((line) => line.trim().length > 0)) ??
    nonEmptyTrimmed(result.stderr.split("\n").find((line) => line.trim().length > 0)) ??
    null
  );
}

function parseCursorAuthStatus(output: string): {
  readonly status: "ready" | "error" | "warning";
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const normalized = output.toLowerCase();
  if (normalized.includes("user email") && normalized.includes("not logged in")) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
    };
  }

  const emailMatch = output.match(/User Email\s+(.+)/i);
  const email = emailMatch?.[1]?.trim();
  if (email && !/^not logged in$/i.test(email)) {
    return {
      status: "ready",
      auth: { status: "authenticated", label: email },
    };
  }

  return {
    status: "warning",
    auth: { status: "unknown" },
    message: "Could not determine Cursor Agent authentication status.",
  };
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function parseCursorModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const rawLine of stripAnsi(output).split("\n")) {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex <= 0) {
      continue;
    }

    const slug = nonEmptyTrimmed(line.slice(0, separatorIndex));
    const name = nonEmptyTrimmed(
      line
        .slice(separatorIndex + 3)
        .replace(/\s+\((?:default|current)\)/gi, "")
        .replace(/\s+/g, " "),
    );
    if (!slug || !name || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: null,
    });
  }

  return models;
}

const runCursorCommand = Effect.fn("runCursorCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const cursorSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.cursor),
  );
  const command = ChildProcess.make(cursorSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER ?? "1",
    },
  });
  return yield* spawnAndCollect(cursorSettings.binaryPath, command);
});

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const settingsService = yield* ServerSettingsService;
    const cursorSettings = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.cursor),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = providerModelsFromSettings(
      FALLBACK_MODELS,
      PROVIDER,
      cursorSettings.customModels,
    );

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor Agent is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCursorCommand(["--version"]).pipe(Effect.result);
    if (Result.isFailure(versionResult)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(versionResult.failure),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(versionResult.failure)
            ? "Cursor Agent (`cursor-agent`) is not installed or not on PATH."
            : `Failed to run Cursor Agent: ${versionResult.failure instanceof Error ? versionResult.failure.message : String(versionResult.failure)}.`,
        },
      });
    }

    const modelsResult = yield* runCursorCommand(["models"]).pipe(Effect.result);
    const discoveredModels = Result.isSuccess(modelsResult)
      ? parseCursorModelsOutput(`${modelsResult.success.stdout}\n${modelsResult.success.stderr}`)
      : [];
    const models = providerModelsFromSettings(
      discoveredModels.length > 0 ? discoveredModels : FALLBACK_MODELS,
      PROVIDER,
      cursorSettings.customModels,
    );

    const aboutResult = yield* runCursorCommand(["about"]).pipe(Effect.result);
    if (Result.isFailure(aboutResult)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parseCursorVersion(versionResult.success),
          status: "warning",
          auth: { status: "unknown" },
          message:
            aboutResult.failure instanceof Error
              ? aboutResult.failure.message
              : "Failed to inspect Cursor Agent status.",
        },
      });
    }

    const auth = parseCursorAuthStatus(
      `${aboutResult.success.stdout}\n${aboutResult.success.stderr}`,
    );

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parseCursorVersion(versionResult.success),
        status: auth.status,
        auth: auth.auth,
        ...(auth.message ? { message: auth.message } : {}),
      },
    });
  },
);

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settingsCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(1),
      lookup: () =>
        settingsService.getSettings.pipe(Effect.map((settings) => settings.providers.cursor)),
    });

    const checkProvider = checkCursorProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, settingsService),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );

    return yield* makeManagedServerProvider<CursorSettings>({
      getSettings: Cache.get(settingsCache, "settings" as const).pipe(Effect.orDie),
      streamSettings: settingsService.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursor),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      refreshInterval: "60 seconds",
    });
  }),
);
