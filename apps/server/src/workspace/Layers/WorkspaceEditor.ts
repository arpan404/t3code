import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  WorkspaceEditorDiagnostic,
  type WorkspaceEditorCloseBufferResult,
  type WorkspaceEditorSyncBufferResult,
} from "@ace/contracts";

import {
  WorkspaceEditor,
  WorkspaceEditorError,
  type WorkspaceEditorShape,
} from "../Services/WorkspaceEditor";
import { WorkspacePaths } from "../Services/WorkspacePaths";
import type { NeovimClient } from "neovim";

const NVIM_MIN_VERSION = "0.9.0";
const NVIM_STARTUP_ARGS = ["--headless", "--embed", "-n", "-i", "NONE"] as const;
const COMMON_NVIM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] as const;

const NVIM_BOOTSTRAP_LUA = String.raw`
local function ace_split_lines(contents)
  if contents == "" then
    return { "" }
  end
  local lines = vim.split(contents, "\n", { plain = true })
  if contents:sub(-1) == "\n" then
    table.remove(lines, #lines)
  end
  if #lines == 0 then
    return { "" }
  end
  return lines
end

local function ace_severity_name(severity)
  if severity == vim.diagnostic.severity.ERROR then
    return "error"
  end
  if severity == vim.diagnostic.severity.WARN then
    return "warning"
  end
  if severity == vim.diagnostic.severity.INFO then
    return "info"
  end
  return "hint"
end

if _G.__ace_editor == nil then
  _G.__ace_editor = {}

  function _G.__ace_editor.ensure_buffer(abs_path, cwd)
    vim.api.nvim_set_current_dir(cwd)

    local bufnr = vim.fn.bufnr(abs_path)
    if bufnr == -1 then
      bufnr = vim.fn.bufadd(abs_path)
    end

    vim.fn.bufload(bufnr)
    if vim.api.nvim_buf_get_name(bufnr) ~= abs_path then
      vim.api.nvim_buf_set_name(bufnr, abs_path)
    end

    vim.bo[bufnr].buflisted = true
    vim.bo[bufnr].bufhidden = "hide"
    vim.bo[bufnr].swapfile = false
    vim.bo[bufnr].undofile = false

    local filetype = vim.filetype.match({ filename = abs_path })
    if filetype and filetype ~= "" and vim.bo[bufnr].filetype ~= filetype then
      vim.bo[bufnr].filetype = filetype
    end

    if vim.b[bufnr].ace_initialized ~= true then
      vim.b[bufnr].ace_initialized = true
      vim.api.nvim_exec_autocmds("BufReadPost", { buffer = bufnr, modeline = false })
      vim.api.nvim_exec_autocmds("BufEnter", { buffer = bufnr, modeline = false })
      vim.api.nvim_exec_autocmds("FileType", { buffer = bufnr, modeline = false })
      vim.wait(120, function()
        return #vim.lsp.get_clients({ bufnr = bufnr }) > 0
      end, 20)
    end

    return bufnr
  end

  function _G.__ace_editor.sync_buffer(abs_path, cwd, contents)
    local bufnr = _G.__ace_editor.ensure_buffer(abs_path, cwd)
    local lines = ace_split_lines(contents)

    vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
    vim.api.nvim_exec_autocmds("TextChanged", { buffer = bufnr, modeline = false })
    vim.api.nvim_exec_autocmds("InsertLeave", { buffer = bufnr, modeline = false })
    vim.wait(180, function()
      return false
    end, 30)

    local diagnostics = {}
    for _, item in ipairs(vim.diagnostic.get(bufnr)) do
      local start_line = math.max(0, item.lnum or 0)
      local start_column = math.max(0, item.col or 0)
      local end_line = math.max(start_line, item.end_lnum or start_line)
      local end_column = math.max(start_column + 1, item.end_col or (start_column + 1))

      diagnostics[#diagnostics + 1] = {
        code = item.code and tostring(item.code) or nil,
        endColumn = end_column,
        endLine = end_line,
        message = tostring(item.message or ""),
        severity = ace_severity_name(item.severity),
        source = item.source and tostring(item.source) or nil,
        startColumn = start_column,
        startLine = start_line,
      }
    end

    return diagnostics
  end

  function _G.__ace_editor.close_buffer(abs_path)
    local bufnr = vim.fn.bufnr(abs_path)
    if bufnr ~= -1 and vim.api.nvim_buf_is_valid(bufnr) then
      pcall(vim.api.nvim_buf_delete, bufnr, { force = true })
    end
    return true
  end
end

return true
`;

