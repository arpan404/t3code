import {
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderModel,
} from "@ace/contracts";
import { type UnifiedSettings, DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ProviderLastChecked,
  SettingsSection,
  SettingResetButton,
} from "./SettingsPanelPrimitives";

interface ProviderStatusStyle {
  dot: string;
}

interface ProviderSummary {
  headline: string;
  detail: string | null;
}

export interface ProviderCard {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  cliUrlPlaceholder?: string | undefined;
  cliUrlDescription?: ReactNode | undefined;
  homePathKey?: "codexHomePath" | undefined;
  homePlaceholder?: string | undefined;
  homeDescription?: ReactNode | undefined;
  binaryPathValue: string;
  cliUrlValue?: string | undefined;
  isDirty: boolean;
  models: ReadonlyArray<ServerProviderModel>;
  providerConfig: UnifiedSettings["providers"][ProviderKind];
  statusStyle: ProviderStatusStyle;
  summary: ProviderSummary;
  versionLabel: string | null;
}

function resolveCustomModelPlaceholder(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "gpt-6.7-codex-ultra-preview";
    case "claudeAgent":
      return "claude-sonnet-5-0";
    case "gemini":
      return "gemini-2.5-flash";
    case "opencode":
      return "anthropic/claude-3-5-sonnet-20241022";
    default:
      return "gpt-5-mini";
  }
}

