import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type NativeApi,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { GeneralSettingsPanel } from "./SettingsPanels";

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function createCursorProvider(): ServerProvider {
  return {
    provider: "cursor",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "gpt-5.2-codex",
          familyName: "GPT-5.2 Codex",
          fastMode: false,
          thinking: false,
          maxMode: false,
        },
      },
      {
        slug: "gpt-5.2-codex-high",
        name: "GPT-5.2 Codex High",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "gpt-5.2-codex",
          familyName: "GPT-5.2 Codex",
          reasoningEffort: "high",
          fastMode: false,
          thinking: false,
          maxMode: false,
        },
      },
      {
        slug: "composer-2",
        name: "Composer 2",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "composer-2",
          familyName: "Composer 2",
          fastMode: false,
          thinking: false,
          maxMode: false,
        },
      },
      {
        slug: "composer-2-fast",
        name: "Composer 2 Fast",
        isCustom: false,
        capabilities: null,
        cursorMetadata: {
          familySlug: "composer-2",
          familyName: "Composer 2",
          fastMode: true,
          thinking: false,
          maxMode: false,
        },
      },
    ],
  };
}

function createCursorTextGenerationConfig(model: string): ServerConfig {
  return {
    ...createBaseServerConfig(),
    providers: [createCursorProvider()],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        provider: "cursor",
        model,
      },
    },
  };
}

describe("GeneralSettingsPanel observability", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.t3/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<NativeApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as NativeApi;

    setServerConfigSnapshot(createBaseServerConfig());

    await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });

  it("updates Cursor text generation reasoning selections", async () => {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      server: {
        updateSettings,
      },
    } as unknown as NativeApi;

    setServerConfigSnapshot(createCursorTextGenerationConfig("gpt-5.2-codex"));

    const screen = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const traitsTrigger = page.getByRole("button", { name: "Medium" });
    await expect.element(traitsTrigger).toBeInTheDocument();

    await traitsTrigger.click();
    await page.getByRole("menuitemradio", { name: "High" }).click();

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          textGenerationModelSelection: {
            provider: "cursor",
            model: "gpt-5.2-codex-high",
          },
        }),
      );
    });
    await expect.element(page.getByRole("button", { name: "High" })).toBeInTheDocument();
    await screen.unmount();
  });

  it("updates Cursor text generation fast-mode selections", async () => {
    const updateSettings = vi
      .fn<NativeApi["server"]["updateSettings"]>()
      .mockResolvedValue(DEFAULT_SERVER_SETTINGS);
    window.nativeApi = {
      server: {
        updateSettings,
      },
    } as unknown as NativeApi;

    setServerConfigSnapshot(createCursorTextGenerationConfig("composer-2"));

    const screen = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const traitsTrigger = page.getByRole("button", { name: "Fast Off" });
    await expect.element(traitsTrigger).toBeInTheDocument();

    await traitsTrigger.click();
    await page.getByRole("menuitemradio", { name: "on" }).click();

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          textGenerationModelSelection: {
            provider: "cursor",
            model: "composer-2-fast",
          },
        }),
      );
    });
    await expect.element(page.getByRole("button", { name: "Fast On" })).toBeInTheDocument();
    await screen.unmount();
  });
});
