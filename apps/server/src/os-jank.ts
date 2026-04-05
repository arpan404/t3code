import * as FS from "node:fs";
import * as OS from "node:os";
import { Effect, Path } from "effect";
import { readPathFromLoginShell, resolveLoginShell } from "@ace/shared/shell";

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  const env = options.env ?? process.env;

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;
    const result = (options.readPath ?? readPathFromLoginShell)(shell);
    if (result) {
      env.PATH = result;
    }
  } catch {
    // Silently ignore — keep default PATH
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
  }
  return input;
});

function mergeLegacyDirectoryContentsSync(targetPath: string, legacyPath: string): boolean {
  if (!FS.existsSync(legacyPath)) {
    return false;
  }

  FS.mkdirSync(targetPath, { recursive: true });
  let copiedAny = false;

  for (const entry of FS.readdirSync(legacyPath, { withFileTypes: true })) {
    const sourcePath =
      OS.platform() === "win32" ? `${legacyPath}\\${entry.name}` : `${legacyPath}/${entry.name}`;
    const nextTargetPath =
      OS.platform() === "win32" ? `${targetPath}\\${entry.name}` : `${targetPath}/${entry.name}`;

    if (!FS.existsSync(nextTargetPath)) {
      FS.cpSync(sourcePath, nextTargetPath, { recursive: true, force: false, errorOnExist: false });
      copiedAny = true;
      continue;
    }

    if (entry.isDirectory()) {
      copiedAny = mergeLegacyDirectoryContentsSync(nextTargetPath, sourcePath) || copiedAny;
    }
  }

  return copiedAny;
}

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  const homeDir = OS.homedir();
  const defaultBaseDir = join(homeDir, ".ace");

  if (!raw || raw.trim().length === 0) {
    mergeLegacyDirectoryContentsSync(defaultBaseDir, join(homeDir, ".t3"));
    return defaultBaseDir;
  }

  const resolved = resolve(yield* expandHomePath(raw.trim()));
  if (resolved === defaultBaseDir) {
    mergeLegacyDirectoryContentsSync(defaultBaseDir, join(homeDir, ".t3"));
  }

  return resolved;
});
