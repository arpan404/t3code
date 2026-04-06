import type {
  CursorModelMetadata,
  CursorModelOptions,
  ServerProviderModel,
} from "@t3tools/contracts";

export type CursorSelectorFamily = {
  readonly familySlug: string;
  readonly familyName: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly reasoningEffortOptions: ReadonlyArray<CursorSelectorReasoningEffort>;
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
  readonly supportsMaxMode: boolean;
};

export type CursorSelectorReasoningEffort =
  | NonNullable<CursorModelOptions["reasoningEffort"]>
  | "medium";

const CURSOR_REASONING_ORDER: ReadonlyArray<CursorSelectorReasoningEffort> = [
  "low",
  "medium",
  "high",
  "xhigh",
];

type CursorFacetKey = "reasoningEffort" | "fastMode" | "thinking" | "maxMode";

type DesiredCursorTraits = {
  readonly reasoningEffort?: CursorSelectorReasoningEffort | null;
  readonly fastMode?: boolean;
  readonly thinking?: boolean;
  readonly maxMode?: boolean;
};

type NormalizedCursorMetadata = {
  readonly familySlug: string;
  readonly familyName: string;
  readonly reasoningEffort: CursorSelectorReasoningEffort | null;
  readonly fastMode: boolean;
  readonly thinking: boolean;
  readonly maxMode: boolean;
};

function readCursorMetadata(model: ServerProviderModel): NormalizedCursorMetadata | null {
  const metadata = model.cursorMetadata;
  if (!metadata) {
    return null;
  }
  return {
    familySlug: metadata.familySlug,
    familyName: metadata.familyName,
    reasoningEffort: metadata.reasoningEffort ?? null,
    fastMode: metadata.fastMode === true,
    thinking: metadata.thinking === true,
    maxMode: metadata.maxMode === true,
  };
}

function normalizedReasoningEffort(
  metadata: NormalizedCursorMetadata,
  family: CursorSelectorFamily,
): CursorSelectorReasoningEffort | null {
  if (metadata.reasoningEffort) {
    return metadata.reasoningEffort;
  }
  return family.reasoningEffortOptions.length > 0 ? "medium" : null;
}

