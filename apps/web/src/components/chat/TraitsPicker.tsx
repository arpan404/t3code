import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderModelSelection,
  isClaudeUltrathinkPrompt,
  trimOrNull,
  getDefaultEffort,
  getDefaultContextWindow,
  hasContextWindowOption,
  resolveEffort,
} from "@t3tools/shared/model";
import { Fragment, memo, type ReactElement, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import {
  cursorFacetValues,
  pickCursorModelFromTraits,
  readCursorSelectedTraits,
  resolveCursorSelectorFamily,
  type CursorSelectorFamily,
  type CursorSelectorReasoningEffort,
} from "../../cursorModelSelector";

type ProviderOptions = ProviderModelOptions[ProviderKind];
type TraitsPersistence =
  | {
      threadId: ThreadId;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";
const CURSOR_REASONING_LABELS: Record<CursorSelectorReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex" || provider === "cursor") {
    return trimOrNull(
      (modelOptions as CodexModelOptions | CursorModelOptions | undefined)?.reasoningEffort,
    );
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
  }
  return null;
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return {
      ...(modelOptions as CodexModelOptions | undefined),
      ...patch,
    } as CodexModelOptions;
  }
  if (provider === "cursor") {
    return {
      ...(modelOptions as CursorModelOptions | undefined),
      ...patch,
    } as CursorModelOptions;
  }
  return {
    ...(modelOptions as ClaudeModelOptions | undefined),
    ...patch,
  } as ClaudeModelOptions;
}

function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const effortLevels = allowPromptInjectedEffort
    ? caps.reasoningEffortLevels
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );

  // Resolve effort from options (provider-specific key)
  const rawEffort = getRawEffort(provider, modelOptions);
  const effort = resolveEffort(caps, rawEffort) ?? null;

  // Thinking budget options (replaces binary toggle when available)
  const thinkingBudgetOptions = caps.thinkingBudgetOptions ?? [];

  // Thinking toggle (only for models that support it)
  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  // Thinking budget (selected budget level, or default)
  const thinkingBudget =
    thinkingBudgetOptions.length > 0 && thinkingEnabled !== null
      ? ((modelOptions as ClaudeModelOptions | undefined)?.thinkingBudget ??
        thinkingBudgetOptions.find((o) => o.isDefault)?.value ??
        thinkingBudgetOptions[0]?.value ??
        null)
      : null;

  // Fast mode
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  // Context window
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    thinkingBudget,
    thinkingBudgetOptions,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  };
}

function hasVisibleTraits(input: {
  effortLevels: ReadonlyArray<{ value: string }>;
  thinkingEnabled: boolean | null;
  supportsFastMode: boolean;
  contextWindowOptions: ReadonlyArray<{ value: string }>;
}): boolean {
  return (
    input.effortLevels.length > 0 ||
    input.thinkingEnabled !== null ||
    input.supportsFastMode ||
    input.contextWindowOptions.length > 1
  );
}

function hasVisibleCursorTraits(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): boolean {
  const family = resolveCursorSelectorFamily(models, model);
  if (!family) {
    return false;
  }
  return (
    hasSelectableCursorReasoningEffort(family) ||
    family.supportsThinkingToggle ||
    family.supportsFastMode ||
    family.supportsMaxMode
  );
}

function readDefaultCursorTraits(
  family: CursorSelectorFamily,
): ReturnType<typeof readCursorSelectedTraits> {
  const defaultModel = pickCursorModelFromTraits({ family, selections: {} });
  return readCursorSelectedTraits({
    family,
    model: defaultModel?.slug,
  });
}

function hasSelectableCursorReasoningEffort(family: CursorSelectorFamily): boolean {
  return family.reasoningEffortOptions.length > 1;
}