interface WorkspaceEditorSession {
  readonly mutex: Semaphore.Semaphore;
  readonly nvim: NeovimClient;
  readonly proc: ChildProcessWithoutNullStreams;
}

function waitForProcessSpawn(proc: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleSpawn = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      proc.off("error", handleError);
      proc.off("spawn", handleSpawn);
    };

    proc.once("error", handleError);
    proc.once("spawn", handleSpawn);
  });
}

function waitForProcessExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (proc.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleDone = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      proc.off("exit", handleDone);
      proc.off("error", handleDone);
    };
    const timeout = setTimeout(handleDone, timeoutMs);

    proc.once("exit", handleDone);
    proc.once("error", handleDone);
  });
}

function snapshotConsoleMethods(): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const key of Object.keys(console)) {
    snapshot.set(key, Reflect.get(console, key));
  }
  return snapshot;
}

function restoreConsoleMethods(snapshot: Map<string, unknown>): void {
  for (const [key, value] of snapshot) {
    Reflect.set(console, key, value);
  }
}

function closeSession(session: WorkspaceEditorSession): Effect.Effect<void> {
  return Effect.gen(function* () {
    const quitExit = yield* Effect.exit(
      Effect.promise(() =>
        Promise.race([
          session.nvim.command("qa!"),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 150);
          }),
        ]),
      ),
    );

    if (Exit.isFailure(quitExit)) {
      yield* Effect.logWarning("workspace editor failed to send Neovim quit command", {
        cause: quitExit.cause,
      });
    }

    if (session.proc.exitCode === null && !session.proc.killed) {
      session.proc.kill("SIGTERM");
      yield* Effect.promise(() => waitForProcessExit(session.proc, 500));
    }

    if (session.proc.exitCode === null && !session.proc.killed) {
      session.proc.kill("SIGKILL");
      yield* Effect.promise(() => waitForProcessExit(session.proc, 250));
    }
  });
}

