import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ManagedMcpLauncherName = "withmate-session" | "withmate-memory" | "withmate-glossary";

export type ManagedMcpLauncherSpec<
  TName extends ManagedMcpLauncherName = ManagedMcpLauncherName,
> = {
  name: TName;
  launcherFileName: `${TName}.cmd`;
  args: readonly ["mcp-server"];
  packagedCliRelativePath: string;
};

export const WITHMATE_SESSION_MCP_LAUNCHER_SPEC: ManagedMcpLauncherSpec<"withmate-session"> = {
  name: "withmate-session",
  launcherFileName: "withmate-session.cmd",
  args: ["mcp-server"],
  packagedCliRelativePath: "resources/cli/withmate-session/withmate-session.mjs",
};

export const WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC: ManagedMcpLauncherSpec<"withmate-glossary"> = {
  name: "withmate-glossary",
  launcherFileName: "withmate-glossary.cmd",
  args: ["mcp-server"],
  packagedCliRelativePath: "resources/skills/withmate-glossary/bin/withmate-glossary.mjs",
};

export const WITHMATE_MEMORY_MCP_LAUNCHER_SPEC: ManagedMcpLauncherSpec<"withmate-memory"> = {
  name: "withmate-memory",
  launcherFileName: "withmate-memory.cmd",
  args: ["mcp-server"],
  packagedCliRelativePath: "resources/cli/withmate-memory.mjs",
};

export type ManagedMcpLauncherPaths = {
  launcherPath: string;
  packagedCliPath: string;
};

export function resolveManagedMcpLauncherPaths(input: {
  spec: ManagedMcpLauncherSpec;
  executablePath: string;
  resourcesPath: string;
}): ManagedMcpLauncherPaths | null {
  if (!input.executablePath.trim() || !input.resourcesPath.trim()) return null;
  return {
    launcherPath: path.join(path.dirname(input.executablePath), input.spec.launcherFileName),
    packagedCliPath: path.join(input.resourcesPath, input.spec.packagedCliRelativePath),
  };
}

export function isExpectedManagedMcpLauncherContent(input: {
  content: string;
  executablePath: string;
  packagedCliPath: string;
}): boolean {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 5
    || lines[0].toLocaleLowerCase("en-US") !== "@echo off"
    || lines[1].toLocaleLowerCase("en-US") !== "setlocal"
    || lines[2].toLocaleLowerCase("en-US") !== "set electron_run_as_node=1"
    || lines[4].toLocaleLowerCase("en-US") !== "exit /b %errorlevel%") {
    return false;
  }

  const invocation = /^"(?:%~dp0)?([^"]+)" "(?:%~dp0)?([^"]+)" %\*$/.exec(lines[3] ?? "");
  const installRoot = path.dirname(input.executablePath);
  return invocation !== null
    && sameWindowsPath(path.resolve(installRoot, invocation[1]), input.executablePath)
    && sameWindowsPath(path.resolve(installRoot, invocation[2]), input.packagedCliPath);
}

export function resolveVerifiedManagedMcpLauncher(input: {
  spec: ManagedMcpLauncherSpec;
  isPackagedApp: boolean;
  platform?: NodeJS.Platform;
  executablePath?: string;
  resourcesPath?: string;
  fileExists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
}): string | null {
  if (!input.isPackagedApp || (input.platform ?? process.platform) !== "win32") return null;
  const executablePath = input.executablePath ?? process.execPath;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const paths = resolveManagedMcpLauncherPaths({ spec: input.spec, executablePath, resourcesPath });
  if (!paths) return null;

  const fileExists = input.fileExists ?? existsSync;
  if (!fileExists(paths.launcherPath) || !fileExists(paths.packagedCliPath)) return null;
  try {
    const content = (input.readTextFile ?? ((filePath) => readFileSync(filePath, "utf8")))(paths.launcherPath);
    return isExpectedManagedMcpLauncherContent({
      content,
      executablePath,
      packagedCliPath: paths.packagedCliPath,
    }) ? paths.launcherPath : null;
  } catch {
    return null;
  }
}

export function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLocaleLowerCase("en-US") === path.win32.normalize(right).toLocaleLowerCase("en-US");
}
