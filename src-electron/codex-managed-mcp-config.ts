import { execFile } from "node:child_process";

import {
  resolveVerifiedManagedMcpLauncher,
  sameWindowsPath,
  WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC,
  WITHMATE_MEMORY_MCP_LAUNCHER_SPEC,
  type ManagedMcpLauncherSpec,
} from "./managed-mcp-launcher.js";
import {
  mergeDefinedProviderEnv,
  WITHMATE_CODEX_MCP_BINDING_ENV_VARS,
} from "./provider-agent-runtime-binding.js";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  cwd: string;
  env: Record<string, string>;
};

export type CodexManagedMcpRecord = {
  name?: unknown;
  enabled?: unknown;
  disabled_reason?: unknown;
  startup_timeout_sec?: unknown;
  tool_timeout_sec?: unknown;
  enabled_tools?: unknown;
  disabled_tools?: unknown;
  transport?: {
    type?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    env_vars?: unknown;
    cwd?: unknown;
  };
};

export function isExactCodexManagedMcpRecord(input: {
  record: CodexManagedMcpRecord;
  mcpName: string;
  command: string;
  args: readonly string[];
  acceptedEnvVars?: readonly string[];
}): boolean {
  const { record } = input;
  return record.name === input.mcpName
    && record.enabled === true
    && (record.disabled_reason === undefined || record.disabled_reason === null)
    && record.transport?.type === "stdio"
    && typeof record.transport.command === "string"
    && sameWindowsPath(record.transport.command, input.command)
    && Array.isArray(record.transport.args)
    && record.transport.args.length === input.args.length
    && record.transport.args.every((arg, index) => arg === input.args[index])
    && (record.transport.env === undefined || record.transport.env === null)
    && isAcceptedCodexEnvVars(record.transport.env_vars, input.acceptedEnvVars)
    && (record.transport.cwd === undefined || record.transport.cwd === null)
    && (record.startup_timeout_sec === undefined || record.startup_timeout_sec === null)
    && (record.tool_timeout_sec === undefined || record.tool_timeout_sec === null)
    && (record.enabled_tools === undefined || record.enabled_tools === null)
    && (record.disabled_tools === undefined
      || record.disabled_tools === null
      || (Array.isArray(record.disabled_tools) && record.disabled_tools.length === 0));
}

function isAcceptedCodexEnvVars(
  candidate: unknown,
  acceptedEnvVars: readonly string[] | undefined,
): boolean {
  if (candidate === undefined) return true;
  if (!Array.isArray(candidate)) return false;
  if (candidate.length === 0) return true;
  if (!acceptedEnvVars || candidate.length !== acceptedEnvVars.length) return false;
  if (!candidate.every((entry): entry is string => typeof entry === "string")) return false;
  const unique = new Set(candidate);
  return unique.size === candidate.length
    && acceptedEnvVars.every((expected) => unique.has(expected));
}

type ManagedCodexMcpSpec = {
  mcpName: "withmate-character-context" | "withmate-glossary";
  launcher: ManagedMcpLauncherSpec;
};

const MANAGED_CODEX_MCP_SPECS: readonly ManagedCodexMcpSpec[] = [
  {
    mcpName: "withmate-character-context",
    launcher: WITHMATE_MEMORY_MCP_LAUNCHER_SPEC,
  },
  {
    mcpName: "withmate-glossary",
    launcher: WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC,
  },
];