export const makeWorkspaceEditor = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths;
  const sessionsRef = yield* Ref.make(new Map<string, WorkspaceEditorSession>());

  yield* Effect.addFinalizer(() =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach([...sessions.values()], closeSession, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      Effect.ignore({ log: true }),
    ),
  );

  const createSession = Effect.fn("WorkspaceEditor.createSession")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceEditorSession, WorkspaceEditorError> {
    const { attach, findNvim } = yield* Effect.promise(() => import("neovim"));
    const resolvedBinary = findNvim({
      firstMatch: true,
      minVersion: NVIM_MIN_VERSION,
      dirs: [...COMMON_NVIM_DIRS],
      ...(typeof process.env.NVIM === "string" && process.env.NVIM.trim().length > 0
        ? { paths: [process.env.NVIM.trim()] }
        : {}),
    }).matches[0]?.path;

    if (!resolvedBinary) {
      return yield* new WorkspaceEditorError({
        cwd,
        detail: `Neovim ${NVIM_MIN_VERSION}+ was not found in PATH.`,
        operation: "workspaceEditor.findNvim",
      });
    }

    const proc = spawn(resolvedBinary, [...NVIM_STARTUP_ARGS], {
      cwd,
      env: { ...process.env },
      stdio: "pipe",
    });

    yield* Effect.tryPromise({
      try: () => waitForProcessSpawn(proc),
      catch: (cause) =>
        new WorkspaceEditorError({
          cause,
          cwd,
          detail: "Failed to spawn Neovim.",
          operation: "workspaceEditor.spawn",
        }),
    });

    const consoleSnapshot = snapshotConsoleMethods();
    const nvim = (() => {
      try {
        return attach({ proc });
      } finally {
        restoreConsoleMethods(consoleSnapshot);
      }
    })();

    yield* Effect.promise(() => nvim.channelId).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd,
            detail: "Failed to establish the Neovim IPC channel.",
            operation: "workspaceEditor.attach",
          }),
      ),
    );

    yield* Effect.promise(() => nvim.executeLua(NVIM_BOOTSTRAP_LUA, [])).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd,
            detail: "Failed to bootstrap the Neovim editor helpers.",
            operation: "workspaceEditor.bootstrap",
          }),
      ),
    );

    return {
      mutex: yield* Semaphore.make(1),
      nvim,
      proc,
    };
  });

  const getOrCreateSession = Effect.fn("WorkspaceEditor.getOrCreateSession")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceEditorSession, WorkspaceEditorError> {
    const existing = (yield* Ref.get(sessionsRef)).get(cwd);
    if (existing && existing.proc.exitCode === null) {
      return existing;
    }

    if (existing) {
      yield* closeSession(existing).pipe(Effect.ignore({ log: true }));
      yield* Ref.update(sessionsRef, (sessions) => {
        const next = new Map(sessions);
        next.delete(cwd);
        return next;
      });
    }

    const created = yield* createSession(cwd);
    yield* Ref.update(sessionsRef, (sessions) => {
      const next = new Map(sessions);
      next.set(cwd, created);
      return next;
    });
    return created;
  });

  const syncBuffer: WorkspaceEditorShape["syncBuffer"] = Effect.fn("WorkspaceEditor.syncBuffer")(
    function* (input) {
      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });
      const session = yield* getOrCreateSession(normalizedWorkspaceRoot);

      const rawDiagnostics = yield* session.mutex.withPermits(1)(
        Effect.promise(() =>
          session.nvim.executeLua("return _G.__ace_editor.sync_buffer(...)", [
            target.absolutePath,
            normalizedWorkspaceRoot,
            input.contents,
          ]),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceEditorError({
                cause,
                cwd: normalizedWorkspaceRoot,
                detail: "Failed to sync the workspace buffer through Neovim.",
                operation: "workspaceEditor.syncBuffer",
                relativePath: target.relativePath,
              }),
          ),
        ),
      );

      const diagnostics = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(Schema.Array(WorkspaceEditorDiagnostic))(rawDiagnostics),
        catch: (cause) =>
          new WorkspaceEditorError({
            cause,
            cwd: normalizedWorkspaceRoot,
            detail: "Neovim returned an invalid diagnostics payload.",
            operation: "workspaceEditor.decodeDiagnostics",
            relativePath: target.relativePath,
          }),
      });

      return {
        diagnostics,
        relativePath: target.relativePath,
      } satisfies WorkspaceEditorSyncBufferResult;
    },
  );

  const closeBuffer: WorkspaceEditorShape["closeBuffer"] = Effect.fn("WorkspaceEditor.closeBuffer")(
    function* (input) {
      const normalizedWorkspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });
      const existing = (yield* Ref.get(sessionsRef)).get(normalizedWorkspaceRoot);
      if (!existing || existing.proc.exitCode !== null) {
        return {
          relativePath: target.relativePath,
        } satisfies WorkspaceEditorCloseBufferResult;
      }

      yield* existing.mutex.withPermits(1)(
        Effect.promise(() =>
          existing.nvim.executeLua("return _G.__ace_editor.close_buffer(...)", [
            target.absolutePath,
          ]),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceEditorError({
                cause,
                cwd: normalizedWorkspaceRoot,
                detail: "Failed to close the workspace buffer through Neovim.",
                operation: "workspaceEditor.closeBuffer",
                relativePath: target.relativePath,
              }),
          ),
        ),
      );

      return {
        relativePath: target.relativePath,
      } satisfies WorkspaceEditorCloseBufferResult;
    },
  );

  return {
    closeBuffer,
    syncBuffer,
  } satisfies WorkspaceEditorShape;
});

export const WorkspaceEditorLive = Layer.effect(WorkspaceEditor, makeWorkspaceEditor);
