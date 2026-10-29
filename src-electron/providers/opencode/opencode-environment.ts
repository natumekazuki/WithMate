import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const OPENCODE_VERSION = "2.1.4";

export type OpenCodeEnvironmentOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  signal?: AbortSignal;
};

export type OpenCodeEnvironment = { executable: string; databasePath: string; env: NodeJS.ProcessEnv };
type CommandOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };
type EnvironmentDependencies = {
  platform?: NodeJS.Platform;
  runCommand?: (executable: string, args: readonly string[], options: CommandOptions) => Promise<string>;
};

export async function resolveOpenCodeEnvironment(
  options: OpenCodeEnvironmentOptions,
  dependencies: EnvironmentDependencies = {},
): Promise<OpenCodeEnvironment> {
  if (!path.isAbsolute(options.cwd) || (options.executable !== undefined && !path.isAbsolute(options.executable))) {
    throw new TypeError("OpenCode executable and workspace paths must be absolute.");
  }
  options.signal?.throwIfAborted();
  const env = { ...(options.env ?? process.env) };
  const executable = await resolveExecutable(options.executable, env, dependencies.platform ?? process.platform);
  const run = dependencies.runCommand ?? runCommand;
  const commandOptions = { cwd: options.cwd, env, signal: options.signal };
  // Neither command opens the database; reject incompatible CLI versions before serve can migrate it.
  const version = (await run(executable, ["--version"], commandOptions)).trim();
  if (version !== `opencode v${OPENCODE_VERSION}`) throw new Error(`OpenCode CLI ${OPENCODE_VERSION} is required. Use compatible WithMate and OpenCode versions; do not downgrade an existing OpenCode database.`);
  const databasePath = (await run(executable, ["debug", "paths", "db"], commandOptions)).trim();
  if (!path.isAbsolute(databasePath) || /[\r\n\0]/u.test(databasePath)) {
    throw new Error("OpenCode CLI did not report an absolute database path.");
  }
  options.signal?.throwIfAborted();
  return { executable, databasePath: path.resolve(databasePath), env };
}

async function resolveExecutable(explicit: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
  if (explicit !== undefined) return nativeExecutable(explicit, platform);
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const pathExtensions = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1] ?? ".COM;.EXE;.BAT;.CMD";
  const names = platform === "win32"
    ? [...pathExtensions.split(";").filter(extension => /^\.[a-z0-9]+$/iu.test(extension)).map(extension => `opencode${extension.toLowerCase()}`), "opencode"]
    : ["opencode"];
  for (const directory of searchPath.split(platform === "win32" ? ";" : ":")) {
    // Do not implicitly search the current directory or resolve relative PATH entries against a workspace.
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try { await access(candidate); } catch { continue; }
      // The first installed command owns this PATH position. Never bypass an unsupported shim.
      return nativeExecutable(candidate, platform);
    }
  }
  throw new Error(`OpenCode CLI ${OPENCODE_VERSION} was not found on PATH. Install the official OpenCode CLI on this PC.`);
}

async function nativeExecutable(candidate: string, platform: NodeJS.Platform): Promise<string> {
  if (platform !== "win32" || path.extname(candidate).toLowerCase() === ".exe") return realpath(candidate);
  if (path.extname(candidate).toLowerCase() !== ".cmd") throw new Error("The OpenCode command is not a supported native executable or official npm shim.");
  const shim = (await readFile(candidate, "utf8")).replace(/\r\n/gu, "\n").trim();
  // npm's native-bin shim has no shell logic beyond this fixed launcher. Do not execute or reinterpret arbitrary scripts.
  const official = /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode\.exe"\s+%\*$/iu;
  if (!official.test(shim)) throw new Error("The OpenCode command is not a recognized official npm shim. Use the native OpenCode executable.");
  const root = path.join(path.dirname(candidate), "node_modules", "@opencode", "cli");
  const metadata: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== "@opencode/cli"
    || !("bin" in metadata) || !metadata.bin || typeof metadata.bin !== "object"
    || !("opencode" in metadata.bin) || metadata.bin.opencode !== "./bin/opencode.exe") {
    throw new Error("The OpenCode npm shim does not refer to the official CLI package.");
  }
  return realpath(path.join(root, "bin", "opencode.exe"));
}

function runCommand(executable: string, args: readonly string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { ...options, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        if (options.signal?.aborted) { reject(new DOMException("OpenCode environment lookup aborted.", "AbortError")); return; }
        // stdout/stderr may include environment-derived secrets; never include them in the public error.
        reject(new Error("OpenCode CLI environment lookup failed. Check the PC installation and configuration."));
        return;
      }
      resolve(stdout);
    });
  });
}
