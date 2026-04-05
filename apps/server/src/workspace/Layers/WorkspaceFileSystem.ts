import { Effect, FileSystem, Layer, Path } from "effect";
import { PROJECT_READ_FILE_MAX_BYTES } from "@t3tools/contracts";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const statOrNull = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(Effect.catch(() => Effect.succeed(null)));

  const invalidateWorkspaceEntries = (cwd: string) => workspaceEntries.invalidate(cwd);

  const failAlreadyExists = (input: { cwd: string; relativePath: string }, operation: string) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail: "An entry already exists at that path.",
    });

  const failMissingEntry = (input: { cwd: string; relativePath: string }, operation: string) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail: "That workspace entry no longer exists.",
    });

  const createEntry: WorkspaceFileSystemShape["createEntry"] = Effect.fn(
    "WorkspaceFileSystem.createEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const existing = yield* statOrNull(target.absolutePath);
    if (existing) {
      return yield* failAlreadyExists(input, "workspaceFileSystem.createEntry");
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    if (input.kind === "directory") {
      yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.createDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
    } else {
      yield* fileSystem.writeFileString(target.absolutePath, "").pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.createFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
    }

    yield* invalidateWorkspaceEntries(input.cwd);
    return {
      kind: input.kind,
      relativePath: target.relativePath,
    };
  });

  const deleteEntry: WorkspaceFileSystemShape["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const existing = yield* statOrNull(target.absolutePath);
    if (!existing) {
      return yield* failMissingEntry(input, "workspaceFileSystem.deleteEntry");
    }

    yield* fileSystem.remove(target.absolutePath, { force: true, recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.deleteEntry",
            detail: cause.message,
            cause,
          }),
      ),
    );

    yield* invalidateWorkspaceEntries(input.cwd);
    return { relativePath: target.relativePath };
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const stats = yield* fileSystem.stat(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.stat",
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (stats.type !== "File") {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Only regular text files can be opened in the editor.",
        });
      }

      if (stats.size > PROJECT_READ_FILE_MAX_BYTES) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: `Files larger than ${Math.round(PROJECT_READ_FILE_MAX_BYTES / (1024 * 1024))}MB are not opened in the in-app editor.`,
        });
      }

      const bytes = yield* fileSystem.readFile(target.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readFile",
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (bytes.some((value) => value === 0)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Binary files are not supported in the in-app editor.",
        });
      }

      const contents = yield* Effect.try({
        try: () => utf8Decoder.decode(bytes),
        catch: () =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: "Only UTF-8 text files are supported in the in-app editor.",
          }),
      });

      return {
        relativePath: target.relativePath,
        contents,
        sizeBytes: bytes.byteLength,
      };
    },
  );

  const renameEntry: WorkspaceFileSystemShape["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.nextRelativePath,
    });

    if (source.relativePath === target.relativePath) {
      return {
        previousRelativePath: source.relativePath,
        relativePath: target.relativePath,
      };
    }

    const sourceStat = yield* statOrNull(source.absolutePath);
    if (!sourceStat) {
      return yield* failMissingEntry(input, "workspaceFileSystem.renameEntry");
    }

    const targetStat = yield* statOrNull(target.absolutePath);
    if (targetStat) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.nextRelativePath,
        operation: "workspaceFileSystem.renameEntry",
        detail: "An entry already exists at the destination path.",
      });
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.nextRelativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );

    yield* fileSystem.rename(source.absolutePath, target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.renameEntry",
            detail: cause.message,
            cause,
          }),
      ),
    );

    yield* invalidateWorkspaceEntries(input.cwd);
    return {
      previousRelativePath: source.relativePath,
      relativePath: target.relativePath,
    };
  });

  return {
    createEntry,
    deleteEntry,
    readFile,
    renameEntry,
    writeFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
