import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  ManagedMemorySkillService,
  WITHMATE_MEMORY_SKILL_NAME,
} from "../../src-electron/managed-memory-skill-service.js";
import {
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";

const execFileAsync = promisify(execFile);

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
  return bundlePath;
}

describe("ManagedMemorySkillService", () => {
  it("設定済み provider skill root に bundled skill と managed marker を install する", async () => {
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
      });

      const results = await service.syncConfiguredProviderSkills();
      const result = results.find((entry) => entry.providerId === "codex");
      const skillPath = path.join(rootPath, ".codex", "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
      assert.match(await readFile(path.join(skillPath, ".withmate-managed-skill.json"), "utf8"), /"managedBy": "WithMate"/);
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
      });

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "skipped-collision");
      assert.equal(await readFile(path.join(userSkillPath, "SKILL.md"), "utf8"), "user skill");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("skill root 未設定 provider は skipped-unconfigured にする", async () => {
    const bundlePath = await createBundle();
    try {
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => createDefaultAppSettings(),
        getAppVersion: () => "5.0.0-test",
      });

      const result = (await service.syncConfiguredProviderSkills())[0];

      assert.equal(result?.status, "skipped-unconfigured");
      assert.equal(result?.skillPath, null);
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
    }
  });
});

describe("withmate-memory bundled helper", () => {
  const helperPath = path.resolve("resources", "skills", WITHMATE_MEMORY_SKILL_NAME, "bin", "withmate-memory.mjs");

  it("runtime が生成する既定 discovery path で status できる", async () => {
    const tempRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-root-"));
    const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
    const runtimeDirectoryPath = path.join(tempRootPath, "withmate-memory", ownerSegment);
    const apiSecret = "test-secret";
    const runtimeInstanceId = "runtime-from-discovery";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const nonce = url.searchParams.get("nonce") ?? "";
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          schemaVersion: "withmate-memory-v1",
          status: "ok",
          runtimeInstanceId,
          challenge: {
            nonce,
            hmacSha256: createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url"),
          },
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
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiSecret,
          runtimeInstanceId,
        })}\n`,
        "utf8",
      );

      const { stdout } = await execFileAsync(process.execPath, [helperPath, "status"], {
        env: {
          ...process.env,
          TMP: tempRootPath,
          TEMP: tempRootPath,
          TMPDIR: tempRootPath,
          WITHMATE_MEMORY_RUNTIME_DIR: "",
          WITHMATE_MEMORY_DISCOVERY_FILE: "",
          WITHMATE_MEMORY_API_URL: "",
        },
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
      '{"schemaVersion":"withmate-memory-v1","entryId":"entry-1"}',
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

  it("future helper flags ではなく raw JSON/file contract を要求する", async () => {
    await execFileAsync(process.execPath, [helperPath, "search", "--project", "."], {
      env: process.env,
    }).then(
      () => assert.fail("unknown option should fail"),
      (error: unknown) => {
        const execError = error as { code?: number; stdout?: string };
        assert.equal(execError.code, 1);
        assert.equal(JSON.parse(execError.stdout ?? "{}").error.code, "WITHMATE_MEMORY_CLI_USAGE");
      },
    );
  });
});
