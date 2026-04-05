import { type ContextMenuItem, type NativeApi } from "@ace/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { runAsyncTask } from "./lib/async";
import { resetServerStateForTests } from "./rpc/serverState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;
let disposeHandlerRegistered = false;

export function __resetWsNativeApiForTests() {
  instance = null;
  disposeHandlerRegistered = false;
  __resetWsRpcClientForTests();
  resetServerStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = getWsRpcClient();
  if (
    !disposeHandlerRegistered &&
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    const disposeRpcClient = () => {
      runAsyncTask(
        rpcClient.dispose(),
        "Failed to dispose the WebSocket RPC client during page teardown.",
      );
    };
    window.addEventListener("pagehide", disposeRpcClient, { once: true });
    window.addEventListener("beforeunload", disposeRpcClient, { once: true });
    disposeHandlerRegistered = true;
  }

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    browser: {
      repairStorage: async () => {
        if (!window.desktopBridge) {
          return false;
        }
        return window.desktopBridge.repairBrowserStorage();
      },
    },
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      listTree: rpcClient.projects.listTree,
      createEntry: rpcClient.projects.createEntry,
      deleteEntry: rpcClient.projects.deleteEntry,
      readFile: rpcClient.projects.readFile,
      renameEntry: rpcClient.projects.renameEntry,
      writeFile: rpcClient.projects.writeFile,
    },
    workspaceEditor: {
      syncBuffer: rpcClient.workspaceEditor.syncBuffer,
      closeBuffer: rpcClient.workspaceEditor.closeBuffer,
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: rpcClient.git.pull,
      status: rpcClient.git.status,
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      searchOpenCodeModels: rpcClient.server.searchOpenCodeModels,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
    },
    orchestration: {
      getSnapshot: (input) => rpcClient.orchestration.getSnapshot(input),
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration
          .replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) => rpcClient.orchestration.onDomainEvent(callback),
    },
  };

  instance = { api };
  return api;
}
