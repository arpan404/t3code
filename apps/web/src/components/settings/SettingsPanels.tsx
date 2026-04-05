import { ArchiveIcon, ArchiveX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { type ProviderKind, ThreadId } from "@ace/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { buildProviderModelSelection, normalizeModelSlug } from "@ace/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../lib/desktopUpdate";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BROWSER_SEARCH_ENGINE_OPTIONS } from "../../lib/browser/types";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderSettingsSection, type ProviderCard } from "./ProviderSettingsSection";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
  getProviderSummary,
  getProviderVersionLabel,
} from "./SettingsPanelPrimitives";
import {
  useServerAvailableEditors,
  useServerKeybindings,
  useServerKeybindingsConfigPath,
  useServerProviders,
} from "../../rpc/serverState";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  cliUrlPlaceholder?: string;
  cliUrlDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "githubCopilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the Copilot CLI binary",
    cliUrlPlaceholder: "localhost:4321",
    cliUrlDescription:
      "Optional: connect to an external headless Copilot CLI server instead of spawning per session.",
  },
  {
    provider: "cursor",
    title: "Cursor",
    binaryPlaceholder: "Cursor binary path",
    binaryDescription: "Path to the Cursor Agent binary",
  },
  {
    provider: "gemini",
    title: "Gemini",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: "Path to the Gemini CLI binary",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
  },
] as const;

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: "Download",
    install: "Install",
  };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine
        ? ["Browser search engine"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.editorLineNumbers !== DEFAULT_UNIFIED_SETTINGS.editorLineNumbers
        ? ["Editor line numbers"]
        : []),
      ...(settings.editorMinimap !== DEFAULT_UNIFIED_SETTINGS.editorMinimap
        ? ["Editor minimap"]
        : []),
      ...(settings.editorRenderWhitespace !== DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace
        ? ["Editor whitespace"]
        : []),
      ...(settings.editorStickyScroll !== DEFAULT_UNIFIED_SETTINGS.editorStickyScroll
        ? ["Editor sticky scroll"]
        : []),
      ...(settings.editorSuggestions !== DEFAULT_UNIFIED_SETTINGS.editorSuggestions
        ? ["Editor suggestions"]
        : []),
      ...(settings.editorWordWrap !== DEFAULT_UNIFIED_SETTINGS.editorWordWrap
        ? ["Editor line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.enableToolStreaming !== DEFAULT_UNIFIED_SETTINGS.enableToolStreaming
        ? ["Tool activity"]
        : []),
      ...(settings.enableThinkingStreaming !== DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming
        ? ["Thinking activity"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.threadHydrationCacheMemoryMb !==
      DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb
        ? ["Thread cache budget"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      settings.browserSearchEngine,
      isGitWritingModelDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.defaultThreadEnvMode,
      settings.diffWordWrap,
      settings.editorLineNumbers,
      settings.editorMinimap,
      settings.editorRenderWhitespace,
      settings.editorStickyScroll,
      settings.editorSuggestions,
      settings.editorWordWrap,
      settings.enableAssistantStreaming,
      settings.enableThinkingStreaming,
      settings.enableToolStreaming,
      settings.threadHydrationCacheMemoryMb,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

type SettingsPanelPage =
  | "general"
  | "chat"
  | "editor"
  | "browser"
  | "models"
  | "providers"
  | "advanced"
  | "about";

function SettingsPanel({ page }: { page: SettingsPanelPage }) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    githubCopilot: Boolean(
      settings.providers.githubCopilot.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.githubCopilot.binaryPath ||
      settings.providers.githubCopilot.customModels.length > 0,
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
    gemini: Boolean(
      settings.providers.gemini.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.gemini.binaryPath ||
      settings.providers.gemini.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.customModels.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    githubCopilot: "",
    cursor: "",
    gemini: "",
    opencode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const serverProviders = useServerProviders();
  const codexHomePath = settings.providers.codex.homePath;
  const editorShortcutLabelOptions = useMemo(
    () => ({
      context: {
        browserOpen: false,
        editorFocus: true,
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [],
  );
  const workspaceShortcutSummaries = useMemo(
    () =>
      [
        [
          "Split window",
          shortcutLabelForCommand(keybindings, "editor.split", editorShortcutLabelOptions),
        ],
        [
          "Split window down",
          shortcutLabelForCommand(keybindings, "editor.splitDown", editorShortcutLabelOptions),
        ],
        [
          "Focus previous window",
          shortcutLabelForCommand(
            keybindings,
            "editor.focusPreviousWindow",
            editorShortcutLabelOptions,
          ),
        ],
        [
          "Focus next window",
          shortcutLabelForCommand(
            keybindings,
            "editor.focusNextWindow",
            editorShortcutLabelOptions,
          ),
        ],
        [
          "Previous tab",
          shortcutLabelForCommand(keybindings, "editor.previousTab", editorShortcutLabelOptions),
        ],
        [
          "Next tab",
          shortcutLabelForCommand(keybindings, "editor.nextTab", editorShortcutLabelOptions),
        ],
        [
          "Move tab left",
          shortcutLabelForCommand(keybindings, "editor.moveTabLeft", editorShortcutLabelOptions),
        ],
        [
          "Move tab right",
          shortcutLabelForCommand(keybindings, "editor.moveTabRight", editorShortcutLabelOptions),
        ],
      ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    [editorShortcutLabelOptions, keybindings],
  );

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const providerCards: ProviderCard[] = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const models =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: providerConfig.binaryPath,
      cliUrlValue:
        providerSettings.provider === "githubCopilot"
          ? settings.providers.githubCopilot.cliUrl
          : undefined,
      cliUrlPlaceholder: providerSettings.cliUrlPlaceholder,
      cliUrlDescription: providerSettings.cliUrlDescription,
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const isGeneralPage = page === "general";
  const isChatPage = page === "chat";
  const isEditorPage = page === "editor";
  const isBrowserPage = page === "browser";
  const isModelsPage = page === "models";
  const isProvidersPage = page === "providers";
  const isAdvancedPage = page === "advanced";
  const isAboutPage = page === "about";

  return (
    <SettingsPageContainer>
      {isGeneralPage ? (
        <>
          <SettingsSection title="Appearance">
            <SettingsRow
              title="Theme"
              description="Choose how ace looks across the app."
              resetAction={
                theme !== "system" ? (
                  <SettingResetButton label="theme" onClick={() => setTheme("system")} />
                ) : null
              }
              control={
                <Select
                  value={theme}
                  onValueChange={(value) => {
                    if (value === "system" || value === "light" || value === "dark") {
                      setTheme(value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                    <SelectValue>
                      {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {THEME_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Time format"
              description="System default follows your browser or OS clock preference."
              resetAction={
                settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                  <SettingResetButton
                    label="time format"
                    onClick={() =>
                      updateSettings({
                        timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.timestampFormat}
                  onValueChange={(value) => {
                    if (value === "locale" || value === "12-hour" || value === "24-hour") {
                      updateSettings({ timestampFormat: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                    <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="locale">
                      {TIMESTAMP_FORMAT_LABELS.locale}
                    </SelectItem>
                    <SelectItem hideIndicator value="12-hour">
                      {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                    </SelectItem>
                    <SelectItem hideIndicator value="24-hour">
                      {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>

          <SettingsSection title="Defaults">
            <SettingsRow
              title="New threads"
              description="Pick the default workspace mode for newly created draft threads."
              resetAction={
                settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                  <SettingResetButton
                    label="new threads"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.defaultThreadEnvMode}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      updateSettings({ defaultThreadEnvMode: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                    <SelectValue>
                      {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="local">
                      Local
                    </SelectItem>
                    <SelectItem hideIndicator value="worktree">
                      New worktree
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isChatPage ? (
        <>
          <SettingsSection title="Live output">
            <SettingsRow
              title="Assistant output"
              description="Show token-by-token output while a response is in progress."
              resetAction={
                settings.enableAssistantStreaming !==
                DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                  <SettingResetButton
                    label="assistant output"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableAssistantStreaming: Boolean(checked) })
                  }
                  aria-label="Stream assistant messages"
                />
              }
            />

            <SettingsRow
              title="Tool activity"
              description="Show tool-call activity in the timeline while a response is running."
              resetAction={
                settings.enableToolStreaming !== DEFAULT_UNIFIED_SETTINGS.enableToolStreaming ? (
                  <SettingResetButton
                    label="tool activity"
                    onClick={() =>
                      updateSettings({
                        enableToolStreaming: DEFAULT_UNIFIED_SETTINGS.enableToolStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableToolStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableToolStreaming: Boolean(checked) })
                  }
                  aria-label="Stream tool activity"
                />
              }
            />

            <SettingsRow
              title="Thinking activity"
              description="Show reasoning and planning updates in the timeline while a response is running."
              resetAction={
                settings.enableThinkingStreaming !==
                DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming ? (
                  <SettingResetButton
                    label="thinking activity"
                    onClick={() =>
                      updateSettings({
                        enableThinkingStreaming: DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableThinkingStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableThinkingStreaming: Boolean(checked) })
                  }
                  aria-label="Stream thinking activity"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Confirmations">
            <SettingsRow
              title="Archive confirmation"
              description="Require a second click on the inline archive action before a thread is archived."
              resetAction={
                settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
                  <SettingResetButton
                    label="archive confirmation"
                    onClick={() =>
                      updateSettings({
                        confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.confirmThreadArchive}
                  onCheckedChange={(checked) =>
                    updateSettings({ confirmThreadArchive: Boolean(checked) })
                  }
                  aria-label="Confirm thread archiving"
                />
              }
            />

            <SettingsRow
              title="Delete confirmation"
              description="Ask before deleting a thread and its chat history."
              resetAction={
                settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                  <SettingResetButton
                    label="delete confirmation"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({ confirmThreadDelete: Boolean(checked) })
                  }
                  aria-label="Confirm thread deletion"
                />
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isEditorPage ? (
        <>
          <SettingsSection title="Diffs">
            <SettingsRow
              title="Diff line wrapping"
              description="Set the default wrap state when the diff panel opens."
              resetAction={
                settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
                  <SettingResetButton
                    label="diff line wrapping"
                    onClick={() =>
                      updateSettings({
                        diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.diffWordWrap}
                  onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
                  aria-label="Wrap diff lines by default"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Workspace editor">
            <SettingsRow
              title="Neovim mode"
              description="Enable modal Vim-style editing in the workspace editor while keeping the current Monaco UI."
              resetAction={
                settings.editorNeovimMode !== DEFAULT_UNIFIED_SETTINGS.editorNeovimMode ? (
                  <SettingResetButton
                    label="neovim mode"
                    onClick={() =>
                      updateSettings({
                        editorNeovimMode: DEFAULT_UNIFIED_SETTINGS.editorNeovimMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorNeovimMode}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorNeovimMode: Boolean(checked) })
                  }
                  aria-label="Enable Neovim mode in the workspace editor"
                />
              }
            />

            <SettingsRow
              title="Editor suggestions"
              description="Keep Monaco completion helpers off by default to reduce noisy or unwanted code insertions."
              resetAction={
                settings.editorSuggestions !== DEFAULT_UNIFIED_SETTINGS.editorSuggestions ? (
                  <SettingResetButton
                    label="editor suggestions"
                    onClick={() =>
                      updateSettings({
                        editorSuggestions: DEFAULT_UNIFIED_SETTINGS.editorSuggestions,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorSuggestions}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorSuggestions: Boolean(checked) })
                  }
                  aria-label="Enable workspace editor suggestions"
                />
              }
            />

            <SettingsRow
              title="Editor line wrapping"
              description="Wrap long lines in the workspace editor."
              resetAction={
                settings.editorWordWrap !== DEFAULT_UNIFIED_SETTINGS.editorWordWrap ? (
                  <SettingResetButton
                    label="editor line wrapping"
                    onClick={() =>
                      updateSettings({
                        editorWordWrap: DEFAULT_UNIFIED_SETTINGS.editorWordWrap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorWordWrap}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorWordWrap: Boolean(checked) })
                  }
                  aria-label="Wrap workspace editor lines"
                />
              }
            />

            <SettingsRow
              title="Editor sticky scroll"
              description="Pin the current scope header while you scroll through a file."
              resetAction={
                settings.editorStickyScroll !== DEFAULT_UNIFIED_SETTINGS.editorStickyScroll ? (
                  <SettingResetButton
                    label="editor sticky scroll"
                    onClick={() =>
                      updateSettings({
                        editorStickyScroll: DEFAULT_UNIFIED_SETTINGS.editorStickyScroll,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorStickyScroll}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorStickyScroll: Boolean(checked) })
                  }
                  aria-label="Enable editor sticky scroll"
                />
              }
            />

            <SettingsRow
              title="Editor minimap"
              description="Show a code minimap in the workspace editor."
              resetAction={
                settings.editorMinimap !== DEFAULT_UNIFIED_SETTINGS.editorMinimap ? (
                  <SettingResetButton
                    label="editor minimap"
                    onClick={() =>
                      updateSettings({
                        editorMinimap: DEFAULT_UNIFIED_SETTINGS.editorMinimap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorMinimap}
                  onCheckedChange={(checked) => updateSettings({ editorMinimap: Boolean(checked) })}
                  aria-label="Show editor minimap"
                />
              }
            />

            <SettingsRow
              title="Editor whitespace"
              description="Render whitespace characters in the workspace editor."
              resetAction={
                settings.editorRenderWhitespace !==
                DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace ? (
                  <SettingResetButton
                    label="editor whitespace"
                    onClick={() =>
                      updateSettings({
                        editorRenderWhitespace: DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorRenderWhitespace}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorRenderWhitespace: Boolean(checked) })
                  }
                  aria-label="Render editor whitespace"
                />
              }
            />

            <SettingsRow
              title="Editor line numbers"
              description="Choose how line numbers appear in the workspace editor."
              resetAction={
                settings.editorLineNumbers !== DEFAULT_UNIFIED_SETTINGS.editorLineNumbers ? (
                  <SettingResetButton
                    label="editor line numbers"
                    onClick={() =>
                      updateSettings({
                        editorLineNumbers: DEFAULT_UNIFIED_SETTINGS.editorLineNumbers,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.editorLineNumbers}
                  onValueChange={(value) => {
                    if (value === "off" || value === "on" || value === "relative") {
                      updateSettings({ editorLineNumbers: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Editor line numbers">
                    <SelectValue>{settings.editorLineNumbers}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="on">
                      On
                    </SelectItem>
                    <SelectItem hideIndicator value="relative">
                      Relative
                    </SelectItem>
                    <SelectItem hideIndicator value="off">
                      Off
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Workspace editor shortcuts"
              description="These commands resolve through the same keybindings.json file that drives the rest of the app."
              status={
                workspaceShortcutSummaries.length > 0 ? (
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    {workspaceShortcutSummaries.map(([label, shortcut]) => (
                      <div key={label} className="flex items-center gap-2">
                        <span>{label}</span>
                        <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-foreground">
                          {shortcut}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    No editor shortcuts are currently configured.
                  </span>
                )
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isBrowserPage ? (
        <SettingsSection title="In-app browser">
          <SettingsRow
            title="Search engine"
            description="Choose the default engine for new-tab search, address-bar suggestions, and quick browser entry."
            resetAction={
              settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ? (
                <SettingResetButton
                  label="browser search engine"
                  onClick={() =>
                    updateSettings({
                      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
                    })
                  }
                />
              ) : null
            }
            status="Pinned pages, history cleanup, and storage repair stay inside the browser tab settings."
          >
            <div className="mt-4 flex flex-wrap gap-2">
              {BROWSER_SEARCH_ENGINE_OPTIONS.map((engine) => (
                <Button
                  key={engine.value}
                  size="sm"
                  variant={settings.browserSearchEngine === engine.value ? "default" : "outline"}
                  onClick={() => updateSettings({ browserSearchEngine: engine.value })}
                >
                  {engine.label}
                </Button>
              ))}
            </div>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      {isModelsPage ? (
        <SettingsSection title="Text generation">
          <SettingsRow
            title="Text generation model"
            description="Configure an override for generated commit messages, PR titles, and similar Git text. Leave it unchanged to fall back to the current chat model."
            resetAction={
              isGitWritingModelDirty ? (
                <SettingResetButton
                  label="text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  provider={textGenProvider}
                  model={textGenModel}
                  lockedProvider={null}
                  providers={serverProviders}
                  modelOptionsByProvider={gitModelOptionsByProvider}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onProviderModelChange={(provider, model) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: { provider, model },
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
                <TraitsPicker
                  provider={textGenProvider}
                  models={
                    serverProviders.find((provider) => provider.provider === textGenProvider)
                      ?.models ?? []
                  }
                  model={textGenModel}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: buildProviderModelSelection(
                            textGenProvider,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {isProvidersPage ? (
        <ProviderSettingsSection
          addCustomModel={addCustomModel}
          codexHomePath={codexHomePath}
          customModelErrorByProvider={customModelErrorByProvider}
          customModelInputByProvider={customModelInputByProvider}
          isRefreshingProviders={isRefreshingProviders}
          lastCheckedAt={lastCheckedAt}
          modelListRefs={modelListRefs}
          openProviderDetails={openProviderDetails}
          providerCards={providerCards}
          refreshProviders={refreshProviders}
          removeCustomModel={removeCustomModel}
          setCustomModelErrorByProvider={setCustomModelErrorByProvider}
          setCustomModelInputByProvider={setCustomModelInputByProvider}
          setOpenProviderDetails={setOpenProviderDetails}
          settings={settings}
          textGenProvider={textGenProvider}
          updateSettings={updateSettings}
        />
      ) : null}

      {isAdvancedPage ? (
        <>
          <SettingsSection title="Performance">
            <SettingsRow
              title="Thread cache budget"
              description="Limit how much memory hydrated thread history can use before least-recently-used threads are evicted."
              resetAction={
                settings.threadHydrationCacheMemoryMb !==
                DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb ? (
                  <SettingResetButton
                    label="thread cache budget"
                    onClick={() =>
                      updateSettings({
                        threadHydrationCacheMemoryMb:
                          DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-full sm:w-28"
                    aria-label="Thread cache memory budget in megabytes"
                    value={String(settings.threadHydrationCacheMemoryMb)}
                    onChange={(event) => {
                      const nextValue = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(nextValue)) {
                        return;
                      }
                      updateSettings({
                        threadHydrationCacheMemoryMb: Math.max(1, nextValue),
                      });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">MB</span>
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection title="Keybindings">
            <SettingsRow
              title="Keybindings"
              description="Open the persisted `keybindings.json` file to edit advanced bindings directly, including workspace editor tabs and window commands."
              status={
                <>
                  <span className="block break-all font-mono text-[11px] text-foreground">
                    {keybindingsConfigPath ?? "Resolving keybindings path..."}
                  </span>
                  {openKeybindingsError ? (
                    <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
                  ) : (
                    <span className="mt-1 block">Opens in your preferred editor.</span>
                  )}
                </>
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!keybindingsConfigPath || isOpeningKeybindings}
                  onClick={openKeybindingsFile}
                >
                  {isOpeningKeybindings ? "Opening..." : "Open file"}
                </Button>
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isAboutPage ? (
        <SettingsSection title="Application">
          {isElectron ? (
            <AboutVersionSection />
          ) : (
            <SettingsRow
              title={<AboutVersionTitle />}
              description="Current version of the application."
            />
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  return <SettingsPanel page="general" />;
}

export function ChatSettingsPanel() {
  return <SettingsPanel page="chat" />;
}

export function EditorSettingsPanel() {
  return <SettingsPanel page="editor" />;
}

export function BrowserSettingsPanel() {
  return <SettingsPanel page="browser" />;
}

export function ModelsSettingsPanel() {
  return <SettingsPanel page="models" />;
}

export function ProvidersSettingsPanel() {
  return <SettingsPanel page="providers" />;
}

export function AdvancedSettingsPanel() {
  return <SettingsPanel page="advanced" />;
}

export function AboutSettingsPanel() {
  return <SettingsPanel page="about" />;
}

export function ArchivedThreadsPanel() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadId);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadId);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(thread.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(thread.id).catch((error) => {
                      toastManager.add({
                        type: "error",
                        title: "Failed to unarchive thread",
                        description: error instanceof Error ? error.message : "An error occurred.",
                      });
                    })
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
