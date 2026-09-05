import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CodexSessionMcpRegistrationService,
  type CodexSessionMcpRegistrationServiceDeps,
} from "../../src-electron/codex-session-mcp-registration-service.js";
import { WITHMATE_CODEX_MCP_BINDING_ENV_VARS } from "../../src-electron/provider-agent-runtime-binding.js";

type ScriptedCommand = {
  command: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

const localAppData = "C:\\Users\\test\\AppData\\Local";
const executablePath = "C:\\Program Files\\WithMate\\WithMate.exe";
const resourcesPath = "C:\\Program Files\\WithMate\\resources";
const launcherPath = "C:\\Program Files\\WithMate\\withmate-session.cmd";
const glossaryLauncherPath = "C:\\Program Files\\WithMate\\withmate-glossary.cmd";
const sessionArtifactPath = path.win32.join(resourcesPath, "resources", "cli", "withmate-session", "withmate-session.mjs");
const glossaryArtifactPath = path.win32.join(resourcesPath, "resources", "skills", "withmate-glossary", "bin", "withmate-glossary.mjs");
const launcherContent = [
  "@echo off",
  "setlocal",
  "set ELECTRON_RUN_AS_NODE=1",
  `"${executablePath}" "${path.win32.join(resourcesPath, "resources", "cli", "withmate-session", "withmate-session.mjs")}" %*`,
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");
const glossaryLauncherContent = [
  "@echo off",
  "setlocal",
  "set ELECTRON_RUN_AS_NODE=1",
  `"${executablePath}" "${glossaryArtifactPath}" %*`,
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

function exactRecord() {
  return {
    name: "withmate-session",
    enabled: true,
    transport: {
      type: "stdio",
      command: launcherPath,
      args: ["mcp-server"],
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

function createService(script: ScriptedCommand[], overrides: Partial<CodexSessionMcpRegistrationServiceDeps> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const service = new CodexSessionMcpRegistrationService({
    getSkillSyncResult: () => ({
      providerId: "codex",
      skillRootPath: "C:\\Users\\test\\.codex\\skills",
      skillPath: "C:\\Users\\test\\.codex\\skills\\withmate-session",
      status: "unchanged",
    }),
    getGlossarySkillSyncResult: () => ({
      providerId: "codex",
      skillRootPath: "C:\\Users\\test\\.codex\\skills",
      skillPath: "C:\\Users\\test\\.codex\\skills\\withmate-glossary",
      status: "unchanged",
    }),
    isPackagedApp: () => true,
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    executablePath,
    resourcesPath,
    readTextFile: async (filePath) => {
      if (filePath === launcherPath) return launcherContent;
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    fileExists: async (filePath) => filePath === sessionArtifactPath,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    runCommand: async (command, args) => {
      calls.push({ command, args });
      const expected = script.shift();
      assert.ok(expected, `Unexpected command: ${command} ${args.join(" ")}`);
      assert.equal(command, expected.command);
      assert.deepEqual(args, expected.args);
      return {
        exitCode: expected.exitCode ?? 0,
        stdout: expected.stdout ?? "",
        stderr: expected.stderr ?? "",
      };
    },
    ...overrides,
  });
  return { service, calls, remaining: script };
}

describe("CodexSessionMcpRegistrationService", () => {
  it("明示registerでlist/get確認後にexact stdio設定をaddしread-backする", async () => {
    const { service, calls, remaining } = createService([
      { command: "codex", args: ["mcp", "list", "--json"], stdout: "[]" },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], exitCode: 1, stderr: "MCP server not found" },
      { command: "codex", args: ["mcp", "add", "withmate-session", "--", launcherPath, "mcp-server"] },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], stdout: JSON.stringify(exactRecord()) },
    ]);

    const diagnostics = await service.register();

    assert.equal(diagnostics.codexMcp.status, "installed");
    assert.equal(diagnostics.launcher.status, "installed");
    assert.equal(diagnostics.skillSync.status, "unchanged");
    assert.equal(diagnostics.generatedAt, "2026-08-14T00:00:00.000Z");
    assert.equal(calls.length, 4);
    assert.equal(remaining.length, 0);
  });

  it("同名MCPがexactなら変更せずunchangedを返す", async () => {
    const { service, calls } = createService([
      { command: "codex", args: ["mcp", "list", "--json"], stdout: JSON.stringify([exactRecord()]) },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], stdout: JSON.stringify(exactRecord()) },
    ]);

    const diagnostics = await service.register();

    assert.equal(diagnostics.codexMcp.status, "unchanged");
    assert.equal(calls.some((call) => call.args.includes("add")), false);
  });

  it("同名MCPが別設定ならcollisionとして上書きしない", async () => {
    const collision = {
      ...exactRecord(),
      transport: { type: "stdio", command: "other-command", args: ["serve"] },
    };
    const { service, calls } = createService([
      { command: "codex", args: ["mcp", "list", "--json"], stdout: JSON.stringify([collision]) },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], stdout: JSON.stringify(collision) },
    ]);

    const diagnostics = await service.register();

    assert.equal(diagnostics.codexMcp.status, "collision");
    assert.equal(calls.some((call) => call.args.includes("add")), false);
  });

  it("add応答が失敗してもread-backがexactなら適用済みとして収束する", async () => {
    const { service } = createService([
      { command: "codex", args: ["mcp", "list", "--json"], stdout: "[]" },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], exitCode: 1, stderr: "not found" },
      { command: "codex", args: ["mcp", "add", "withmate-session", "--", launcherPath, "mcp-server"], exitCode: -1, stderr: "response lost" },
      { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], stdout: JSON.stringify(exactRecord()) },
    ]);

    const diagnostics = await service.register();

    assert.equal(diagnostics.codexMcp.status, "unchanged");
  });

  it("installer管理pathのlauncher内容が改変されている場合はMCP設定を変更しない", async () => {
    const { service, calls } = createService([
    ], {
      readTextFile: async () => "@echo off\r\nmalicious-command\r\n",
    });

    const diagnostics = await service.register();

    assert.equal(diagnostics.launcher.status, "collision");
    assert.equal(diagnostics.codexMcp.status, "collision");
    assert.equal(calls.length, 0);
  });

  it("同名MCPにcwd、env、tool filter、timeoutの差分があればcollisionとして上書きしない", async () => {
    for (const delta of [
      { transport: { ...exactRecord().transport, cwd: "C:\\other" } },
      { transport: { ...exactRecord().transport, env: { PATH: "C:\\other" } } },
      { enabled_tools: ["session.list"] },
      { disabled_tools: ["turn.run"] },
      { startup_timeout_sec: 5 },
      { tool_timeout_sec: 5 },
    ]) {
      const collision = { ...exactRecord(), ...delta };
      const { service, calls } = createService([
        { command: "codex", args: ["mcp", "list", "--json"], stdout: JSON.stringify([collision]) },
        { command: "codex", args: ["mcp", "get", "withmate-session", "--json"], stdout: JSON.stringify(collision) },
      ]);

      const diagnostics = await service.register();

      assert.equal(diagnostics.codexMcp.status, "collision");
      assert.equal(calls.some((call) => call.args.includes("add")), false);
    }
  });

  it("unpackagedと非Windowsではcommandを起動せずskipする", async () => {
    for (const overrides of [
      { isPackagedApp: () => false },
      { platform: "darwin" as const },
    ]) {
      const { service, calls } = createService([], overrides);
      const diagnostics = await service.register();
      assert.match(diagnostics.codexMcp.status, /^skipped-/);
      assert.equal(calls.length, 0);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "Session側の同名collisionがあってもGlossary MCPは正確な5変数allowlistを持つexact launcherとして独立に受理される"
  // oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md#glossary-mcp-provider-registration" }
  // failure_mode = "Session MCPのcollisionまたはGlossaryの正当なallowlistを理由にGlossary toolを利用できない"
  // scope = "codex-managed-mcp-registration"
  // lifecycle = "permanent"
  // distinction = "二つのdescriptorの片方だけがcollisionになり、もう片方はbinding allowlist付きで受理されるpartial successを観測する"
  // @end-test-value
  it("Session collisionと独立にGlossary MCPを登録してread-backする", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let glossaryAdded = false;
    const sessionCollision = {
      ...exactRecord(),
      transport: { type: "stdio", command: "other-command", args: ["serve"] },
    };
    const glossaryRecord = {
      ...exactRecord(),
      name: "withmate-glossary",
      transport: {
        ...exactRecord().transport,
        command: glossaryLauncherPath,
        env_vars: [...WITHMATE_CODEX_MCP_BINDING_ENV_VARS],
      },
    };
    const service = new CodexSessionMcpRegistrationService({
      getSkillSyncResult: () => null,
      getGlossarySkillSyncResult: () => ({
        providerId: "codex",
        skillRootPath: "C:\\Users\\test\\.codex\\skills",
        skillPath: "C:\\Users\\test\\.codex\\skills\\withmate-glossary",
        status: "unchanged",
      }),
      isPackagedApp: () => true,
      platform: "win32",
      executablePath,
      resourcesPath,
      readTextFile: async (filePath) => filePath === launcherPath ? launcherContent : glossaryLauncherContent,
      fileExists: async (filePath) => filePath === sessionArtifactPath || filePath === glossaryArtifactPath,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(args.includes("withmate-session") ? [sessionCollision] : []),
            stderr: "",
          };
        }
        if (args[1] === "get" && args[2] === "withmate-session") {
          return { exitCode: 0, stdout: JSON.stringify(sessionCollision), stderr: "" };
        }
        if (args[1] === "get" && args[2] === "withmate-glossary") {
          return glossaryAdded
            ? { exitCode: 0, stdout: JSON.stringify(glossaryRecord), stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "not found" };
        }
        if (args[1] === "add" && args[2] === "withmate-glossary") {
          glossaryAdded = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    const diagnostics = await service.register();

    assert.equal(diagnostics.codexMcp.status, "collision");
    assert.equal(diagnostics.codexGlossaryMcp.status, "installed");
    assert.equal(diagnostics.glossaryLauncher.status, "installed");
    assert.equal(diagnostics.glossarySkillSync.status, "unchanged");
    assert.equal(calls.some(({ args }) => args[1] === "add" && args[2] === "withmate-session"), false);
    assert.deepEqual(calls.find(({ args }) => args[1] === "add" && args[2] === "withmate-glossary"), {
      command: "codex",
      args: ["mcp", "add", "withmate-glossary", "--", glossaryLauncherPath, "mcp-server"],
    });
  });

  // @test-value v1
  // kind = "security"
  // claim = "Glossary artifactが欠落しているlauncherはCodex設定へ登録されない"
  // oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md#glossary-mcp-provider-registration" }
  // failure_mode = "検証不能な配布artifactへのlauncherをCodexへ永続登録し、別内容または起動不能serverを信頼する"
  // scope = "managed-mcp-launcher-verification"
  // lifecycle = "permanent"
  // distinction = "launcher内容だけでなく参照先artifactの存在を登録前に検証する"
  // @end-test-value
  it("Glossary artifact欠落時はCodex設定を変更しない", async () => {
    const { service, calls } = createService([], {
      readTextFile: async (filePath) => {
        if (filePath === glossaryLauncherPath) return glossaryLauncherContent;
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      fileExists: async () => false,
    });

    const diagnostics = await service.register();

    assert.equal(diagnostics.glossaryLauncher.status, "collision");
    assert.equal(diagnostics.codexGlossaryMcp.status, "collision");
    assert.match(diagnostics.glossaryLauncher.errorMessage ?? "", /artifact is unavailable/);
    assert.equal(calls.some(({ args }) => args[2] === "withmate-glossary"), false);
  });
});
