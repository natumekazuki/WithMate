import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";

import type { ManagedSessionSkillSyncResult } from "./managed-session-skill-service.js";
import type { ManagedSkillSyncResult } from "./managed-skill-distribution-service.js";
import {
  isExactCodexManagedMcpRecord,
  type CodexManagedMcpRecord,
} from "./codex-managed-mcp-config.js";
import {
  isExpectedManagedMcpLauncherContent,
  resolveManagedMcpLauncherPaths,
  WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC,
  WITHMATE_SESSION_MCP_LAUNCHER_SPEC,
  type ManagedMcpLauncherSpec,
} from "./managed-mcp-launcher.js";
import { WITHMATE_CODEX_MCP_BINDING_ENV_VARS } from "./provider-agent-runtime-binding.js";
import type {
  CodexManagedMcpRegistrationDiagnostics,
  ManagedMcpLauncherDiagnostics,
  SessionIntegrationDiagnostics,
  SessionSkillSyncDiagnostics,
} from "../src/session-integration-diagnostics-state.js";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

type SkillSyncResult = ManagedSessionSkillSyncResult | ManagedSkillSyncResult;
type EligibilityStatus = "skipped-unpackaged" | "skipped-unsupported-platform";
type SessionIntegrationMcpSpec =
  | typeof WITHMATE_SESSION_MCP_LAUNCHER_SPEC
  | typeof WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC;

export type CodexSessionMcpRegistrationServiceDeps = {
  getSkillSyncResult(): ManagedSessionSkillSyncResult | null;
  getGlossarySkillSyncResult(): ManagedSkillSyncResult | null;
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  executablePath?: string;
  resourcesPath?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  fileExists?: (filePath: string) => Promise<boolean>;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  now?: () => Date;
};

type IntegrationPart = {
  launcher: ManagedMcpLauncherDiagnostics;
  mcp: CodexManagedMcpRegistrationDiagnostics;
};

export class CodexSessionMcpRegistrationService {
  constructor(private readonly deps: CodexSessionMcpRegistrationServiceDeps) {}

  async getDiagnostics(): Promise<SessionIntegrationDiagnostics> {
    const eligibility = this.getEligibilityStatus();
    const [session, glossary] = eligibility
      ? [
        this.skippedPart(WITHMATE_SESSION_MCP_LAUNCHER_SPEC, eligibility),
        this.skippedPart(WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC, eligibility),
      ]
      : await Promise.all([
        this.inspectPart(WITHMATE_SESSION_MCP_LAUNCHER_SPEC),
        this.inspectPart(WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC),
      ]);
    return this.buildDiagnostics(session, glossary);
  }

  async register(): Promise<SessionIntegrationDiagnostics> {
    const eligibility = this.getEligibilityStatus();
    if (eligibility) {
      return this.buildDiagnostics(
        this.skippedPart(WITHMATE_SESSION_MCP_LAUNCHER_SPEC, eligibility),
        this.skippedPart(WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC, eligibility),
      );
    }
    // Codex owns one shared config file, so independent descriptor outcomes still mutate it serially.
    const session = await this.registerPart(WITHMATE_SESSION_MCP_LAUNCHER_SPEC);
    const glossary = await this.registerPart(WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC);
    return this.buildDiagnostics(session, glossary);
  }

  private async inspectPart(spec: SessionIntegrationMcpSpec): Promise<IntegrationPart> {
    return {
      launcher: await this.inspectLauncher(spec),
      mcp: await this.inspectMcpRegistration(spec),
    };
  }