function sortFamilies(
  families: ReadonlyArray<CursorSelectorFamily>,
  sourceModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<CursorSelectorFamily> {
  const order = new Map(sourceModels.map((model, index) => [model.slug, index]));
  return [...families].toSorted(
    (left, right) =>
      (order.get(left.models[0]?.slug ?? left.familySlug) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.models[0]?.slug ?? right.familySlug) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function buildCursorSelectorFamilies(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<CursorSelectorFamily> {
  const grouped = new Map<string, Array<ServerProviderModel>>();
  for (const model of models) {
    const metadata = readCursorMetadata(model);
    const familySlug = metadata?.familySlug ?? model.slug;
    const group = grouped.get(familySlug);
    if (group) {
      group.push(model);
    } else {
      grouped.set(familySlug, [model]);
    }
  }

  const families = [...grouped.entries()].map(([familySlug, familyModels]) => {
    const firstMetadata = readCursorMetadata(familyModels[0]!);
    const reasoningEfforts = new Set<CursorSelectorReasoningEffort>();
    const fastValues = new Set<boolean>();
    const thinkingValues = new Set<boolean>();
    const maxValues = new Set<boolean>();

    for (const model of familyModels) {
      const metadata = readCursorMetadata(model);
      if (!metadata) {
        continue;
      }
      if (metadata.reasoningEffort) {
        reasoningEfforts.add(metadata.reasoningEffort);
      } else if (familyModels.some((candidate) => readCursorMetadata(candidate)?.reasoningEffort)) {
        reasoningEfforts.add("medium");
      }
      fastValues.add(metadata.fastMode);
      thinkingValues.add(metadata.thinking);
      maxValues.add(metadata.maxMode);
    }

    return {
      familySlug,
      familyName: firstMetadata?.familyName ?? familyModels[0]?.name ?? familySlug,
      models: familyModels,
      reasoningEffortOptions: CURSOR_REASONING_ORDER.filter((value) => reasoningEfforts.has(value)),
      supportsFastMode: fastValues.size > 1,
      supportsThinkingToggle: thinkingValues.size > 1,
      supportsMaxMode: maxValues.size > 1,
    } satisfies CursorSelectorFamily;
  });

  return sortFamilies(families, models);
}

function fallbackScore(
  metadata: NormalizedCursorMetadata | null,
  family: CursorSelectorFamily,
): number {
  if (!metadata) {
    return 0;
  }
  let score = 0;
  if (normalizedReasoningEffort(metadata, family) === "medium") {
    score += 4;
  }
  if (!metadata.fastMode) {
    score += 2;
  }
  if (!metadata.thinking) {
    score += 2;
  }
  if (!metadata.maxMode) {
    score += 2;
  }
  return score;
}

function pickCursorModelForFamily(input: {
  readonly family: CursorSelectorFamily;
  readonly desired: DesiredCursorTraits;
}): ServerProviderModel | null {
  let best:
    | {
        readonly model: ServerProviderModel;
        readonly score: number;
      }
    | undefined;

  for (const model of input.family.models) {
    const metadata = readCursorMetadata(model);
    let score = fallbackScore(metadata, input.family);
    const reasoningEffort = metadata ? normalizedReasoningEffort(metadata, input.family) : null;
    if (input.desired.reasoningEffort !== undefined) {
      if (reasoningEffort !== input.desired.reasoningEffort) {
        continue;
      }
      score += 12;
    }
    if (input.desired.fastMode !== undefined) {
      if ((metadata?.fastMode ?? false) !== input.desired.fastMode) {
        continue;
      }
      score += 8;
    }
    if (input.desired.thinking !== undefined) {
      if ((metadata?.thinking ?? false) !== input.desired.thinking) {
        continue;
      }
      score += 8;
    }
    if (input.desired.maxMode !== undefined) {
      if ((metadata?.maxMode ?? false) !== input.desired.maxMode) {
        continue;
      }
      score += 8;
    }
    if (!best || score > best.score) {
      best = { model, score };
    }
  }

  return best?.model ?? input.family.models[0] ?? null;
}

function findFamilyByModel(
  families: ReadonlyArray<CursorSelectorFamily>,
  model: string | null | undefined,
): CursorSelectorFamily | null {
  if (!model) {
    return families[0] ?? null;
  }
  return (
    families.find((family) => family.models.some((candidate) => candidate.slug === model)) ??
    families.find((family) => family.familySlug === model) ??
    null
  );
}

export function resolveExactCursorModelSelection(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly model: string | null | undefined;
  readonly options?: CursorModelOptions | null | undefined;
}): string | null {
  const direct = input.models.find((candidate) => candidate.slug === input.model);
  if (direct) {
    return direct.slug;
  }
  const families = buildCursorSelectorFamilies(input.models);
  const family = findFamilyByModel(families, input.model);
  if (!family) {
    return null;
  }
  return (
    pickCursorModelForFamily({
      family,
      desired: {
        ...(input.options?.reasoningEffort
          ? { reasoningEffort: input.options.reasoningEffort }
          : {}),
        ...(input.options?.fastMode !== undefined ? { fastMode: input.options.fastMode } : {}),
      },
    })?.slug ?? null
  );
}

export function resolveCursorSelectorFamily(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): CursorSelectorFamily | null {
  return findFamilyByModel(buildCursorSelectorFamilies(models), model);
}

export function modelMatchesCursorFacet(
  model: ServerProviderModel,
  family: CursorSelectorFamily,
  selections: DesiredCursorTraits,
  ignoredFacet?: CursorFacetKey,
): boolean {
  const metadata = readCursorMetadata(model);
  const reasoningEffort = metadata ? normalizedReasoningEffort(metadata, family) : null;
  if (
    ignoredFacet !== "reasoningEffort" &&
    selections.reasoningEffort !== undefined &&
    reasoningEffort !== selections.reasoningEffort
  ) {
    return false;
  }
  if (
    ignoredFacet !== "fastMode" &&
    selections.fastMode !== undefined &&
    (metadata?.fastMode ?? false) !== selections.fastMode
  ) {
    return false;
  }
  if (
    ignoredFacet !== "thinking" &&
    selections.thinking !== undefined &&
    (metadata?.thinking ?? false) !== selections.thinking
  ) {
    return false;
  }
  if (
    ignoredFacet !== "maxMode" &&
    selections.maxMode !== undefined &&
    (metadata?.maxMode ?? false) !== selections.maxMode
  ) {
    return false;
  }
  return true;
}

export function readCursorSelectedTraits(input: {
  readonly family: CursorSelectorFamily | null;
  readonly model: string | null | undefined;
}): DesiredCursorTraits {
  if (!input.family) {
    return {};
  }
  const selectedModel = input.family.models.find((candidate) => candidate.slug === input.model);
  const metadata = selectedModel ? readCursorMetadata(selectedModel) : null;
  return {
    ...(input.family.reasoningEffortOptions.length > 0
      ? {
          reasoningEffort: metadata ? normalizedReasoningEffort(metadata, input.family) : "medium",
        }
      : {}),
    ...(input.family.supportsFastMode ? { fastMode: metadata?.fastMode ?? false } : {}),
    ...(input.family.supportsThinkingToggle ? { thinking: metadata?.thinking ?? false } : {}),
    ...(input.family.supportsMaxMode ? { maxMode: metadata?.maxMode ?? false } : {}),
  };
}

export function cursorFacetValues(
  family: CursorSelectorFamily,
  key: CursorFacetKey,
  selections: DesiredCursorTraits,
): ReadonlyArray<string> {
  if (key === "reasoningEffort") {
    return family.reasoningEffortOptions.filter((value) =>
      family.models.some(
        (model) =>
          modelMatchesCursorFacet(model, family, selections, "reasoningEffort") &&
          (readCursorMetadata(model)
            ? normalizedReasoningEffort(readCursorMetadata(model)!, family)
            : null) === value,
      ),
    );
  }

  const values = new Set<string>();
  for (const model of family.models) {
    if (!modelMatchesCursorFacet(model, family, selections, key)) {
      continue;
    }
    const metadata = readCursorMetadata(model);
    const value =
      key === "fastMode"
        ? String(metadata?.fastMode === true)
        : key === "thinking"
          ? String(metadata?.thinking === true)
          : String(metadata?.maxMode === true);
    values.add(value);
  }

  return ["false", "true"].filter((value) => values.has(value));
}

export function pickCursorModelFromTraits(input: {
  readonly family: CursorSelectorFamily;
  readonly selections: DesiredCursorTraits;
}): ServerProviderModel | null {
  return pickCursorModelForFamily({
    family: input.family,
    desired: input.selections,
  });
}

export function readCursorMetadataForModel(
  model: ServerProviderModel,
): CursorModelMetadata | undefined {
  return model.cursorMetadata;
}
