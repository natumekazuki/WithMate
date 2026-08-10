import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  ManagedMemorySkillService,
  WITHMATE_MEMORY_SKILL_NAME,
} from "../../src-electron/managed-memory-skill-service.js";
import {
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../../src/memory-v6/memory-runtime-exchange.js";
import {
  BUNDLED_MEMORY_CLI_FILE_NAME,
  buildWithMateMemoryCli,
} from "../build-withmate-memory-cli.js";

const execFileAsync = promisify(execFile);

async function initializeIsolatedMcpServer(helperPath: string, cwd: string): Promise<Record<string, unknown>> {
  const client = new Client({ name: "isolated-layout-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [helperPath, "mcp-server"],
    cwd,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return await client.getServerVersion() as unknown as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

async function createBundle(): Promise<string> {
  const bundlePath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-bundle-"));
  await writeFile(
    path.join(bundlePath, "SKILL.md"),
    [
      "---",
      `name: ${WITHMATE_MEMORY_SKILL_NAME}`,
      "description: bundle",
      "---",
      "",
      "# WithMate Memory",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(path.join(bundlePath, "bin"), { recursive: true });
  await mkdir(path.join(bundlePath, "reference"), { recursive: true });
  await writeFile(path.join(bundlePath, "bin", "withmate-memory.mjs"), "console.log('bundle helper');\n", "utf8");
  await writeFile(path.join(bundlePath, "reference", "cli.md"), "# CLI\n", "utf8");
  return bundlePath;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

describe("ManagedMemorySkillService", () => {
  it("配布元Skill documentationをCodex配置先へ同一内容で同期する", async () => {
    const bundlePath = path.resolve("resources", "skills", WITHMATE_MEMORY_SKILL_NAME);
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "6.3.19-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      const installedPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);
      for (const relativePath of [
        "SKILL.md",
        path.join("reference", "character-context.md"),
        path.join("reference", "cli.md"),
      ]) {
        assert.equal(
          await readFile(path.join(installedPath, relativePath), "utf8"),
          await readFile(path.join(bundlePath, relativePath), "utf8"),
          `${relativePath} must match the distributed source`,
        );
      }
      const marker = JSON.parse(await readFile(path.join(installedPath, ".withmate-managed-skill.json"), "utf8"));
      assert.equal(marker.bundleVersion, "6.3.19-test");
      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "unchanged");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("設定済み provider skill root に Skill documentation と managed marker を install する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: ".codex/skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      const results = await service.syncConfiguredProviderSkills();
      const result = results.find((entry) => entry.providerId === "codex");
      const skillPath = path.join(rootPath, ".codex", "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
      assert.match(await readFile(path.join(skillPath, ".withmate-managed-skill.json"), "utf8"), /"managedBy": "WithMate"/);
      assert.equal(await pathExists(path.join(skillPath, "bin")), false);
      assert.equal(await readFile(path.join(skillPath, "reference", "cli.md"), "utf8"), "# CLI\n");
      const marker = JSON.parse(await readFile(path.join(skillPath, ".withmate-managed-skill.json"), "utf8"));
      assert.equal(marker.bundleVersion, "5.0.0-test");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("同じ bundleVersion の managed skill は unchanged として扱う", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "unchanged");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("managed marker が残っていても installed skill 本体が改変されていれば修復更新する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      const installedSkillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME, "SKILL.md");
      await writeFile(installedSkillPath, "broken installed skill\n", "utf8");

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "updated");
      assert.equal(await readFile(installedSkillPath, "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("古い managed skill に残った同梱 helper は次回 sync で除去する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      const skillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);
      await mkdir(path.join(skillPath, "bin"), { recursive: true });
      await writeFile(path.join(skillPath, "bin", "withmate-memory.mjs"), "old helper\n", "utf8");

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "updated");
      assert.equal(await pathExists(path.join(skillPath, "bin")), false);
      assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
      assert.equal(await readFile(path.join(skillPath, "reference", "cli.md"), "utf8"), "# CLI\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("同じ app version でも bundle 内容が変われば managed skill を更新する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      await writeFile(path.join(bundlePath, "SKILL.md"), "updated bundle\n", "utf8");

      const result = (await service.syncConfiguredProviderSkills())[0];
      const installedSkill = await readFile(
        path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME, "SKILL.md"),
        "utf8",
      );

      assert.equal(result?.status, "updated");
      assert.equal(installedSkill, "updated bundle\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("同じ app version でも reference 内容が変われば managed skill を更新する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "installed");
      await writeFile(path.join(bundlePath, "reference", "cli.md"), "# Updated CLI\n", "utf8");

      const result = (await service.syncConfiguredProviderSkills())[0];
      const installedReference = await readFile(
        path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME, "reference", "cli.md"),
        "utf8",
      );

      assert.equal(result?.status, "updated");
      assert.equal(installedReference, "# Updated CLI\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("user-created 同名 skill は上書きせず collision として skip する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const skillRootPath = path.join(rootPath, "skills");
      const userSkillPath = path.join(skillRootPath, WITHMATE_MEMORY_SKILL_NAME);
      await mkdir(userSkillPath, { recursive: true });
      await writeFile(path.join(userSkillPath, "SKILL.md"), "user skill", "utf8");

      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => {
          const settings = createDefaultAppSettings();
          settings.codingProviderSettings.codex = {
            enabled: true,
            apiKey: "",
            skillRootPath: rootPath,
            skillRelativePath: "skills",
            instructionRelativePath: "",
          };
          return settings;
        },
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "skipped-collision");
      assert.equal(await readFile(path.join(userSkillPath, "SKILL.md"), "utf8"), "user skill");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("同期を許可しない runtime では provider skill root を変更しない", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    const directRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-direct-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const existingSkillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);
      await mkdir(existingSkillPath, { recursive: true });
      await writeFile(path.join(existingSkillPath, "sentinel.txt"), "keep", "utf8");
      let appVersionReadCount = 0;
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => {
          appVersionReadCount += 1;
          return "43.1.0-test";
        },
        isPackagedApp: () => false,
        platform: "win32",
      });

      const configuredResult = (await service.syncConfiguredProviderSkills())[0];
      const directResult = await service.syncProviderSkill("direct", directRootPath);

      assert.equal(configuredResult?.status, "skipped-unpackaged");
      assert.equal(directResult.status, "skipped-unpackaged");
      assert.equal(await readFile(path.join(existingSkillPath, "sentinel.txt"), "utf8"), "keep");
      assert.equal(await pathExists(path.join(existingSkillPath, ".withmate-managed-skill.json")), false);
      assert.equal(await pathExists(path.join(directRootPath, WITHMATE_MEMORY_SKILL_NAME)), false);
      assert.equal(appVersionReadCount, 0);
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
      await rm(directRootPath, { recursive: true, force: true });
    }
  });

  it("skill root 未設定 provider は skipped-unconfigured にする", async () => {
    const bundlePath = await createBundle();
    try {
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => createDefaultAppSettings(),
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "win32",
      });

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "skipped-unconfigured");
      assert.equal(result?.skillPath, null);
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
    }
  });

  it("macOS では PATH shim 未整備の fallback として bundled helper を同期する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "darwin",
      });

      const result = (await service.syncConfiguredProviderSkills())[0];
      const skillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
      assert.equal(await readFile(path.join(skillPath, "bin", "withmate-memory.mjs"), "utf8"), "console.log('bundle helper');\n");
      assert.equal(await readFile(path.join(skillPath, "reference", "cli.md"), "utf8"), "# CLI\n");
      assert.equal((await service.syncConfiguredProviderSkills())[0]?.status, "unchanged");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("macOS でも PATH shim が利用可能なら Skill documentation と managed marker を同期する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-skill-root-"));
    try {
      const settings = createDefaultAppSettings();
      settings.codingProviderSettings.codex = {
        enabled: true,
        apiKey: "",
        skillRootPath: rootPath,
        skillRelativePath: "skills",
        instructionRelativePath: "",
      };
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => settings,
        getAppVersion: () => "5.0.0-test",
        isPackagedApp: () => true,
        platform: "darwin",
        shouldSyncSkillMarkdownOnly: () => true,
      });

      const result = (await service.syncConfiguredProviderSkills())[0];
      const skillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await pathExists(path.join(skillPath, "SKILL.md")), true);
      assert.equal(await pathExists(path.join(skillPath, "bin", "withmate-memory.mjs")), false);
      assert.equal(await readFile(path.join(skillPath, "reference", "cli.md"), "utf8"), "# CLI\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});

describe("withmate-memory bundled helper", () => {
  const helperPath = path.resolve("resources", "skills", WITHMATE_MEMORY_SKILL_NAME, "bin", "withmate-memory.mjs");

  it("canonical CLI source から生成された current artifact である", async () => {
    const outputDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-cli-build-"));
    try {
      await buildWithMateMemoryCli(outputDirectoryPath);
      assert.equal(
        normalizeLineEndings(await readFile(path.join(outputDirectoryPath, BUNDLED_MEMORY_CLI_FILE_NAME), "utf8")),
        normalizeLineEndings(await readFile(helperPath, "utf8")),
      );
    } finally {
      await rm(outputDirectoryPath, { recursive: true, force: true });
    }
  });

  it("依存のないisolated directoryでも生成CLIを起動できる", async () => {
    const outputDirectoryPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-cli-isolated-"));
    try {
      const isolatedHelperPath = await buildWithMateMemoryCli(outputDirectoryPath);
      const source = await readFile(isolatedHelperPath, "utf8");
      assert.doesNotMatch(source, /from\s+["'](?:@modelcontextprotocol\/sdk|zod)["']/);
      const { stdout } = await execFileAsync(process.execPath, [isolatedHelperPath, "schema"], {
        cwd: outputDirectoryPath,
        env: process.env,
      });
      assert.equal(JSON.parse(stdout).commands.includes("mcp-server"), true);
      const initialized = await initializeIsolatedMcpServer(isolatedHelperPath, outputDirectoryPath);
      assert.equal(initialized.name, "withmate-character-context");
    } finally {
      await rm(outputDirectoryPath, { recursive: true, force: true });
    }
  });

  it("runtime directory の discovery path で status できる", async () => {
    const tempRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-root-"));
    const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
    const runtimeDirectoryPath = path.join(tempRootPath, "withmate-memory", ownerSegment);
    const apiSecret = "test-secret";
    const operatorApiSecret = "test-operator-secret";
    const runtimeInstanceId = "runtime-from-discovery";
    const requestedPaths: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requestedPaths.push(`${request.method ?? "UNKNOWN"} ${url.pathname}${url.search}`);
      if (request.method === "POST" && url.pathname === "/v1/exchange") {
        const nonce = request.headers[WITHMATE_MEMORY_RUNTIME_NONCE_HEADER];
        response.writeEarlyHints({
          link: "</v1/exchange>; rel=preconnect",
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: runtimeInstanceId,
          [WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER]: createWithMateMemoryRuntimeChallenge(
            apiSecret,
            runtimeInstanceId,
            typeof nonce === "string" ? nonce : "",
          ),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(payload.apiSecret, apiSecret);
        assert.equal(payload.adapterSecret, operatorApiSecret);
        assert.equal(payload.operation.path, "/v1/status");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          schemaVersion: "withmate-memory-v1",
          status: "ok",
          runtimeInstanceId,
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      assert(address && typeof address === "object");
      await mkdir(runtimeDirectoryPath, { recursive: true });
      await writeFile(
        path.join(runtimeDirectoryPath, WITHMATE_MEMORY_DISCOVERY_FILE_NAME),
        `${JSON.stringify({
          schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
          adapter: "cli",
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiSecret,
          adapterSecret: operatorApiSecret,
          runtimeInstanceId,
          publishedAt: "2026-08-10T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const { stdout } = await execFileAsync(process.execPath, [helperPath, "status"], {
        env: {
          ...process.env,
          WITHMATE_MEMORY_RUNTIME_DIR: runtimeDirectoryPath,
          WITHMATE_MEMORY_DISCOVERY_FILE: "",
          WITHMATE_MEMORY_API_URL: "",
        },
      }).catch((error: unknown) => {
        throw new Error(`Bundled helper requests: ${JSON.stringify(requestedPaths)}`, { cause: error });
      });

      assert.equal(JSON.parse(stdout).runtimeInstanceId, runtimeInstanceId);
    } finally {
      server.close();
      await rm(tempRootPath, { recursive: true, force: true });
    }
  });

  it("current CLI command names を受け付け、未起動時は JSON error を返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "get-entry",
      "--json",
      '{"schemaVersion":"withmate-memory-v1","entryId":"entry-1","target":{"owner":"project","scope":"project","project":{"type":"id","id":"project-a"}}}',
    ], {
      env: {
        ...process.env,
        WITHMATE_MEMORY_DISCOVERY_FILE: path.join(tmpdir(), "withmate-memory-missing.json"),
      },
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_NOT_RUNNING");
  });

  it("stale discovery endpoint へ接続できない場合は JSON not running error を返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "status",
    ], {
      env: {
        ...process.env,
        WITHMATE_MEMORY_API_URL: "http://127.0.0.1:9",
        WITHMATE_MEMORY_API_SECRET: "stale-secret",
        WITHMATE_MEMORY_RUNTIME_INSTANCE_ID: "stale-runtime",
      },
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_NOT_RUNNING");
  });

  it("schema は helper 単体で capability を返す", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "schema"], {
      env: process.env,
    });

    const schema = JSON.parse(stdout);
    assert.deepEqual(schema.commands, [
      "help",
      "status",
      "characters",
      "file-usage",
      "list-targets",
      "list-entries",
      "audit",
      "search",
      "get-entry",
      "get-file",
      "export-files",
      "list-tags",
      "append",
      "forget",
      "move-entry",
      "context-get",
      "affect-appraise",
      "affect-inspect",
      "affect-correct",
      "affect-reset",
      "character-memory-search",
      "character-memory-append-episode",
      "character-memory-correct",
      "character-memory-forget",
      "character-metrics",
      "mcp-server",
      "schema",
      "validate",
    ]);
    assert.deepEqual(schema.requestBodyInputs, ["--json", "--file", "@file", "--stdin"]);
    assert(schema.entryKinds.includes("decision"));
    assert(schema.forgetReasons.includes("user_request"));
  });

  it("--stdin は standalone helper の process stdin から request body を読む", () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      targets: [
        { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      ],
      query: "release",
      kinds: ["decision"],
      limit: 20,
      cursor: "cursor-a",
    });
    const stdout = execFileSync(process.execPath, [
      helperPath,
      "validate",
      "--command",
      "search",
      "--stdin",
    ], {
      env: process.env,
      input: request,
      encoding: "utf8",
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.deepEqual(response.value.kinds, ["decision"]);
    assert.equal(response.value.limit, 20);
    assert.equal(response.value.cursor, "cursor-a");
  });

  it("validate は helper 単体で request を検証する", async () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "investigation",
      title: "Invalid",
      body: "Invalid",
      preview: "Invalid",
      tags: [],
    });
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "validate", "--command", "append", "--json", request], {
      env: process.env,
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 3);
      return { stdout: execError.stdout ?? "" };
    });

    const error = JSON.parse(stdout).error;
    assert.equal(error.code, "MEMORY_INVALID_FIELD");
    assert.equal(error.field, "kind");
  });

  it("validate は helper 側でも runtime validation と同じ失敗ケースを拒否する", async () => {
    const invalidCases = [
      {
        name: "unknown append field",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [],
          extra: true,
        },
        code: "MEMORY_UNKNOWN_FIELD",
        field: "request.extra",
      },
      {
        name: "invalid target shape",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target.project.id",
      },
      {
        name: "empty title",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: " ",
          body: "Body",
          preview: "Preview",
          tags: [],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "title",
      },
      {
        name: "invalid tag object",
        command: "append",
        request: {
          schemaVersion: "withmate-memory-v1",
          target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
          kind: "decision",
          title: "Title",
          body: "Body",
          preview: "Preview",
          tags: [{ type: "Topic", value: "CLI", extra: true }],
        },
        code: "MEMORY_UNKNOWN_FIELD",
        field: "tags[0].extra",
      },
      {
        name: "forget requires target",
        command: "forget",
        request: {
          schemaVersion: "withmate-memory-v1",
          entryIds: ["entry-a"],
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target",
      },
      {
        name: "get-entry requires target",
        command: "get-entry",
        request: {
          schemaVersion: "withmate-memory-v1",
          entryId: "entry-a",
        },
        code: "MEMORY_INVALID_FIELD",
        field: "target",
      },
    ];

    for (const testCase of invalidCases) {
      const { stdout } = await execFileAsync(process.execPath, [
        helperPath,
        "validate",
        "--command",
        testCase.command,
        "--json",
        JSON.stringify(testCase.request),
      ], {
        env: process.env,
      }).catch((error: unknown) => {
        const execError = error as { code?: number; stdout?: string };
        assert.equal(execError.code, 3, testCase.name);
        return { stdout: execError.stdout ?? "" };
      });

      const response = JSON.parse(stdout);
      assert.equal(response.error.code, testCase.code, testCase.name);
      assert.equal(response.error.field, testCase.field, testCase.name);
    }
  });

  it("validate は helper 側でも append request を正規化する", async () => {
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: " project-a " } },
      kind: "decision",
      title: " Title ",
      body: " Body ",
      preview: " Preview ",
      tags: [{ type: "Topic", value: " Release " }, { type: "topic", value: "release" }],
      supersedes: [" entry-a ", "entry-a"],
    });
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "validate", "--command", "append", "--json", request], {
      env: process.env,
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.equal(response.value.target.project.id, "project-a");
    assert.equal(response.value.title, "Title");
    assert.deepEqual(response.value.tags, [{
      type: "Topic",
      value: "Release",
      canonicalType: "topic",
      canonicalValue: "release",
    }]);
    assert.deepEqual(response.value.supersedes, ["entry-a"]);
  });

  it("validate は helper 側でも protected object 付き append を受け付ける", async () => {
    const filePath = path.resolve("artifact.bin");
    const request = JSON.stringify({
      schemaVersion: "withmate-memory-v1",
      target: { owner: "project", scope: "project", project: { type: "id", id: "project-a" } },
      kind: "context",
      title: "Artifact",
      body: "Artifact context.",
      preview: "Artifact preview.",
      tags: [],
      files: [{
        path: filePath,
        role: "artifact",
        summary: "Generated artifact.",
      }],
    });
    const { stdout } = await execFileAsync(process.execPath, [
      helperPath,
      "validate",
      "--command",
      "append",
      "--json",
      request,
    ], {
      env: process.env,
    });

    const response = JSON.parse(stdout);
    assert.equal(response.valid, true);
    assert.deepEqual(response.value.files, [{
      path: filePath,
      role: "artifact",
      summary: "Generated artifact.",
    }]);
  });

  it("read shorthand は helper でも request body を組み立てる", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "search", "--project", path.resolve("."), "--query", "cli"], {
      env: {
        ...process.env,
        WITHMATE_MEMORY_DISCOVERY_FILE: path.join(tmpdir(), "withmate-memory-missing.json"),
      },
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 2);
      return { stdout: execError.stdout ?? "" };
    });

    assert.equal(JSON.parse(stdout).error.code, "WITHMATE_NOT_RUNNING");
  });

  it("usage error は PATH CLI command 形式を案内する", async () => {
    const { stdout } = await execFileAsync(process.execPath, [helperPath, "nope"], {
      env: process.env,
    }).catch((error: unknown) => {
      const execError = error as { code?: number; stdout?: string };
      assert.equal(execError.code, 1);
      return { stdout: execError.stdout ?? "" };
    });

    const error = JSON.parse(stdout).error;
    assert.equal(error.code, "WITHMATE_MEMORY_CLI_USAGE");
    assert.match(error.message, /^Usage: withmate-memory /);
    assert.doesNotMatch(error.message, /node bin\/withmate-memory\.mjs/);
  });
});
