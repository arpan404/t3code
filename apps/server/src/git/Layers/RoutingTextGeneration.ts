/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` or `"githubCopilot"` the
 * request is forwarded to that provider's text-generation layer. Unsupported
 * providers fall back to Codex with Codex's default git-text model so the
 * downstream implementation always receives a valid selection.
 *
 * @module RoutingTextGeneration
 */
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
} from "@t3tools/contracts";
import { buildProviderModelSelection } from "@t3tools/shared/model";
import { Effect, Layer, ServiceMap } from "effect";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { GitHubCopilotTextGenerationLive } from "./GitHubCopilotTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class GitHubCopilotTextGen extends ServiceMap.Service<GitHubCopilotTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/GitHubCopilotTextGen",
) {}

const toTextGenerationProvider = (provider: ProviderKind): TextGenerationProvider | undefined =>
  provider === "claudeAgent" || provider === "githubCopilot" || provider === "codex"
    ? provider
    : undefined;

type TextGenerationModelSelection = Extract<ModelSelection, { provider: TextGenerationProvider }>;

export function normalizeTextGenerationModelSelection(
  selection: ModelSelection,
): TextGenerationModelSelection {
  switch (selection.provider) {
    case "codex":
    case "claudeAgent":
    case "githubCopilot":
      return selection;
    case "cursor":
      return buildProviderModelSelection(
        "codex",
        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      );
  }
}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const gitHubCopilot = yield* GitHubCopilotTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : provider === "githubCopilot" ? gitHubCopilot : codex;

  return {
    generateCommitMessage: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateCommitMessage({
        ...input,
        modelSelection,
      });
    },
    generatePrContent: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generatePrContent({
        ...input,
        modelSelection,
      });
    },
    generateBranchName: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateBranchName({
        ...input,
        modelSelection,
      });
    },
    generateThreadTitle: (input) => {
      const modelSelection = normalizeTextGenerationModelSelection(input.modelSelection);
      return route(toTextGenerationProvider(modelSelection.provider)).generateThreadTitle({
        ...input,
        modelSelection,
      });
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

const InternalGitHubCopilotLayer = Layer.effect(
  GitHubCopilotTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(GitHubCopilotTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalGitHubCopilotLayer),
);
