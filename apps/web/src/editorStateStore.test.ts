import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_EDITOR_TREE_WIDTH,
  selectThreadEditorState,
  useEditorStateStore,
} from "./editorStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");

describe("editorStateStore actions", () => {
  beforeEach(() => {
    useEditorStateStore.persist.clearStorage();
    useEditorStateStore.setState({
      runtimeStateByThreadId: {},
      threadStateByThreadId: {},
    });
  });

  it("returns a single-pane default editor state for unknown threads", () => {
    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );
    expect(editorState).toEqual({
      activePaneId: "pane-1",
      draftsByFilePath: {},
      expandedDirectoryPaths: [],
      paneRatios: [1],
      panes: [{ activeFilePath: null, id: "pane-1", openFilePaths: [] }],
      treeWidth: DEFAULT_THREAD_EDITOR_TREE_WIDTH,
    });
  });

  it("reuses the selected editor state reference when the thread slice is unchanged", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const state = useEditorStateStore.getState();
    const firstEditorState = selectThreadEditorState(
      state.threadStateByThreadId,
      state.runtimeStateByThreadId,
      THREAD_ID,
    );
    const secondEditorState = selectThreadEditorState(
      state.threadStateByThreadId,
      state.runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(secondEditorState).toBe(firstEditorState);
  });

  it("keeps the selected editor state stable across unrelated thread updates", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const stateBeforeUnrelatedUpdate = useEditorStateStore.getState();
    const editorStateBeforeUnrelatedUpdate = selectThreadEditorState(
      stateBeforeUnrelatedUpdate.threadStateByThreadId,
      stateBeforeUnrelatedUpdate.runtimeStateByThreadId,
      THREAD_ID,
    );

    store.openFile(OTHER_THREAD_ID, "src/other.ts");

    const stateAfterUnrelatedUpdate = useEditorStateStore.getState();
    const editorStateAfterUnrelatedUpdate = selectThreadEditorState(
      stateAfterUnrelatedUpdate.threadStateByThreadId,
      stateAfterUnrelatedUpdate.runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorStateAfterUnrelatedUpdate).toBe(editorStateBeforeUnrelatedUpdate);
  });

  it("splits the active pane into a new window carrying the active file", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");

    const paneId = store.splitPane(THREAD_ID);
    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(paneId).toBe("pane-2");
    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.paneRatios).toEqual([0.5, 0.5]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
      { activeFilePath: "src/main.ts", id: "pane-2", openFilePaths: ["src/main.ts"] },
    ]);
  });

  it("opens files inside the explicitly targeted pane", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    const paneId = store.splitPane(THREAD_ID);
    expect(paneId).toBe("pane-2");

    store.setActivePane(THREAD_ID, "pane-1");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts"],
      },
      {
        activeFilePath: "src/sidebar.ts",
        id: "pane-2",
        openFilePaths: ["src/main.ts", "src/sidebar.ts"],
      },
    ]);
  });

  it("reorders tabs within a pane while keeping the moved tab active", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.moveFile(THREAD_ID, {
      filePath: "src/sidebar.ts",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-1",
      targetIndex: 0,
    });

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-1");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/sidebar.ts",
        id: "pane-1",
        openFilePaths: ["src/sidebar.ts", "src/main.ts", "src/utils.ts"],
      },
    ]);
  });

  it("moves tabs across panes and repairs source-pane selection", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.splitPane(THREAD_ID);
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    store.moveFile(THREAD_ID, {
      filePath: "src/utils.ts",
      sourcePaneId: "pane-1",
      targetPaneId: "pane-2",
      targetIndex: 1,
    });

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/main.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts"],
      },
      {
        activeFilePath: "src/utils.ts",
        id: "pane-2",
        openFilePaths: ["src/sidebar.ts", "src/utils.ts"],
      },
    ]);
  });

  it("closes other tabs while preserving the selected tab", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.closeOtherFiles(THREAD_ID, "src/utils.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/utils.ts"],
      },
    ]);
  });

  it("closes tabs to the right and repairs active selection if needed", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");
    store.openFile(THREAD_ID, "src/routes.ts");

    store.closeFilesToRight(THREAD_ID, "src/utils.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts"],
      },
    ]);
  });

  it("reopens the most recently closed tab in its prior pane position", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils.ts");
    store.openFile(THREAD_ID, "src/sidebar.ts");

    store.closeFile(THREAD_ID, "src/utils.ts");
    const reopenedPath = store.reopenClosedFile(THREAD_ID);

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(reopenedPath).toBe("src/utils.ts");
    expect(editorState.panes).toEqual([
      {
        activeFilePath: "src/utils.ts",
        id: "pane-1",
        openFilePaths: ["src/main.ts", "src/utils.ts", "src/sidebar.ts"],
      },
    ]);
  });

  it("closes panes while keeping a valid active pane and normalized ratios", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.splitPane(THREAD_ID);

    store.closePane(THREAD_ID, "pane-1");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.activePaneId).toBe("pane-2");
    expect(editorState.paneRatios).toEqual([1]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-2", openFilePaths: ["src/main.ts"] },
    ]);
  });

  it("prunes invalid file references across panes without dropping the split layout", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.splitPane(THREAD_ID);
    store.openFile(THREAD_ID, "src/sidebar.ts", "pane-2");

    store.syncTree(THREAD_ID, ["src", "src/sidebar.ts"]);

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.paneRatios).toEqual([0.5, 0.5]);
    expect(editorState.panes).toEqual([
      { activeFilePath: null, id: "pane-1", openFilePaths: [] },
      { activeFilePath: "src/sidebar.ts", id: "pane-2", openFilePaths: ["src/sidebar.ts"] },
    ]);
  });

  it("renames open file references and preserved drafts", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.hydrateFile(THREAD_ID, "src/main.ts", "export const value = 1;\n");
    store.updateDraft(THREAD_ID, "src/main.ts", "export const value = 2;\n");

    store.renameEntry(THREAD_ID, "src/main.ts", "src/app.ts");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.panes).toEqual([
      { activeFilePath: "src/app.ts", id: "pane-1", openFilePaths: ["src/app.ts"] },
    ]);
    expect(editorState.draftsByFilePath).toEqual({
      "src/app.ts": {
        draftContents: "export const value = 2;\n",
        savedContents: "export const value = 1;\n",
      },
    });
  });

  it("removes deleted directory references from panes and drafts", () => {
    const store = useEditorStateStore.getState();
    store.openFile(THREAD_ID, "src/main.ts");
    store.openFile(THREAD_ID, "src/utils/helpers.ts");
    store.hydrateFile(THREAD_ID, "src/utils/helpers.ts", "export const help = true;\n");
    store.expandDirectories(THREAD_ID, ["src", "src/utils"]);

    store.removeEntry(THREAD_ID, "src/utils");

    const editorState = selectThreadEditorState(
      useEditorStateStore.getState().threadStateByThreadId,
      useEditorStateStore.getState().runtimeStateByThreadId,
      THREAD_ID,
    );

    expect(editorState.expandedDirectoryPaths).toEqual(["src"]);
    expect(editorState.panes).toEqual([
      { activeFilePath: "src/main.ts", id: "pane-1", openFilePaths: ["src/main.ts"] },
    ]);
    expect(editorState.draftsByFilePath).toEqual({});
  });
});
