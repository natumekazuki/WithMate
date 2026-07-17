import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("ManagedMemorySkillService", () => {
  it("設定済み provider skill root に Skill.md と managed marker だけを install する", async () => {
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
        platform: "win32",
      });

      const results = await service.syncConfiguredProviderSkills();
      const result = results.find((entry) => entry.providerId === "codex");
      const skillPath = path.join(rootPath, ".codex", "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), await readFile(path.join(bundlePath, "SKILL.md"), "utf8"));
      assert.match(await readFile(path.join(skillPath, ".withmate-managed-skill.json"), "utf8"), /"managedBy": "WithMate"/);
      assert.equal(await pathExists(path.join(skillPath, "bin")), false);
      assert.equal(await pathExists(path.join(skillPath, "reference")), false);
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

  it("skill root 未設定 provider は skipped-unconfigured にする", async () => {
    const bundlePath = await createBundle();
    try {
      const service = new ManagedMemorySkillService({
        bundledSkillPath: bundlePath,
        getAppSettings: () => createDefaultAppSettings(),
        getAppVersion: () => "5.0.0-test",
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

  it("macOS でも PATH shim が利用可能なら Skill.md と managed marker だけを同期する", async () => {
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
        platform: "darwin",
        shouldSyncSkillMarkdownOnly: () => true,
      });

      const result = (await service.syncConfiguredProviderSkills())[0];
      const skillPath = path.join(rootPath, "skills", WITHMATE_MEMORY_SKILL_NAME);

      assert.equal(result?.status, "installed");
      assert.equal(await pathExists(path.join(skillPath, "SKILL.md")), true);
      assert.equal(await pathExists(path.join(skillPath, "bin", "withmate-memory.mjs")), false);
      assert.equal(await pathExists(path.join(skillPath, "reference", "cli.md")), false);
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
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
    assert.deepEqual(schema.requestBodyInputs, ["--json", "--file", "@file", "--stdin"]);
    assert(schema.entryKinds.includes("decision"));
    assert(schema.forgetReasons.includes("user_request"));
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
