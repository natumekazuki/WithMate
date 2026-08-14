import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ManagedSessionSkillSyncResult } from "./managed-session-skill-service.js";
import type {
  CodexSessionMcpRegistrationDiagnostics,
  SessionCliLauncherDiagnostics,
  SessionIntegrationDiagnostics,
  SessionSkillSyncDiagnostics,
} from "../src/session-integration-diagnostics-state.js";

const MCP_NAME = "withmate-session";
const MCP_COMMAND = "withmate-session";
const MCP_ARGS = ["mcp-server"] as const;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CodexMcpRecord = {
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

export type CodexSessionMcpRegistrationServiceDeps = {
  getSkillSyncResult(): ManagedSessionSkillSyncResult | null;
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  resourcesPath?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  now?: () => Date;
};

export class CodexSessionMcpRegistrationService {
  constructor(private readonly deps: CodexSessionMcpRegistrationServiceDeps) {}

  async getDiagnostics(): Promise<SessionIntegrationDiagnostics> {
    const eligibility = this.getEligibilityStatus();
    const [launcher, codexMcp] = eligibility
      ? [this.skippedLauncher(eligibility), this.skippedMcp(eligibility)]
      : await Promise.all([this.inspectLauncher(), this.inspectMcpRegistration()]);
    return this.buildDiagnostics(launcher, codexMcp);
  }

  async register(): Promise<SessionIntegrationDiagnostics> {
    const eligibility = this.getEligibilityStatus();
    if (eligibility) {
      return this.buildDiagnostics(this.skippedLauncher(eligibility), this.skippedMcp(eligibility));
    }

    const launcher = await this.inspectLauncher();
    if (launcher.status !== "installed") {
      return this.buildDiagnostics(launcher, {
        ...this.baseMcp(),
        status: launcher.status === "collision" ? "collision" : "failed",
        errorMessage: launcher.errorMessage
          ?? "withmate-session launcher is unavailable; Codex MCP registration was not changed.",
      });
    }

    const before = await this.inspectMcpRegistration();
    if (before.status === "unchanged" || before.status === "collision" || before.status === "failed") {
      return this.buildDiagnostics(launcher, before);
    }

    const preAddGet = await this.getMcpRecord();
    if (preAddGet.kind === "record") {
      return this.buildDiagnostics(launcher, this.classifyMcpRecord(preAddGet.record));
    }
    if (preAddGet.kind === "failed") {
      return this.buildDiagnostics(launcher, {
        ...this.baseMcp(),
        status: "failed",
        errorMessage: preAddGet.errorMessage,
      });
    }

    const addResult = await this.run("codex", [
      "mcp",
      "add",
      MCP_NAME,
      "--",
      launcher.expectedPath ?? MCP_COMMAND,
      ...MCP_ARGS,
    ]);
    const readBack = await this.getMcpRecord();
    if (readBack.kind === "record") {
      const classified = this.classifyMcpRecord(readBack.record);
      if (classified.status === "unchanged") {
        return this.buildDiagnostics(launcher, {
          ...classified,
          status: addResult.exitCode === 0 ? "installed" : "unchanged",
        });
      }
      return this.buildDiagnostics(launcher, classified);
    }

    const commandFailure = formatCommandFailure(addResult, "Codex MCP registration failed.");
    return this.buildDiagnostics(launcher, {
      ...this.baseMcp(),
      status: "failed",
      errorMessage: readBack.kind === "failed"
        ? `${commandFailure} Read-back failed: ${readBack.errorMessage}`
        : `${commandFailure} Read-back did not find ${MCP_NAME}.`,
    });
  }

  private async inspectLauncher(): Promise<SessionCliLauncherDiagnostics> {
    const expectedPath = this.resolveExpectedLauncherPath();
    if (!expectedPath) {
      return {
        ...this.baseLauncher(expectedPath),
        status: "failed",
        errorMessage: "The packaged withmate-session launcher path is unavailable.",
      };
    }

    let launcherContent: string;
    try {
      launcherContent = await (this.deps.readTextFile ?? readUtf8File)(expectedPath);
    } catch (error) {
      return {
        ...this.baseLauncher(expectedPath),
        status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "not-installed" : "failed",
        errorMessage: `The WithMate-managed launcher could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const status = this.isExpectedLauncherContent(launcherContent) ? "installed" : "collision";
    return {
      ...this.baseLauncher(expectedPath),
      status,
      resolvedPath: expectedPath,
      ...(status === "collision" ? {
        errorMessage: "The expected launcher path contains an unmanaged or modified withmate-session launcher.",
      } : {}),
    };
  }

  private async inspectMcpRegistration(): Promise<CodexSessionMcpRegistrationDiagnostics> {
    const listResult = await this.run("codex", ["mcp", "list", "--json"]);
    if (listResult.exitCode !== 0) {
      return {
        ...this.baseMcp(),
        status: "failed",
        errorMessage: formatCommandFailure(listResult, "Codex MCP configuration could not be listed."),
      };
    }

    let records: CodexMcpRecord[];
    try {
      const parsed = JSON.parse(listResult.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected an array.");
      records = parsed as CodexMcpRecord[];
    } catch (error) {
      return {
        ...this.baseMcp(),
        status: "failed",
        errorMessage: `Codex MCP list returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!records.some((record) => record.name === MCP_NAME)) {
      return { ...this.baseMcp(), status: "not-installed" };
    }
    const getResult = await this.getMcpRecord();
    if (getResult.kind === "record") return this.classifyMcpRecord(getResult.record);
    return {
      ...this.baseMcp(),
      status: "failed",
      errorMessage: getResult.kind === "failed"
        ? getResult.errorMessage
        : `Codex MCP list contained ${MCP_NAME}, but get could not read it.`,
    };
  }

  private async getMcpRecord(): Promise<
    | { kind: "record"; record: CodexMcpRecord }
    | { kind: "not-found" }
    | { kind: "failed"; errorMessage: string }
  > {
    const result = await this.run("codex", ["mcp", "get", MCP_NAME, "--json"]);
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 1 && /not found|does not exist|unknown/i.test(combined)) {
        return { kind: "not-found" };
      }
      return {
        kind: "failed",
        errorMessage: formatCommandFailure(result, `Codex MCP ${MCP_NAME} could not be read.`),
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected an object.");
      }
      return { kind: "record", record: parsed as CodexMcpRecord };
    } catch (error) {
      return {
        kind: "failed",
        errorMessage: `Codex MCP get returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private classifyMcpRecord(record: CodexMcpRecord): CodexSessionMcpRegistrationDiagnostics {
    const expectedCommand = this.resolveExpectedLauncherPath();
    const exact = record.name === MCP_NAME
      && record.enabled === true
      && (record.disabled_reason === undefined || record.disabled_reason === null)
      && record.transport?.type === "stdio"
      && typeof record.transport.command === "string"
      && expectedCommand !== null
      && sameWindowsPath(record.transport.command, expectedCommand)
      && Array.isArray(record.transport.args)
      && record.transport.args.length === MCP_ARGS.length
      && record.transport.args.every((arg, index) => arg === MCP_ARGS[index])
      && (record.transport.env === undefined || record.transport.env === null)
      && (record.transport.env_vars === undefined
        || (Array.isArray(record.transport.env_vars) && record.transport.env_vars.length === 0))
      && (record.transport.cwd === undefined || record.transport.cwd === null)
      && (record.startup_timeout_sec === undefined || record.startup_timeout_sec === null)
      && (record.tool_timeout_sec === undefined || record.tool_timeout_sec === null)
      && (record.enabled_tools === undefined || record.enabled_tools === null)
      && (record.disabled_tools === undefined
        || record.disabled_tools === null
        || (Array.isArray(record.disabled_tools) && record.disabled_tools.length === 0));
    return exact
      ? { ...this.baseMcp(), status: "unchanged" }
      : {
        ...this.baseMcp(),
        status: "collision",
        errorMessage: `Codex MCP name ${MCP_NAME} is already configured with a different or disabled transport.`,
      };
  }

  private buildDiagnostics(
    launcher: SessionCliLauncherDiagnostics,
    codexMcp: CodexSessionMcpRegistrationDiagnostics,
  ): SessionIntegrationDiagnostics {
    return {
      generatedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      skillSync: toSkillDiagnostics(this.deps.getSkillSyncResult()),
      launcher,
      codexMcp,
    };
  }

  private getEligibilityStatus(): "skipped-unpackaged" | "skipped-unsupported-platform" | null {
    if (!this.deps.isPackagedApp()) return "skipped-unpackaged";
    if ((this.deps.platform ?? process.platform) !== "win32") return "skipped-unsupported-platform";
    return null;
  }

  private skippedLauncher(
    status: "skipped-unpackaged" | "skipped-unsupported-platform",
  ): SessionCliLauncherDiagnostics {
    return { ...this.baseLauncher(this.resolveExpectedLauncherPath()), status };
  }

  private skippedMcp(
    status: "skipped-unpackaged" | "skipped-unsupported-platform",
  ): CodexSessionMcpRegistrationDiagnostics {
    return { ...this.baseMcp(), status };
  }

  private baseLauncher(expectedPath: string | null): Omit<SessionCliLauncherDiagnostics, "status"> {
    return { command: MCP_COMMAND, resolvedPath: null, expectedPath };
  }

  private baseMcp(): Omit<CodexSessionMcpRegistrationDiagnostics, "status"> {
    return { name: MCP_NAME, command: this.resolveExpectedLauncherPath() ?? MCP_COMMAND, args: [...MCP_ARGS] };
  }

  private resolveExpectedLauncherPath(): string | null {
    const executablePath = this.deps.executablePath ?? process.execPath;
    return executablePath ? path.join(path.dirname(executablePath), "withmate-session.cmd") : null;
  }

  private isExpectedLauncherContent(content: string): boolean {
    const executablePath = this.deps.executablePath ?? process.execPath;
    const resourcesPath = this.deps.resourcesPath ?? process.resourcesPath;
    const cliPath = path.join(resourcesPath, "resources", "cli", "withmate-session", "withmate-session.mjs");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== 5
      || lines[0].toLocaleLowerCase("en-US") !== "@echo off"
      || lines[1].toLocaleLowerCase("en-US") !== "setlocal"
      || lines[2].toLocaleLowerCase("en-US") !== "set electron_run_as_node=1"
      || lines[4].toLocaleLowerCase("en-US") !== "exit /b %errorlevel%") {
      return false;
    }
    const invocation = /^"(?:%~dp0)?([^"]+)" "(?:%~dp0)?([^"]+)" %\*$/.exec(lines[3] ?? "");
    return invocation !== null
      && sameWindowsPath(path.resolve(path.dirname(executablePath), invocation[1]), executablePath)
      && sameWindowsPath(path.resolve(path.dirname(executablePath), invocation[2]), cliPath);
  }

  private run(command: string, args: string[]): Promise<CommandResult> {
    return (this.deps.runCommand ?? runCommand)(command, args);
  }
}

function readUtf8File(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function toSkillDiagnostics(result: ManagedSessionSkillSyncResult | null): SessionSkillSyncDiagnostics {
  if (!result) return { status: "not-run", skillPath: null };
  return {
    status: result.status,
    skillPath: result.skillPath,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
      resolve({
        exitCode,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? (error instanceof Error ? error.message : "")),
      });
    });
  });
}

function firstNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLocaleLowerCase("en-US") === path.win32.normalize(right).toLocaleLowerCase("en-US");
}

function formatCommandFailure(result: CommandResult, fallback: string): string {
  const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
  return detail ? `${fallback} ${detail}` : `${fallback} Exit code: ${result.exitCode}.`;
}