function buildCursorTriggerLabel(input: {
  family: CursorSelectorFamily;
  model: string | null | undefined;
}): string {
  const selectedTraits = readCursorSelectedTraits(input);
  const primaryLabel =
    hasSelectableCursorReasoningEffort(input.family) && selectedTraits.reasoningEffort
      ? CURSOR_REASONING_LABELS[selectedTraits.reasoningEffort]
      : input.family.supportsThinkingToggle
        ? `Thinking ${selectedTraits.thinking ? "On" : "None"}`
        : input.family.supportsFastMode
          ? `Fast ${selectedTraits.fastMode ? "On" : "Off"}`
          : input.family.supportsMaxMode
            ? `Max ${selectedTraits.maxMode ? "On" : "Off"}`
            : "Variants";

  return [
    primaryLabel,
    selectedTraits.fastMode && !primaryLabel.startsWith("Fast") ? "Fast" : null,
    selectedTraits.thinking && !primaryLabel.startsWith("Thinking") ? "Thinking" : null,
    selectedTraits.maxMode && !primaryLabel.startsWith("Max") ? "Max" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function shouldRenderTraitsPicker(input: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  if (input.provider === "cursor") {
    return hasVisibleCursorTraits(input.models, input.model);
  }

  const { caps, effortLevels, thinkingEnabled, contextWindowOptions } = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  return hasVisibleTraits({
    effortLevels,
    thinkingEnabled,
    supportsFastMode: caps.supportsFastMode,
    contextWindowOptions,
  });
}

export const CursorTraitsMenuContent = memo(function CursorTraitsMenuContent(props: {
  threadId: ThreadId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
}) {
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const family = resolveCursorSelectorFamily(props.models, props.model);

  const applySelection = useCallback(
    (nextModelSlug: string) => {
      const modelSelection = buildProviderModelSelection("cursor", nextModelSlug);
      setModelSelection(props.threadId, modelSelection);
      setProviderModelOptions(props.threadId, "cursor", undefined, {
        persistSticky: true,
      });
      setStickyModelSelection(modelSelection);
    },
    [props.threadId, setModelSelection, setProviderModelOptions, setStickyModelSelection],
  );

  if (!family) {
    return null;
  }

  const selectedTraits = readCursorSelectedTraits({
    family,
    model: props.model,
  });
  const defaultTraits = readDefaultCursorTraits(family);

  const renderBinaryFacet = (
    key: "thinking" | "fastMode" | "maxMode",
    label: string,
    selectedValue: boolean | undefined,
  ) => {
    const values = cursorFacetValues(family, key, selectedTraits);
    if (values.length < 2) {
      return null;
    }

    const defaultValue = defaultTraits[key];

    return (
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">{label}</div>
        <MenuRadioGroup
          value={selectedValue ? "on" : "off"}
          onValueChange={(value) => {
            const nextModel = pickCursorModelFromTraits({
              family,
              selections: {
                ...selectedTraits,
                [key]: value === "on",
              },
            });
            if (nextModel) {
              applySelection(nextModel.slug);
            }
          }}
        >
          {[
            {
              value: "off",
              label: key === "thinking" ? "None" : "off",
              enabled: values.includes("false"),
              active: false,
            },
            {
              value: "on",
              label: "on",
              enabled: values.includes("true"),
              active: true,
            },
          ].map((option) => (
            <MenuRadioItem
              key={`cursor-${key}:${option.value}`}
              value={option.value}
              disabled={!option.enabled}
            >
              {option.label}
              {defaultValue === option.active ? " (default)" : ""}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    );
  };

  const sections: Array<{ key: string; element: ReactElement }> = [];

  if (hasSelectableCursorReasoningEffort(family)) {
    sections.push({
      key: "effort",
      element: (
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
          <MenuRadioGroup
            value={selectedTraits.reasoningEffort ?? "medium"}
            onValueChange={(value) => {
              const nextModel = pickCursorModelFromTraits({
                family,
                selections: {
                  ...selectedTraits,
                  reasoningEffort: value as CursorSelectorReasoningEffort,
                },
              });
              if (nextModel) {
                applySelection(nextModel.slug);
              }
            }}
          >
            {family.reasoningEffortOptions.map((option) => (
              <MenuRadioItem
                key={`cursor-effort:${option}`}
                value={option}
                disabled={
                  !cursorFacetValues(family, "reasoningEffort", selectedTraits).includes(option)
                }
              >
                {CURSOR_REASONING_LABELS[option]}
                {defaultTraits.reasoningEffort === option ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }

  for (const section of [
    {
      key: "thinking",
      element: renderBinaryFacet("thinking", "Thinking", selectedTraits.thinking),
    },
    {
      key: "fastMode",
      element: renderBinaryFacet("fastMode", "Fast Mode", selectedTraits.fastMode),
    },
    {
      key: "maxMode",
      element: renderBinaryFacet("maxMode", "Max Mode", selectedTraits.maxMode),
    },
  ]) {
    if (section.element) {
      sections.push({ key: section.key, element: section.element });
    }
  }

  return (
    <>
      {sections.map((section, index) => (
        <Fragment key={`cursor-traits-section:${section.key}`}>
          {index > 0 ? <MenuDivider /> : null}
          {section.element}
        </Fragment>
      ))}
    </>
  );
});

export const CursorTraitsPicker = memo(function CursorTraitsPicker(props: {
  threadId: ThreadId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const family = resolveCursorSelectorFamily(props.models, props.model);

  if (!family || !hasVisibleCursorTraits(props.models, props.model)) {
    return null;
  }

  const triggerLabel = buildCursorTriggerLabel({
    family,
    model: props.model,
  });

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {triggerLabel}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CursorTraitsMenuContent
          threadId={props.threadId}
          models={props.models}
          model={props.model}
        />
      </MenuPopup>
    </Menu>
  );
});

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      setProviderModelOptions(persistence.threadId, provider, nextOptions, {
        persistSticky: true,
      });
    },
    [persistence, provider, setProviderModelOptions],
  );
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    thinkingBudget,
    thinkingBudgetOptions,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  } = getSelectedTraits(provider, models, model, prompt, modelOptions, allowPromptInjectedEffort);
  const defaultEffort = getDefaultEffort(caps);

  const handleEffortChange = useCallback(
    (value: string) => {
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkInBodyText) return;
      if (ultrathinkPromptControlled) {
        const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
        onPromptChange(stripped);
      }
      const effortKey = provider === "claudeAgent" ? "effort" : "reasoningEffort";
      updateModelOptions(
        buildNextOptions(provider, modelOptions, {
          [effortKey]: nextOption.value,
        }),
      );
    },
    [
      ultrathinkPromptControlled,
      ultrathinkInBodyText,
      modelOptions,
      onPromptChange,
      updateModelOptions,
      effortLevels,
      prompt,
      caps.promptInjectedEffortLevels,
      provider,
    ],
  );

  if (
    !hasVisibleTraits({
      effortLevels,
      thinkingEnabled,
      supportsFastMode: caps.supportsFastMode,
      contextWindowOptions,
    })
  ) {
    return null;
  }

  return (
    <>
      {effort ? (
        <>
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
            {ultrathinkInBodyText ? (
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
              </div>
            ) : null}
            <MenuRadioGroup
              value={ultrathinkPromptControlled ? "ultrathink" : effort}
              onValueChange={handleEffortChange}
            >
              {effortLevels.map((option) => (
                <MenuRadioItem
                  key={option.value}
                  value={option.value}
                  disabled={ultrathinkInBodyText}
                >
                  {option.label}
                  {option.value === defaultEffort ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : thinkingEnabled !== null && thinkingBudgetOptions.length > 0 ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? (thinkingBudget ?? "on") : "none"}
            onValueChange={(value) => {
              if (value === "none") {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    thinking: false,
                    thinkingBudget: undefined,
                  }),
                );
              } else {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    thinking: true,
                    thinkingBudget: value,
                  }),
                );
              }
            }}
          >
            <MenuRadioItem value="none">None</MenuRadioItem>
            {thinkingBudgetOptions.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
                {option.isDefault ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "none"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, {
                  thinking: value === "on",
                }),
              );
            }}
          >
            <MenuRadioItem value="none">None</MenuRadioItem>
            <MenuRadioItem value="on">Enabled (default)</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {caps.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    fastMode: value === "on",
                  }),
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {contextWindowOptions.length > 1 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: value,
                  }),
                );
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    thinkingBudget,
    thinkingBudgetOptions,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, models, model, prompt, modelOptions, allowPromptInjectedEffort);

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const thinkingLabel =
    thinkingEnabled === null
      ? null
      : thinkingBudgetOptions.length > 0
        ? thinkingEnabled
          ? (thinkingBudgetOptions.find((o) => o.value === thinkingBudget)?.label ?? "Thinking On")
          : "Thinking None"
        : thinkingEnabled
          ? "Thinking On"
          : "Thinking None";
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((o) => o.value === contextWindow)?.label ?? null)
      : null;
  const triggerLabel = [
    ultrathinkPromptControlled ? "Ultrathink" : effortLabel ? effortLabel : thinkingLabel,
    ...(caps.supportsFastMode && fastModeEnabled ? ["Fast"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  const isCodexStyle = provider === "codex" || provider === "cursor";

  if (
    !hasVisibleTraits({
      effortLevels,
      thinkingEnabled,
      supportsFastMode: caps.supportsFastMode,
      contextWindowOptions,
    })
  ) {
    return null;
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
