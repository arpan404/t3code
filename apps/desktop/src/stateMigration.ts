import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

interface SyncDirent {
  isDirectory(): boolean;
}

interface SyncFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  readdirSync(path: string, options: { withFileTypes: true }): Array<SyncDirent & { name: string }>;
  cpSync(
    source: string,
    destination: string,
    options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean },
  ): void;
}

const defaultFs: SyncFs = FS;

function mergeLegacyDirectoryContentsSync(
  targetPath: string,
  legacyPath: string,
  fs: SyncFs,
): boolean {
  if (!fs.existsSync(legacyPath)) {
    return false;
  }

  fs.mkdirSync(targetPath, { recursive: true });
  let copiedAny = false;

  for (const entry of fs.readdirSync(legacyPath, { withFileTypes: true })) {
    const sourcePath = Path.join(legacyPath, entry.name);
    const nextTargetPath = Path.join(targetPath, entry.name);

    if (!fs.existsSync(nextTargetPath)) {
      fs.cpSync(sourcePath, nextTargetPath, { recursive: true, force: false, errorOnExist: false });
      copiedAny = true;
      continue;
    }

    if (entry.isDirectory()) {
      copiedAny = mergeLegacyDirectoryContentsSync(nextTargetPath, sourcePath, fs) || copiedAny;
    }
  }

  return copiedAny;
}

export function resolveDesktopBaseDir(options?: { homeDir?: string; fs?: SyncFs }): string {
  const homeDir = options?.homeDir ?? OS.homedir();
  const targetPath = Path.join(homeDir, ".ace");
  mergeLegacyDirectoryContentsSync(targetPath, Path.join(homeDir, ".t3"), options?.fs ?? defaultFs);
  return targetPath;
}

export function resolveDesktopUserDataPath(options: {
  platform: NodeJS.Platform;
  userDataDirName: string;
  legacyUserDataDirNames: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fs?: SyncFs;
}): string {
  const homeDir = options.homeDir ?? OS.homedir();
  const env = options.env ?? process.env;
  const fs = options.fs ?? defaultFs;
  const appDataBase =
    options.platform === "win32"
      ? env.APPDATA || Path.join(homeDir, "AppData", "Roaming")
      : options.platform === "darwin"
        ? Path.join(homeDir, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");

  const targetPath = Path.join(appDataBase, options.userDataDirName);
  for (const legacyName of options.legacyUserDataDirNames) {
    mergeLegacyDirectoryContentsSync(targetPath, Path.join(appDataBase, legacyName), fs);
  }

  return targetPath;
}