export type CodexManagedMcpConfigServiceDeps = {
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  executablePath?: string;
  resourcesPath?: string;
  processEnv?: NodeJS.ProcessEnv;
  fileExists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
  runCommand?: (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
};

export class CodexManagedMcpConfigService {
  constructor(private readonly deps: CodexManagedMcpConfigServiceDeps) {}

  async resolve(input: {
    codexPath: string | null;
    workspacePath: string;
  }): Promise<string[]> {
    if (!this.deps.isPackagedApp() || (this.deps.platform ?? process.platform) !== "win32") {
      return [];
    }
    if (!input.codexPath?.trim()) {
      throw new Error("Codex executable is unavailable for managed MCP configuration.");
    }
    if (!input.workspacePath.trim()) {
      throw new Error("Codex workspace is unavailable for managed MCP configuration.");
    }

    const managedServers = MANAGED_CODEX_MCP_SPECS.map((spec) => ({
      spec,
      command: this.resolveVerifiedLauncher(spec.launcher),
    }));
    if (managedServers.some(({ command }) => command === null)) {
      throw new Error("WithMate-managed MCP launchers could not be verified.");
    }

    const inspectionEnv = mergeDefinedProviderEnv(this.deps.processEnv ?? process.env, {});
    const listResult = await this.run(input.codexPath, [
      "-C",
      input.workspacePath,
      "mcp",
      "list",
      "--json",
    ], {
      cwd: input.workspacePath,
      env: inspectionEnv,
    });
    const listedRecords = parseCodexMcpList(listResult);

    for (const managed of managedServers) {
      const listed = listedRecords.filter((record) => record.name === managed.spec.mcpName);
      if (listed.length > 1) {
        throw inspectionError();
      }
      if (listed.length === 0) continue;

      const getResult = await this.run(input.codexPath, [
        "-C",
        input.workspacePath,
        "mcp",
        "get",
        managed.spec.mcpName,
        "--json",
      ], {
        cwd: input.workspacePath,
        env: inspectionEnv,
      });
      const record = parseCodexMcpRecord(getResult);
      if (!isExactCodexManagedMcpRecord({
        record,
        mcpName: managed.spec.mcpName,
        command: managed.command!,
        args: managed.spec.launcher.args,
        acceptedEnvVars: WITHMATE_CODEX_MCP_BINDING_ENV_VARS,
      })) {
        throw new Error(`Codex MCP ${managed.spec.mcpName} is disabled or conflicts with the WithMate-managed transport.`);
      }
    }

    return managedServers.map(({ spec, command }) => buildManagedMcpConfigOverride({
      mcpName: spec.mcpName,
      command: command!,
      args: spec.launcher.args,
    }));
  }

  private resolveVerifiedLauncher(spec: ManagedMcpLauncherSpec): string | null {
    return resolveVerifiedManagedMcpLauncher({
      spec,
      isPackagedApp: true,
      platform: this.deps.platform ?? process.platform,
      executablePath: this.deps.executablePath ?? process.execPath,
      resourcesPath: this.deps.resourcesPath ?? process.resourcesPath,
      ...(this.deps.fileExists ? { fileExists: this.deps.fileExists } : {}),
      ...(this.deps.readTextFile ? { readTextFile: this.deps.readTextFile } : {}),
    });
  }

  private async run(
    command: string,
    args: string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    try {
      return await (this.deps.runCommand ?? runCommand)(command, args, options);
    } catch {
      throw inspectionError();
    }
  }
}

function parseCodexMcpList(result: CommandResult): CodexManagedMcpRecord[] {
  if (result.exitCode !== 0) throw inspectionError();
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)
      || !parsed.every((record) => record && typeof record === "object" && !Array.isArray(record))) {
      throw inspectionError();
    }
    return parsed as CodexManagedMcpRecord[];
  } catch {
    throw inspectionError();
  }
}

function parseCodexMcpRecord(result: CommandResult): CodexManagedMcpRecord {
  if (result.exitCode !== 0) throw inspectionError();
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw inspectionError();
    return parsed as CodexManagedMcpRecord;
  } catch {
    throw inspectionError();
  }
}

function inspectionError(): Error {
  return new Error("Codex MCP configuration could not be inspected.");
}

function buildManagedMcpConfigOverride(input: {
  mcpName: string;
  command: string;
  args: readonly string[];
}): string {
  const args = input.args.map(toTomlString).join(", ");
  const envVars = WITHMATE_CODEX_MCP_BINDING_ENV_VARS.map(toTomlString).join(", ");
  return `mcp_servers.${input.mcpName}={ enabled = true, command = ${toTomlString(input.command)}, args = [${args}], env_vars = [${envVars}] }`;
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
      resolve({
        exitCode,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}