  private async registerPart(spec: SessionIntegrationMcpSpec): Promise<IntegrationPart> {
    const launcher = await this.inspectLauncher(spec);
    if (launcher.status !== "installed") {
      return {
        launcher,
        mcp: {
          ...this.baseMcp(spec),
          status: launcher.status === "collision" ? "collision" : "failed",
          errorMessage: launcher.errorMessage
            ?? `${spec.name} launcher is unavailable; Codex MCP registration was not changed.`,
        },
      };
    }

    const before = await this.inspectMcpRegistration(spec);
    if (before.status === "unchanged" || before.status === "collision" || before.status === "failed") {
      return { launcher, mcp: before };
    }

    const preAddGet = await this.getMcpRecord(spec);
    if (preAddGet.kind === "record") {
      return { launcher, mcp: this.classifyMcpRecord(spec, preAddGet.record) };
    }
    if (preAddGet.kind === "failed") {
      return { launcher, mcp: { ...this.baseMcp(spec), status: "failed", errorMessage: preAddGet.errorMessage } };
    }

    const addResult = await this.run("codex", [
      "mcp",
      "add",
      spec.name,
      "--",
      launcher.expectedPath ?? spec.name,
      ...spec.args,
    ]);
    const readBack = await this.getMcpRecord(spec);
    if (readBack.kind === "record") {
      const classified = this.classifyMcpRecord(spec, readBack.record);
      return {
        launcher,
        mcp: classified.status === "unchanged"
          ? { ...classified, status: addResult.exitCode === 0 ? "installed" : "unchanged" }
          : classified,
      };
    }

    const commandFailure = formatCommandFailure(addResult, `Codex MCP ${spec.name} registration failed.`);
    return {
      launcher,
      mcp: {
        ...this.baseMcp(spec),
        status: "failed",
        errorMessage: readBack.kind === "failed"
          ? `${commandFailure} Read-back failed: ${readBack.errorMessage}`
          : `${commandFailure} Read-back did not find ${spec.name}.`,
      },
    };
  }

