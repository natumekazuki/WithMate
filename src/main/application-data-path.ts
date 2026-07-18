import os from "node:os";
import path from "node:path";

const APPLICATION_DIRECTORY_NAME = "WithMate";
const DATABASE_FILE_NAME = "withmate.sqlite3";
const SESSION_FILES_DIRECTORY_NAME = "session-files";

export function resolveApplicationDataRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  if (platform === "win32")
    return absoluteEnvironmentPath(environment.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support");
  return absoluteEnvironmentPath(environment.XDG_CONFIG_HOME) ?? path.join(homeDirectory, ".config");
}

export function resolveWithMateApplicationDirectory(
  applicationDataRoot: string = resolveApplicationDataRoot(),
): string {
  return path.join(applicationDataRoot, APPLICATION_DIRECTORY_NAME);
}

export function resolveWithMateDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  return resolveWithMateDatabasePathFromRoot(resolveApplicationDataRoot(environment, platform, homeDirectory));
}

export function resolveWithMateDatabasePathFromRoot(applicationDataRoot: string): string {
  return path.join(resolveWithMateApplicationDirectory(applicationDataRoot), DATABASE_FILE_NAME);
}

export function resolveWithMateSessionFilesRoot(applicationDataRoot: string = resolveApplicationDataRoot()): string {
  return path.join(resolveWithMateApplicationDirectory(applicationDataRoot), SESSION_FILES_DIRECTORY_NAME);
}

function absoluteEnvironmentPath(value: string | undefined): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? path.normalize(value) : undefined;
}
