import path from "node:path";

import {
  CopilotClient,
  type AssistantMessageEvent,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type MessageOptions,
  type ModelInfo,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionEventHandler,
} from "@github/copilot-sdk";
import type {
  GitHubCopilotModelOptions,
  ModelCapabilities,
  ServerProviderModel,
} from "@ace/contracts";
import { normalizeGitHubCopilotModelOptionsWithCapabilities } from "@ace/shared/model";
import { Effect } from "effect";

import { runProcess } from "../processRunner.ts";

const GITHUB_COPILOT_CLI_LOOKUP_TIMEOUT_MS = 10_000;

export interface GitHubCopilotClientConfig {
  readonly cliUrl?: string;
}

export interface GitHubCopilotSessionClient {
  readonly sessionId: string;
  on(handler: SessionEventHandler): () => void;
  disconnect(): Promise<void>;
  send(options: MessageOptions): Promise<string>;
  sendAndWait(
    options: MessageOptions,
    timeout?: number,
  ): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
}

export interface GitHubCopilotClientLike {
  getStatus(): Promise<GetStatusResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  listModels(): Promise<ReadonlyArray<ModelInfo>>;
  createSession(config: SessionConfig): Promise<GitHubCopilotSessionClient>;
  resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<GitHubCopilotSessionClient>;
  stop(): Promise<ReadonlyArray<Error>>;
}

function isExplicitCliPath(binaryPath: string): boolean {
  return path.isAbsolute(binaryPath) || binaryPath.includes("/") || binaryPath.includes("\\");
}

function toReasoningEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return value;
  }
}

export function isGitHubCopilotCliMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lower = error.message.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("copilot cli not found")
  );
}

export async function resolveGitHubCopilotCliPath(binaryPath: string): Promise<string> {
  const trimmedBinaryPath = binaryPath.trim();
  if (trimmedBinaryPath.length === 0) {
    throw new Error("spawn copilot ENOENT");
  }
  if (isExplicitCliPath(trimmedBinaryPath)) {
    return trimmedBinaryPath;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = await runProcess(lookupCommand, [trimmedBinaryPath], {
    allowNonZeroExit: true,
    timeoutMs: GITHUB_COPILOT_CLI_LOOKUP_TIMEOUT_MS,
    outputMode: "truncate",
  });

  const resolvedPath = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (result.timedOut || result.code !== 0 || !resolvedPath) {
    throw new Error(`spawn ${trimmedBinaryPath} ENOENT`);
  }

  return resolvedPath;
}

export async function createGitHubCopilotClient(
  binaryPath: string,
  config?: GitHubCopilotClientConfig,
): Promise<GitHubCopilotClientLike> {
  const configuredCliUrl = config?.cliUrl?.trim();
  const envCliUrl = process.env.ACE_GITHUB_COPILOT_CLI_URL?.trim();
  const cliUrl = configuredCliUrl && configuredCliUrl.length > 0 ? configuredCliUrl : envCliUrl;
  const client =
    cliUrl && cliUrl.length > 0
      ? new CopilotClient({ cliUrl, useStdio: false })
      : new CopilotClient({ cliPath: await resolveGitHubCopilotCliPath(binaryPath) });
  await client.start();
  return client;
}

export function getGitHubCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  return {
    reasoningEffortLevels:
      model.supportedReasoningEfforts?.map((effort) => ({
        value: effort,
        label: toReasoningEffortLabel(effort),
        ...(model.defaultReasoningEffort === effort ? { isDefault: true } : {}),
      })) ?? [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export function toGitHubCopilotServerProviderModel(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: getGitHubCopilotModelCapabilities(model),
  };
}

export function normalizeGitHubCopilotModelOptionsForModel(
  model: ModelInfo | null | undefined,
  options: GitHubCopilotModelOptions | null | undefined,
): GitHubCopilotModelOptions | undefined {
  if (!model) {
    return undefined;
  }
  return normalizeGitHubCopilotModelOptionsWithCapabilities(
    getGitHubCopilotModelCapabilities(model),
    options,
  );
}

export interface GitHubCopilotSdkProbe {
  readonly version: string | null;
  readonly auth: GetAuthStatusResponse | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly issues: ReadonlyArray<string>;
}

export async function probeGitHubCopilotSdk(
  binaryPath: string,
  config?: GitHubCopilotClientConfig,
): Promise<GitHubCopilotSdkProbe> {
  const client = await createGitHubCopilotClient(binaryPath, config);
  try {
    const [statusResult, authResult, modelsResult] = await Promise.allSettled([
      client.getStatus(),
      client.getAuthStatus(),
      client.listModels(),
    ]);

    const issues: string[] = [];
    if (statusResult.status === "rejected") {
      issues.push(
        statusResult.reason instanceof Error
          ? statusResult.reason.message
          : String(statusResult.reason),
      );
    }
    if (authResult.status === "rejected") {
      issues.push(
        authResult.reason instanceof Error ? authResult.reason.message : String(authResult.reason),
      );
    }
    if (modelsResult.status === "rejected") {
      issues.push(
        modelsResult.reason instanceof Error
          ? modelsResult.reason.message
          : String(modelsResult.reason),
      );
    }

    return {
      version: statusResult.status === "fulfilled" ? statusResult.value.version : null,
      auth: authResult.status === "fulfilled" ? authResult.value : null,
      models:
        modelsResult.status === "fulfilled"
          ? modelsResult.value.map(toGitHubCopilotServerProviderModel)
          : [],
      issues,
    };
  } finally {
    await client.stop().catch((cause) =>
      Effect.runPromise(
        Effect.logWarning("Failed to stop GitHub Copilot client.", {
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );
  }
}