  private async inspectLauncher(spec: SessionIntegrationMcpSpec): Promise<ManagedMcpLauncherDiagnostics> {
    const paths = this.resolvePaths(spec);
    if (!paths) {
      return {
        ...this.baseLauncher(spec, null),
        status: "failed",
        errorMessage: `The packaged ${spec.name} launcher path is unavailable.`,
      };
    }

    try {
      const [launcherContent, artifactExists] = await Promise.all([
        (this.deps.readTextFile ?? readUtf8File)(paths.launcherPath),
        (this.deps.fileExists ?? pathExists)(paths.packagedCliPath),
      ]);
      const installed = artifactExists && isExpectedManagedMcpLauncherContent({
        content: launcherContent,
        executablePath: this.resolveExecutablePath(),
        packagedCliPath: paths.packagedCliPath,
      });
      return {
        ...this.baseLauncher(spec, paths.launcherPath),
        status: installed ? "installed" : "collision",
        resolvedPath: paths.launcherPath,
        ...(installed ? {} : {
          errorMessage: artifactExists
            ? `The expected launcher path contains an unmanaged or modified ${spec.name} launcher.`
            : `The packaged ${spec.name} CLI artifact is unavailable.`,
        }),
      };
    } catch (error) {
      return {
        ...this.baseLauncher(spec, paths.launcherPath),
        status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "not-installed" : "failed",
        errorMessage: `The WithMate-managed ${spec.name} launcher could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async inspectMcpRegistration(spec: SessionIntegrationMcpSpec): Promise<CodexManagedMcpRegistrationDiagnostics> {
    const listResult = await this.run("codex", ["mcp", "list", "--json"]);
    if (listResult.exitCode !== 0) {
      return {
        ...this.baseMcp(spec),
        status: "failed",
        errorMessage: formatCommandFailure(listResult, "Codex MCP configuration could not be listed."),
      };
    }

    let records: CodexManagedMcpRecord[];
    try {
      const parsed = JSON.parse(listResult.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Expected an array.");
      records = parsed as CodexManagedMcpRecord[];
    } catch (error) {
      return {
        ...this.baseMcp(spec),
        status: "failed",
        errorMessage: `Codex MCP list returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!records.some((record) => record.name === spec.name)) {
      return { ...this.baseMcp(spec), status: "not-installed" };
    }
    const getResult = await this.getMcpRecord(spec);
    if (getResult.kind === "record") return this.classifyMcpRecord(spec, getResult.record);
    return {
      ...this.baseMcp(spec),
      status: "failed",
      errorMessage: getResult.kind === "failed"
        ? getResult.errorMessage
        : `Codex MCP list contained ${spec.name}, but get could not read it.`,
    };
  }

  private async getMcpRecord(spec: SessionIntegrationMcpSpec): Promise<
    | { kind: "record"; record: CodexManagedMcpRecord }
    | { kind: "not-found" }
    | { kind: "failed"; errorMessage: string }
  > {
    const result = await this.run("codex", ["mcp", "get", spec.name, "--json"]);
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 1 && /not found|does not exist|unknown/i.test(combined)) return { kind: "not-found" };
      return {
        kind: "failed",
        errorMessage: formatCommandFailure(result, `Codex MCP ${spec.name} could not be read.`),
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object.");
      return { kind: "record", record: parsed as CodexManagedMcpRecord };
    } catch (error) {
      return {
        kind: "failed",
        errorMessage: `Codex MCP get returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private classifyMcpRecord(
    spec: SessionIntegrationMcpSpec,
    record: CodexManagedMcpRecord,
  ): CodexManagedMcpRegistrationDiagnostics {
    const expectedCommand = this.resolvePaths(spec)?.launcherPath ?? null;
    const exact = expectedCommand !== null && isExactCodexManagedMcpRecord({
      record,
      mcpName: spec.name,
      command: expectedCommand,
      args: spec.args,
      ...(spec === WITHMATE_GLOSSARY_MCP_LAUNCHER_SPEC
        ? { acceptedEnvVars: WITHMATE_CODEX_MCP_BINDING_ENV_VARS }
        : {}),
    });
    return exact
      ? { ...this.baseMcp(spec), status: "unchanged" }
      : {
        ...this.baseMcp(spec),
        status: "collision",
        errorMessage: `Codex MCP name ${spec.name} is already configured with a different or disabled transport.`,
      };
  }

  private buildDiagnostics(session: IntegrationPart, glossary: IntegrationPart): SessionIntegrationDiagnostics {
    return {
      generatedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      skillSync: toSkillDiagnostics(this.deps.getSkillSyncResult()),
      launcher: { ...session.launcher, command: "withmate-session" },
      codexMcp: { ...session.mcp, name: "withmate-session" },
      glossarySkillSync: toSkillDiagnostics(this.deps.getGlossarySkillSyncResult()),
      glossaryLauncher: { ...glossary.launcher, command: "withmate-glossary" },
      codexGlossaryMcp: { ...glossary.mcp, name: "withmate-glossary" },
    };
  }

  private getEligibilityStatus(): EligibilityStatus | null {
    if (!this.deps.isPackagedApp()) return "skipped-unpackaged";
    if ((this.deps.platform ?? process.platform) !== "win32") return "skipped-unsupported-platform";
    return null;
  }

  private skippedPart(spec: SessionIntegrationMcpSpec, status: EligibilityStatus): IntegrationPart {
    return {
      launcher: { ...this.baseLauncher(spec, this.resolvePaths(spec)?.launcherPath ?? null), status },
      mcp: { ...this.baseMcp(spec), status },
    };
  }

  private baseLauncher(
    spec: SessionIntegrationMcpSpec,
    expectedPath: string | null,
  ): Omit<ManagedMcpLauncherDiagnostics, "status"> {
    return { command: spec.name, resolvedPath: null, expectedPath };
  }

  private baseMcp(spec: SessionIntegrationMcpSpec): Omit<CodexManagedMcpRegistrationDiagnostics, "status"> {
    return {
      name: spec.name,
      command: this.resolvePaths(spec)?.launcherPath ?? spec.name,
      args: [...spec.args],
    };
  }

  private resolvePaths(spec: ManagedMcpLauncherSpec) {
    return resolveManagedMcpLauncherPaths({
      spec,
      executablePath: this.resolveExecutablePath(),
      resourcesPath: this.deps.resourcesPath ?? process.resourcesPath,
    });
  }

  private resolveExecutablePath(): string {
    return this.deps.executablePath ?? process.execPath;
  }

  private run(command: string, args: string[]): Promise<CommandResult> {
    return (this.deps.runCommand ?? runCommand)(command, args);
  }
}

function readUtf8File(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toSkillDiagnostics(result: SkillSyncResult | null): SessionSkillSyncDiagnostics {
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

function formatCommandFailure(result: CommandResult, fallback: string): string {
  const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
  return detail ? `${fallback} ${detail}` : `${fallback} Exit code: ${result.exitCode}.`;
}
