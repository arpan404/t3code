import type {
  CodexReasoningEffort,
  CursorModelMetadata,
  CursorModelOptions,
  CursorSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerSettingsError,
} from "@t3tools/contracts";
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

const PROVIDER = "cursor" as const;
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const EMPTY_CURSOR_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};
const CURSOR_REASONING_VARIANTS: ReadonlyArray<{
  readonly value: CodexReasoningEffort;
  readonly slugSuffix: string;
  readonly nameSuffixPattern: RegExp;
  readonly label: string;
}> = [
  {
    value: "xhigh",
    slugSuffix: "-xhigh",
    nameSuffixPattern: /\s+extra high$/i,
    label: "Extra High",
  },
  {
    value: "high",
    slugSuffix: "-high",
    nameSuffixPattern: /\s+high$/i,
    label: "High",
  },
  {
    value: "medium",
    slugSuffix: "-medium",
    nameSuffixPattern: /\s+medium$/i,
    label: "Medium",
  },
  {
    value: "low",
    slugSuffix: "-low",
    nameSuffixPattern: /\s+low$/i,
    label: "Low",
  },
] as const;
const CURSOR_REASONING_ORDER: ReadonlyArray<CodexReasoningEffort> = [
  "xhigh",
  "high",
  "medium",
  "low",
];
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "composer-2",
    name: "Composer 2",
    isCustom: false,
    capabilities: {
      ...EMPTY_CURSOR_CAPABILITIES,
      supportsFastMode: true,
    },
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

type ParsedCursorVariant = {
  readonly rawModel: ServerProviderModel;
  readonly familySlug: string;
  readonly familyName: string;
  readonly reasoningEffort: CodexReasoningEffort | null;
  readonly fastMode: boolean;
  readonly thinking: boolean;
  readonly maxMode: boolean;
};

function parseRawCursorModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
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

function parseCursorVariant(model: ServerProviderModel): ParsedCursorVariant {
  let familySlug = model.slug;
  let familyName = model.name;
  let fastMode = false;
  let thinking = false;
  let maxMode = false;

  if (familySlug.endsWith("-fast")) {
    fastMode = true;
    familySlug = familySlug.slice(0, -"-fast".length);
    familyName = familyName.replace(/\s+fast$/i, "").trim();
  }

  if (familySlug.endsWith("-thinking")) {
    thinking = true;
    familySlug = familySlug.slice(0, -"-thinking".length);
    familyName = familyName.replace(/\s+thinking$/i, "").trim();
  }

  let reasoningEffort: CodexReasoningEffort | null = null;
  if (familySlug.endsWith("-none")) {
    reasoningEffort = "medium";
    familySlug = familySlug.slice(0, -"-none".length);
    familyName = familyName.replace(/\s+none$/i, "").trim();
  }
  for (const variant of CURSOR_REASONING_VARIANTS) {
    if (!familySlug.endsWith(variant.slugSuffix)) {
      continue;
    }
    reasoningEffort = variant.value;
    familySlug = familySlug.slice(0, -variant.slugSuffix.length);
    familyName = familyName.replace(variant.nameSuffixPattern, "").trim();
    break;
  }

  if (familySlug.endsWith("-max")) {
    maxMode = true;
    familySlug = familySlug.slice(0, -"-max".length);
    familyName = familyName.replace(/\s+max$/i, "").trim();
  }

  return {
    rawModel: model,
    familySlug,
    familyName: familyName || model.name,
    reasoningEffort,
    fastMode,
    thinking,
    maxMode,
  };
}

