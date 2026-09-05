import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CodexManagedMcpConfigService,
  type CodexManagedMcpConfigServiceDeps,
} from "../../src-electron/codex-managed-mcp-config.js";

type ScriptedCommand = {
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

const codexPath = "C:\\Program Files\\WithMate\\resources\\codex.exe";
const executablePath = "C:\\Program Files\\WithMate\\WithMate.exe";
const resourcesPath = "C:\\Program Files\\WithMate\\resources";
const workspacePath = "C:\\workspace\\project";
const memoryLauncherPath = "C:\\Program Files\\WithMate\\withmate-memory.cmd";
const glossaryLauncherPath = "C:\\Program Files\\WithMate\\withmate-glossary.cmd";
const memoryArtifactPath = path.win32.join(resourcesPath, "resources", "cli", "withmate-memory.mjs");
const glossaryArtifactPath = path.win32.join(
  resourcesPath,
  "resources",
  "skills",
  "withmate-glossary",
  "bin",
  "withmate-glossary.mjs",
);
const forwardedEnvVars = [
  "WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE",
  "WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED",
  "WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY",
  "WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID",
  "WITHMATE_MEMORY_RUNTIME_GENERATION_ID",
];

function launcherContent(artifactPath: string): string {
  return [
    "@echo off",
    "setlocal",
    "set ELECTRON_RUN_AS_NODE=1",
    `"${executablePath}" "${artifactPath}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function exactRecord(input: {
  name: "withmate-character-context" | "withmate-glossary";
  command: string;
  envVars?: string[];
}) {
  return {
    name: input.name,
    enabled: true,
    disabled_reason: null,
    transport: {
      type: "stdio",
      command: input.command,
      args: ["mcp-server"],
      env: null,
      env_vars: input.envVars ?? [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

function createService(
  script: ScriptedCommand[],
  overrides: Partial<CodexManagedMcpConfigServiceDeps> = {},
) {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
  const service = new CodexManagedMcpConfigService({
    isPackagedApp: () => true,
    platform: "win32",
    executablePath,
    resourcesPath,
    processEnv: {
      PATH: "C:\\Windows",
      WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: "binding-reference",
      WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED: "1",
      WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: "turn-capability",
      WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID: "memory-instance",
      WITHMATE_MEMORY_RUNTIME_GENERATION_ID: "memory-generation",
      WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID: "session-instance",
      WITHMATE_SESSION_RUNTIME_GENERATION_ID: "session-generation",
    },
    fileExists: (filePath) => filePath === memoryLauncherPath
      || filePath === memoryArtifactPath
      || filePath === glossaryLauncherPath
      || filePath === glossaryArtifactPath,
    readTextFile: (filePath) => filePath === memoryLauncherPath
      ? launcherContent(memoryArtifactPath)
      : launcherContent(glossaryArtifactPath),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      const expected = script.shift();
      assert.ok(expected, `Unexpected command: ${command} ${args.join(" ")}`);
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

describe("CodexManagedMcpConfigService", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "unpackagedまたは非WindowsのCodex clientにはmanaged MCP overrideを追加しない"
  // oracle = { type = "issue", ref = "Issue #453 packaged Windows foreground Session boundary" }
  // failure_mode = "対象外processへWithMate管理MCPの環境転送設定を追加する"
  // scope = "codex-managed-mcp-session-config"
  // lifecycle = "permanent"
  // @end-test-value
  it("unpackagedと非Windowsでは検査せずoverrideを返さない", async () => {
    for (const overrides of [
      { isPackagedApp: () => false },
      { platform: "darwin" as const },
    ]) {
      const { service, calls } = createService([], overrides);
      assert.deepEqual(await service.resolve({ codexPath, workspacePath }), []);
      assert.equal(calls.length, 0);
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "MCP未登録時の検査processと返却設定へbinding値を渡さない"
  // oracle = { type = "issue", ref = "Issue #453 managed MCP allowlist and non-persistence requirements" }
  // failure_mode = "binding値を設定検査processへ継承するか、永続化され得るconfig overrideへ埋め込む"
  // scope = "codex-managed-mcp-session-config"
  // lifecycle = "permanent"
  // distinction = "MCP未設定からのsession限定追加と検査processのbinding除去を同時に観測する"
  // @end-test-value
  it("MCP未登録の検査processと設定overrideにbinding値を含めない", async () => {
    const { service, calls, remaining } = createService([{
      args: ["-C", workspacePath, "mcp", "list", "--json"],
      stdout: "[]",
    }]);

    const overrides = await service.resolve({ codexPath, workspacePath });

    assert.equal(overrides.length, 2);
    assert.doesNotMatch(overrides.join("\n"), /binding-reference|turn-capability|memory-instance|memory-generation|session-instance|session-generation/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, codexPath);
    assert.equal(calls[0].cwd, workspacePath);
    assert.equal(calls[0].env.PATH, "C:\\Windows");
    assert.equal(Object.keys(calls[0].env).some((name) => name.startsWith("WITHMATE_")), false);
    assert.equal(remaining.length, 0);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "既存managed transportはenv_vars未設定または順序に依存しない正確な5変数集合ならsession overrideへ収束する"
  // oracle = { type = "issue", ref = "Issue #453 existing config compatibility requirement" }
  // failure_mode = "安全な既存設定をcollision扱いして新しいCodex Sessionを開始できない"
  // scope = "codex-managed-mcp-config-classification"
  // lifecycle = "permanent"
  // distinction = "missingではなく2つの既存recordをfull get結果で照合する"
  // @end-test-value
  it("exactな既存MemoryとGlossary設定をfull recordで照合する", async () => {
    const memory = exactRecord({ name: "withmate-character-context", command: memoryLauncherPath });
    const glossary = exactRecord({
      name: "withmate-glossary",
      command: glossaryLauncherPath,
      envVars: [...forwardedEnvVars].reverse(),
    });
    const { service, calls } = createService([
      {
        args: ["-C", workspacePath, "mcp", "list", "--json"],
        stdout: JSON.stringify([memory, glossary]),
      },
      {
        args: ["-C", workspacePath, "mcp", "get", "withmate-character-context", "--json"],
        stdout: JSON.stringify(memory),
      },
      {
        args: ["-C", workspacePath, "mcp", "get", "withmate-glossary", "--json"],
        stdout: JSON.stringify(glossary),
      },
    ]);

    const overrides = await service.resolve({ codexPath, workspacePath });

    assert.equal(overrides.length, 2);
    assert.equal(calls.length, 3);
  });

  // @test-value v1
  // kind = "security"
  // claim = "disabled、別command、固定env、過不足または重複のenv_varsを持つ同名MCPはsession起動前に拒否する"
  // oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md managed launcher collision contract" }
  // failure_mode = "第三者commandまたは利用者が無効化したMCPへbinding authorityを転送する"
  // scope = "codex-managed-mcp-config-classification"
  // lifecycle = "permanent"
  // distinction = "command一致だけでは見逃すtransport全体とenv_vars集合の衝突を検証する"
  // @end-test-value
  it("disabledまたはtransport差分のある同名MCPを上書きせず拒否する", async () => {
    const exact = exactRecord({ name: "withmate-character-context", command: memoryLauncherPath });
    const collisions = [
      { ...exact, enabled: false },
      { ...exact, transport: { ...exact.transport, command: "third-party-command" } },
      { ...exact, transport: { ...exact.transport, env: { FIXED: "value" } } },
      { ...exact, transport: { ...exact.transport, env_vars: forwardedEnvVars.slice(1) } },
      { ...exact, transport: { ...exact.transport, env_vars: [...forwardedEnvVars, forwardedEnvVars[0]] } },
      { ...exact, transport: { ...exact.transport, env_vars: [...forwardedEnvVars, "EXTRA"] } },
    ];

    for (const collision of collisions) {
      const { service, calls } = createService([
        {
          args: ["-C", workspacePath, "mcp", "list", "--json"],
          stdout: JSON.stringify([collision]),
        },
        {
          args: ["-C", workspacePath, "mcp", "get", "withmate-character-context", "--json"],
          stdout: JSON.stringify(collision),
        },
      ]);

      await assert.rejects(
        service.resolve({ codexPath, workspacePath }),
        /disabled or conflicts with the WithMate-managed transport/,
      );
      assert.equal(calls.length, 2);
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "Codex config検査のstdout、stderr、command errorは失敗messageへ転記せずmalformed responseも同じ安全なerrorにする"
  // oracle = { type = "issue", ref = "Issue #453 binding values must not be logged" }
  // failure_mode = "Codexが返したconfig値またはbinding値を例外経由でログへ公開する"
  // scope = "codex-managed-mcp-config-inspection"
  // lifecycle = "permanent"
  // @end-test-value
  it("config検査失敗を値を含まない固定errorへ変換する", async () => {
    const failedCommand = createService([{
      args: ["-C", workspacePath, "mcp", "list", "--json"],
      exitCode: 1,
      stdout: "private-config-value",
      stderr: "private-binding-value",
    }]);
    const malformedResponse = createService([{
      args: ["-C", workspacePath, "mcp", "list", "--json"],
      stdout: "[null]",
    }]);
    const rejectedCommand = createService([], {
      runCommand: async () => {
        throw new Error("private-command-error");
      },
    });

    for (const service of [failedCommand.service, malformedResponse.service, rejectedCommand.service]) {
      await assert.rejects(
        service.resolve({ codexPath, workspacePath }),
        (error: Error) => error.message === "Codex MCP configuration could not be inspected.",
      );
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "Codex binary欠落またはmanaged launcher検証失敗ではconfig検査より前にfail closedする"
  // oracle = { type = "issue", ref = "Issue #453 verified managed definition requirement" }
  // failure_mode = "実行先を固定できない状態で同名MCPを検査またはbinding allowlistを生成する"
  // scope = "codex-managed-mcp-launch-admission"
  // lifecycle = "permanent"
  // distinction = "config collisionではなく起動artifactとCodex executableのpreconditionを検証する"
  // @end-test-value
  it("Codex binaryまたはmanaged launcherを検証できなければ起動前に拒否する", async () => {
    const missingCodex = createService([]);
    await assert.rejects(
      missingCodex.service.resolve({ codexPath: null, workspacePath }),
      /Codex executable is unavailable/,
    );
    assert.equal(missingCodex.calls.length, 0);

    const modifiedLauncher = createService([], {
      readTextFile: () => "modified launcher",
    });
    await assert.rejects(
      modifiedLauncher.service.resolve({ codexPath, workspacePath }),
      /WithMate-managed MCP launchers could not be verified/,
    );
    assert.equal(modifiedLauncher.calls.length, 0);
  });
});
