import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MemoryRuntimeWorkspaceService, type MemoryRuntimeInstructionFile } from "../../src-electron/memory-runtime-workspace.js";
import { MateMemoryGenerationService } from "../../src-electron/mate-memory-generation-service.js";
import { MateMemoryStorage } from "../../src-electron/mate-memory-storage.js";

function createTempDbPath(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-generation-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

function seedCurrentMateProfile(dbPath: string): void {
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  try {
    const insertProfileStmt = db.prepare(`
      INSERT OR IGNORE INTO mate_profile (
        id,
        state,
        display_name,
        description,
        theme_main,
        theme_sub,
        avatar_file_path,
        avatar_sha256,
        avatar_byte_size,
        profile_generation,
        created_at,
        updated_at
      ) VALUES ('current', 'active', 'current', '', '#6f8cff', '#6fb8c7', '', '', 0, 1, ?, ?)
    `);
    insertProfileStmt.run(now, now);
  } finally {
    db.close();
  }
}

function buildInstructionFiles(): readonly MemoryRuntimeInstructionFile[] {
  return [
    { relativePath: "AGENTS.md", content: "# AGENTS\n" },
    { relativePath: "provider/copilot/COPILOT.md", content: "# COPILOT\n" },
  ];
}

describe("MateMemoryGenerationService", () => {
  it("schema-valid な response は DB に保存されて instruction files が書き込まれる", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });
      const workspacePath = workspace.getWorkspacePath();
      const lockPath = path.join(workspacePath, ".lock");

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        async runStructuredGeneration() {
          return {
            parsedJson: {
              memories: [{
                statement: "ユーザーは UI 実装の優先順位を明確化することを好む。",
                growthSourceType: "assistant_inference",
                kind: "observation",
                targetSection: "core",
                confidence: 80,
                salienceScore: 78,
                tags: [{ type: "Topic", value: "work" }],
              }],
            },
            rawText: "{\"invalid\"",
            usage: {
              inputTokens: 45,
              cachedInputTokens: 0,
              outputTokens: 120,
            },
            provider: "copilot",
            model: "mock-1",
            threadId: "thread-1",
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [{ tagType: "Topic", tagValue: "work" }];
        },
        async getInstructionFiles(_input) {
          return buildInstructionFiles();
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce({
        sourceDefaults: {
          sourceType: "session",
          sourceSessionId: "session-1",
          sourceAuditLogId: 101,
          projectDigestId: "project-1",
        },
        mateName: "Mate",
        mateSummary: "テストMate",
      });

      const db = new DatabaseSync(dbPath);
      try {
        const savedEvent = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        const savedCatalog = db.prepare("SELECT COUNT(*) AS count FROM mate_memory_tag_catalog").get() as { count: number };
        assert.equal(savedEvent.count, 1);
        assert.equal(savedCatalog.count, 1);
      } finally {
        db.close();
      }

      const agentsContent = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
      const copilotContent = await readFile(path.join(workspacePath, "provider", "copilot", "COPILOT.md"), "utf8");
      const lockReleased = await exists(lockPath);

      assert.equal(result.skipped, false);
      assert.equal(result.savedCount, 1);
      assert.equal(result.provider, "copilot");
      assert.equal(result.model, "mock-1");
      assert.equal(result.threadId, "thread-1");
      assert.equal(result.usage?.inputTokens, 45);
      assert.equal(agentsContent, "# AGENTS\n");
      assert.equal(copilotContent, "# COPILOT\n");
      assert.equal(lockReleased, false);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("invalid な schema は保存しない", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });
      const workspacePath = workspace.getWorkspacePath();
      const lockPath = path.join(workspacePath, ".lock");

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        async runStructuredGeneration() {
          return {
            rawText: JSON.stringify({
              memories: [{
                statement: "不正な kind",
                growthSourceType: "assistant_inference",
                kind: "invalid_kind",
                targetSection: "core",
                confidence: 10,
                salienceScore: 20,
              }],
            }),
            usage: null,
            provider: "copilot",
            model: "mock-1",
            threadId: null,
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [{ tagType: "Topic", tagValue: "work" }];
        },
        async getInstructionFiles(_input) {
          return buildInstructionFiles();
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      await assert.rejects(() => service.runOnce({
        sourceDefaults: {
          sourceType: "session",
        },
      }), /kind が不正だよ。/);

      const db = new DatabaseSync(dbPath);
      try {
        const savedEvent = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        assert.equal(savedEvent.count, 0);
      } finally {
        db.close();
      }

      const lockReleased = await exists(lockPath);
      assert.equal(lockReleased, false);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("ロック競合時は skipped を返し lock を奪いに行かない", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });
      const workspacePath = workspace.getWorkspacePath();
      const lockPath = path.join(workspacePath, ".lock");
      await mkdir(workspacePath, { recursive: true });
      await writeFile(lockPath, "locked", "utf8");

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        runStructuredGeneration() {
          throw new Error("should not call");
        },
        async getTagCatalog() {
          return [];
        },
        async getInstructionFiles(_input) {
          return [];
        },
        async getRecentConversationText() {
          return "";
        },
      });

      const result = await service.runOnce({
        sourceDefaults: {
          sourceType: "session",
        },
      });

      assert.equal(result.skipped, true);
      assert.equal(result.savedCount, 0);
      assert.equal(await readFile(lockPath, "utf8"), "locked");
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}