function buildCursorFamilyCapabilities(
  variants: ReadonlyArray<ParsedCursorVariant>,
): ModelCapabilities | null {
  const supportsFastMode = new Set(variants.map((variant) => variant.fastMode)).size > 1;
  const supportsThinkingToggle = new Set(variants.map((variant) => variant.thinking)).size > 1;
  const discoveredEffortLevels = new Set<CodexReasoningEffort>();
  const hasExplicitEffortVariants = variants.some((variant) => variant.reasoningEffort !== null);
  const supportsBaseEffort =
    (hasExplicitEffortVariants && variants.some((variant) => variant.reasoningEffort === null)) ||
    variants.some((variant) => variant.reasoningEffort === "medium");

  for (const variant of variants) {
    if (variant.reasoningEffort) {
      discoveredEffortLevels.add(variant.reasoningEffort);
    }
  }
  if (supportsBaseEffort) {
    discoveredEffortLevels.add("medium");
  }

  if (!supportsFastMode && !supportsThinkingToggle && discoveredEffortLevels.size === 0) {
    return null;
  }

  const defaultReasoningEffort = supportsBaseEffort
    ? ("medium" as const)
    : (CURSOR_REASONING_ORDER.toReversed().find((value) => discoveredEffortLevels.has(value)) ??
      null);

  return {
    ...EMPTY_CURSOR_CAPABILITIES,
    reasoningEffortLevels: CURSOR_REASONING_ORDER.filter((value) =>
      discoveredEffortLevels.has(value),
    ).map((value) => {
      const effortLevel = {
        value,
        label: CURSOR_REASONING_VARIANTS.find((variant) => variant.value === value)?.label ?? value,
        isDefault: false,
      };
      if (value === defaultReasoningEffort) {
        effortLevel.isDefault = true;
      }
      return effortLevel;
    }),
    supportsFastMode,
    supportsThinkingToggle,
  };
}

function cursorMetadataFromVariant(variant: ParsedCursorVariant): CursorModelMetadata {
  return {
    familySlug: variant.familySlug,
    familyName: variant.familyName,
    ...(variant.reasoningEffort ? { reasoningEffort: variant.reasoningEffort } : {}),
    fastMode: variant.fastMode,
    thinking: variant.thinking,
    maxMode: variant.maxMode,
  };
}

function buildCursorProviderModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const variantsByFamilySlug = new Map<string, ParsedCursorVariant[]>();
  const parsedVariants = models.map((model) => {
    const parsed = parseCursorVariant(model);
    const group = variantsByFamilySlug.get(parsed.familySlug);
    if (group) {
      group.push(parsed);
    } else {
      variantsByFamilySlug.set(parsed.familySlug, [parsed]);
    }
    return parsed;
  });

  return parsedVariants.map((parsed) => {
    const groupedVariants = variantsByFamilySlug.get(parsed.familySlug) ?? [parsed];
    return Object.assign({}, parsed.rawModel, {
      capabilities: buildCursorFamilyCapabilities(groupedVariants),
      cursorMetadata: cursorMetadataFromVariant(parsed),
    });
  });
}

export function parseCursorModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  return buildCursorProviderModels(parseRawCursorModelsOutput(output));
}

export function resolveCursorCliModelId(input: {
  readonly model: string;
  readonly options?: CursorModelOptions | null | undefined;
}): string {
  let slug = input.model.trim();
  if (!slug) {
    return input.model;
  }

  const requestedFastMode = input.options?.fastMode === true;
  const requestedEffort = input.options?.reasoningEffort;
  if (!requestedFastMode && !requestedEffort) {
    return slug;
  }

  if (slug.endsWith("-fast")) {
    slug = slug.slice(0, -"-fast".length);
  }
  if (slug.endsWith("-none")) {
    slug = slug.slice(0, -"-none".length);
  }
  for (const variant of CURSOR_REASONING_VARIANTS) {
    if (!slug.endsWith(variant.slugSuffix)) {
      continue;
    }
    slug = slug.slice(0, -variant.slugSuffix.length);
    break;
  }

  if (requestedEffort && requestedEffort !== "medium") {
    slug = `${slug}${requestedEffort === "xhigh" ? "-xhigh" : `-${requestedEffort}`}`;
  }
  if (requestedFastMode) {
    slug = `${slug}-fast`;
  }

  return slug;
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
