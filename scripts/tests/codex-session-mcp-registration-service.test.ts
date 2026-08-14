import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CodexSessionMcpRegistrationService,
  type CodexSessionMcpRegistrationServiceDeps,
} from "../../src-electron/codex-session-mcp-registration-service.js";

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
const launcherContent = [
  "@echo off",
  "setlocal",
  "set ELECTRON_RUN_AS_NODE=1",
  `"${executablePath}" "${path.win32.join(resourcesPath, "resources", "cli", "withmate-session", "withmate-session.mjs")}" %*`,
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
    isPackagedApp: () => true,
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    executablePath,
    resourcesPath,
    readTextFile: async (filePath) => {
      assert.equal(filePath, launcherPath);
      return launcherContent;
    },
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
});
