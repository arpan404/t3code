import { type ProviderKind, type ServerProvider } from "@ace/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { resolveSelectableModel } from "@ace/shared/model";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, CursorIcon, Gemini, GitHubIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { searchOpenCodeModelsInfiniteQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  githubCopilot: GitHubIcon,
  cursor: CursorIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const MODEL_MENU_MAX_HEIGHT = "24rem";
const OPENCODE_MODEL_PAGE_SIZE = 10;

function mergeModelOptions(
  ...optionGroups: ReadonlyArray<ReadonlyArray<{ slug: string; name: string }>>
): ReadonlyArray<{ slug: string; name: string }> {
  const merged: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();

  for (const options of optionGroups) {
    for (const option of options) {
      if (seen.has(option.slug)) {
        continue;
      }
      seen.add(option.slug);
      merged.push(option);
    }
  }

  return merged;
}

const OpenCodeModelMenuContent = memo(function OpenCodeModelMenuContent(props: {
  initialOptions: ReadonlyArray<{ slug: string; name: string }>;
  selectedModel: string;
  onModelChange: (value: string, options: ReadonlyArray<{ slug: string; name: string }>) => void;
}) {
  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearch, searchDebouncer] = useDebouncedValue(
    searchValue,
    { wait: 150 },
    (state) => ({ isPending: state.isPending }),
  );
  const query = useInfiniteQuery(
    searchOpenCodeModelsInfiniteQueryOptions({
      query: debouncedSearch,
      limit: OPENCODE_MODEL_PAGE_SIZE,
    }),
  );
  const remoteOptions = useMemo(
    () =>
      (query.data?.pages ?? []).flatMap((page) =>
        page.models.map((model) => ({ slug: model.slug, name: model.name })),
      ),
    [query.data?.pages],
  );
  const selectedFallbackOption = useMemo(
    () => props.initialOptions.find((option) => option.slug === props.selectedModel),
    [props.initialOptions, props.selectedModel],
  );
  const visibleOptions = useMemo(() => {
    if (debouncedSearch.trim().length === 0) {
      return mergeModelOptions(remoteOptions, props.initialOptions);
    }
    return mergeModelOptions(remoteOptions, selectedFallbackOption ? [selectedFallbackOption] : []);
  }, [debouncedSearch, props.initialOptions, remoteOptions, selectedFallbackOption]);
  const isLoadingInitialPage = query.isPending && remoteOptions.length === 0;
  const isSearching = searchDebouncer.state.isPending || query.isFetching;
  const totalModels = query.data?.pages[0]?.totalModels ?? props.initialOptions.length;

  return (
    <div className="w-[min(24rem,calc(100vw-3rem))]">
      <div className="sticky top-0 z-10 mb-1 bg-popover/95 px-1 pb-2 pt-1 backdrop-blur">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            aria-label="Search OpenCode models"
            className="pl-8"
            nativeInput
            placeholder="Search OpenCode models"
            size="sm"
            type="search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.currentTarget.value)}
          />
        </div>
        <div className="mt-1 flex items-center justify-between px-1 text-[11px] text-muted-foreground/80">
          <span>
            {String(totalModels)} model{totalModels === 1 ? "" : "s"}
          </span>
          {isSearching ? (
            <span className="inline-flex items-center gap-1">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Updating
            </span>
          ) : null}
        </div>
      </div>

      {isLoadingInitialPage ? (
        <MenuItem disabled>
          <LoaderCircleIcon className="size-4 animate-spin" />
          Loading OpenCode models...
        </MenuItem>
      ) : visibleOptions.length > 0 ? (
        <>
          <MenuGroup>
            <MenuRadioGroup
              value={props.selectedModel}
              onValueChange={(value) => props.onModelChange(value, visibleOptions)}
            >
              {visibleOptions.map((modelOption) => (
                <MenuRadioItem key={`opencode:${modelOption.slug}`} value={modelOption.slug}>
                  {modelOption.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {query.hasNextPage ? (
            <div className="px-1 pt-2">
              <Button
                className="w-full justify-center"
                size="sm"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  void query.fetchNextPage();
                }}
              >
                {query.isFetchingNextPage ? (
                  <>
                    <LoaderCircleIcon className="size-4 animate-spin" />
                    Loading more
                  </>
                ) : (
                  `Load ${String(OPENCODE_MODEL_PAGE_SIZE)} more`
                )}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <MenuItem disabled>No OpenCode models matched that search.</MenuItem>
      )}
    </div>
  );
});

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  if (provider === "claudeAgent") {
    return "text-warning-foreground";
  }
  if (provider === "githubCopilot") {
    return "text-foreground";
  }
  return fallbackClassName;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    options: ReadonlyArray<{ slug: string; name: string }> = props.modelOptionsByProvider[provider],
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(provider, value, options);
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/60 transition-colors duration-150 hover:text-foreground/70 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-2.5",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider, "text-muted-foreground/70"),
              props.activeProviderIconClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" listMaxHeight={MODEL_MENU_MAX_HEIGHT}>
        {props.lockedProvider !== null ? (
          props.lockedProvider === "opencode" ? (
            <OpenCodeModelMenuContent
              initialOptions={props.modelOptionsByProvider.opencode}
              selectedModel={props.model}
              onModelChange={(value, options) => handleModelChange("opencode", value, options)}
            />
          ) : (
            <MenuGroup>
              <MenuRadioGroup
                value={props.model}
                onValueChange={(value) => handleModelChange(props.lockedProvider!, value)}
              >
                {props.modelOptionsByProvider[props.lockedProvider].map((modelOption) => (
                  <MenuRadioItem
                    key={`${props.lockedProvider}:${modelOption.slug}`}
                    value={modelOption.slug}
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {modelOption.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          )
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }
              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup listMaxHeight={MODEL_MENU_MAX_HEIGHT} sideOffset={4}>
                    {option.value === "opencode" ? (
                      <OpenCodeModelMenuContent
                        initialOptions={props.modelOptionsByProvider.opencode}
                        selectedModel={props.provider === "opencode" ? props.model : ""}
                        onModelChange={(value, options) =>
                          handleModelChange("opencode", value, options)
                        }
                      />
                    ) : (
                      <MenuGroup>
                        <MenuRadioGroup
                          value={props.provider === option.value ? props.model : ""}
                          onValueChange={(value) => handleModelChange(option.value, value)}
                        >
                          {props.modelOptionsByProvider[option.value].map((modelOption) => (
                            <MenuRadioItem
                              key={`${option.value}:${modelOption.slug}`}
                              value={modelOption.slug}
                              onClick={() => setIsMenuOpen(false)}
                            >
                              {modelOption.name}
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      </MenuGroup>
                    )}
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground/85 opacity-80"
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