export function ProviderSettingsSection({
  addCustomModel,
  codexHomePath,
  customModelErrorByProvider,
  customModelInputByProvider,
  isRefreshingProviders,
  lastCheckedAt,
  modelListRefs,
  openProviderDetails,
  providerCards,
  refreshProviders,
  removeCustomModel,
  setCustomModelErrorByProvider,
  setCustomModelInputByProvider,
  setOpenProviderDetails,
  settings,
  textGenProvider,
  updateSettings,
}: {
  addCustomModel: (provider: ProviderKind) => void;
  codexHomePath: string;
  customModelErrorByProvider: Partial<Record<ProviderKind, string | null>>;
  customModelInputByProvider: Record<ProviderKind, string>;
  isRefreshingProviders: boolean;
  lastCheckedAt: string | null;
  modelListRefs: MutableRefObject<Partial<Record<ProviderKind, HTMLDivElement | null>>>;
  openProviderDetails: Record<ProviderKind, boolean>;
  providerCards: ReadonlyArray<ProviderCard>;
  refreshProviders: () => void;
  removeCustomModel: (provider: ProviderKind, slug: string) => void;
  setCustomModelErrorByProvider: Dispatch<
    SetStateAction<Partial<Record<ProviderKind, string | null>>>
  >;
  setCustomModelInputByProvider: Dispatch<SetStateAction<Record<ProviderKind, string>>>;
  setOpenProviderDetails: Dispatch<SetStateAction<Record<ProviderKind, boolean>>>;
  settings: UnifiedSettings;
  textGenProvider: ProviderKind;
  updateSettings: (patch: Partial<UnifiedSettings>) => void;
}) {
  return (
    <SettingsSection
      title="Providers"
      headerAction={
        <div className="flex items-center gap-1.5">
          <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isRefreshingProviders}
                  onClick={() => void refreshProviders()}
                  aria-label="Refresh provider status"
                >
                  {isRefreshingProviders ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh provider status</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      {providerCards.map((providerCard) => {
        const customModelInput = customModelInputByProvider[providerCard.provider];
        const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
        const providerDisplayName =
          PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

        return (
          <div key={providerCard.provider} className="border-t border-border first:border-t-0">
            <div className="px-4 py-4 sm:px-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-h-5 items-center gap-1.5">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                    />
                    <h3 className="text-sm font-medium text-foreground">{providerDisplayName}</h3>
                    {providerCard.versionLabel ? (
                      <code className="text-xs text-muted-foreground">
                        {providerCard.versionLabel}
                      </code>
                    ) : null}
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                      {providerCard.isDirty ? (
                        <SettingResetButton
                          label={`${providerDisplayName} provider settings`}
                          onClick={() => {
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                [providerCard.provider]:
                                  DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                              },
                            });
                            setCustomModelErrorByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: null,
                            }));
                          }}
                        />
                      ) : null}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {providerCard.summary.headline}
                    {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                  </p>
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setOpenProviderDetails((existing) => ({
                        ...existing,
                        [providerCard.provider]: !existing[providerCard.provider],
                      }))
                    }
                    aria-label={`Toggle ${providerDisplayName} details`}
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        openProviderDetails[providerCard.provider] && "rotate-180",
                      )}
                    />
                  </Button>
                  <Switch
                    checked={providerCard.providerConfig.enabled}
                    onCheckedChange={(checked) => {
                      const isDisabling = !checked;
                      const shouldClearModelSelection =
                        isDisabling && textGenProvider === providerCard.provider;
                      updateSettings({
                        providers: {
                          ...settings.providers,
                          [providerCard.provider]: {
                            ...settings.providers[providerCard.provider],
                            enabled: Boolean(checked),
                          },
                        },
                        ...(shouldClearModelSelection
                          ? {
                              textGenerationModelSelection:
                                DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                            }
                          : {}),
                      });
                    }}
                    aria-label={`Enable ${providerDisplayName}`}
                  />
                </div>
              </div>
            </div>

            <Collapsible
              open={openProviderDetails[providerCard.provider]}
              onOpenChange={(open) =>
                setOpenProviderDetails((existing) => ({
                  ...existing,
                  [providerCard.provider]: open,
                }))
              }
            >
              <CollapsibleContent>
                <div className="space-y-0">
                  <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                    <label
                      htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                      className="block"
                    >
                      <span className="text-xs font-medium text-foreground">
                        {providerDisplayName} binary path
                      </span>
                      <Input
                        id={`provider-install-${providerCard.provider}-binary-path`}
                        className="mt-1.5"
                        value={providerCard.binaryPathValue}
                        onChange={(event) =>
                          updateSettings({
                            providers: {
                              ...settings.providers,
                              [providerCard.provider]: {
                                ...settings.providers[providerCard.provider],
                                binaryPath: event.target.value,
                              },
                            },
                          })
                        }
                        placeholder={providerCard.binaryPlaceholder}
                        spellCheck={false}
                      />
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {providerCard.binaryDescription}
                      </span>
                    </label>
                  </div>

                  {providerCard.provider === "githubCopilot" ? (
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <label
                        htmlFor={`provider-install-${providerCard.provider}-cli-url`}
                        className="block"
                      >
                        <span className="text-xs font-medium text-foreground">
                          Copilot CLI server URL
                        </span>
                        <Input
                          id={`provider-install-${providerCard.provider}-cli-url`}
                          className="mt-1.5"
                          value={providerCard.cliUrlValue ?? ""}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                githubCopilot: {
                                  ...settings.providers.githubCopilot,
                                  cliUrl: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.cliUrlPlaceholder}
                          spellCheck={false}
                        />
                        {providerCard.cliUrlDescription ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {providerCard.cliUrlDescription}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  ) : null}

                  {providerCard.homePathKey ? (
                    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                      <label
                        htmlFor={`provider-install-${providerCard.homePathKey}`}
                        className="block"
                      >
                        <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                        <Input
                          id={`provider-install-${providerCard.homePathKey}`}
                          className="mt-1.5"
                          value={codexHomePath}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                codex: {
                                  ...settings.providers.codex,
                                  homePath: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.homePlaceholder}
                          spellCheck={false}
                        />
                        {providerCard.homeDescription ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {providerCard.homeDescription}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  ) : null}

                  <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                    <div className="text-xs font-medium text-foreground">Models</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {providerCard.models.length} model
                      {providerCard.models.length === 1 ? "" : "s"} available.
                    </div>
                    <div
                      ref={(element) => {
                        modelListRefs.current[providerCard.provider] = element;
                      }}
                      className="mt-2 max-h-40 overflow-y-auto pb-1"
                    >
                      {providerCard.models.map((model) => {
                        const caps = model.capabilities;
                        const capLabels: string[] = [];
                        if (caps?.supportsFastMode) capLabels.push("Fast mode");
                        if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                        if (caps?.reasoningEffortLevels && caps.reasoningEffortLevels.length > 0) {
                          capLabels.push("Reasoning");
                        }
                        const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                        return (
                          <div
                            key={`${providerCard.provider}:${model.slug}`}
                            className="flex items-center gap-2 py-1"
                          >
                            <span className="min-w-0 truncate text-xs text-foreground/90">
                              {model.name}
                            </span>
                            {hasDetails ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                      aria-label={`Details for ${model.name}`}
                                    >
                                      <InfoIcon className="size-3" />
                                    </button>
                                  }
                                />
                                <TooltipPopup side="top" className="max-w-56">
                                  <div className="space-y-1">
                                    <code className="block text-[11px] text-foreground">
                                      {model.slug}
                                    </code>
                                    {capLabels.length > 0 ? (
                                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                        {capLabels.map((label) => (
                                          <span
                                            key={label}
                                            className="text-[10px] text-muted-foreground"
                                          >
                                            {label}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </TooltipPopup>
                              </Tooltip>
                            ) : null}
                            {model.isCustom ? (
                              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                <span className="text-[10px] text-muted-foreground">custom</span>
                                <button
                                  type="button"
                                  className="text-muted-foreground transition-colors hover:text-foreground"
                                  aria-label={`Remove ${model.slug}`}
                                  onClick={() =>
                                    removeCustomModel(providerCard.provider, model.slug)
                                  }
                                >
                                  <XIcon className="size-3" />
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Input
                        id={`custom-model-${providerCard.provider}`}
                        value={customModelInput}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCustomModelInputByProvider((existing) => ({
                            ...existing,
                            [providerCard.provider]: value,
                          }));
                          if (customModelError) {
                            setCustomModelErrorByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: null,
                            }));
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          addCustomModel(providerCard.provider);
                        }}
                        placeholder={resolveCustomModelPlaceholder(providerCard.provider)}
                        spellCheck={false}
                      />
                      <Button
                        className="shrink-0"
                        variant="outline"
                        onClick={() => addCustomModel(providerCard.provider)}
                      >
                        <PlusIcon className="size-3.5" />
                        Add
                      </Button>
                    </div>

                    {customModelError ? (
                      <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                    ) : null}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      })}
    </SettingsSection>
  );
}
