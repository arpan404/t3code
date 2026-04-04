/**
 * RoutingTextGeneration – Dispatches text generation requests to the provider-
 * specific implementation selected in each request input.
 *
 * Each supported provider gets its own dedicated text-generation backend so the
 * Git/title flows use the same provider the user selected.
 *
 * @module RoutingTextGeneration
 */
import type { ModelSelection, ProviderKind } from "@t3tools/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
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

class CursorTextGen extends ServiceMap.Service<CursorTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

const toTextGenerationProvider = (provider: ProviderKind): TextGenerationProvider => provider;

type TextGenerationModelSelection = Extract<ModelSelection, { provider: TextGenerationProvider }>;

export function normalizeTextGenerationModelSelection(
  selection: ModelSelection,
): TextGenerationModelSelection {
  return selection;
}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const gitHubCopilot = yield* GitHubCopilotTextGen;
  const cursor = yield* CursorTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent"
      ? claude
      : provider === "githubCopilot"
        ? gitHubCopilot
        : provider === "cursor"
          ? cursor
          : codex;

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

const InternalCursorLayer = Layer.effect(
  CursorTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CursorTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalGitHubCopilotLayer),
  Layer.provide(InternalCursorLayer),
);
