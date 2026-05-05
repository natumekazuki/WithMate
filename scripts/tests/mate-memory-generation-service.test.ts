import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MemoryRuntimeWorkspaceService, type MemoryRuntimeInstructionFile } from "../../src-electron/memory-runtime-workspace.js";
import { MateMemoryGenerationService, type GetInstructionFilesInput } from "../../src-electron/mate-memory-generation-service.js";
import { MateGrowthStorage } from "../../src-electron/mate-growth-storage.js";
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

function seedProfileItem(dbPath: string, id: string): void {
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO mate_profile_items (
        id,
        mate_id,
        section_key,
        category,
        claim_key,
        claim_value,
        claim_value_normalized,
        rendered_text,
        normalized_claim,
        confidence,
        salience_score,
        state,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      ) VALUES (?, 'current', 'core', 'preference', ?, ?, ?, ?, ?, 80, 80, 'active', ?, ?, ?, ?)
    `).run(id, `${id}-claim`, id, id, id, id, now, now, now, now);
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
    let capturedInstructionInput: GetInstructionFilesInput | null = null;
    const relevantMemories = [{
      id: "memory-1",
      state: "applied",
      kind: "observation",
      targetSection: "core",
      relation: "updates",
      targetClaimKey: "claim",
      statement: "既存 snapshot memory",
      salienceScore: 75,
      updatedAt: "2026-01-03T00:00:00.000Z",
      tags: [{ type: "Topic", value: "work" }],
    }];
    const relevantProfileItems = [{
      id: "profile-1",
      sectionKey: "core",
      category: "preference",
      claimKey: "claim",
      renderedText: "短い返信を好む",
      salienceScore: 72,
      updatedAt: "2026-01-03T00:10:00.000Z",
      tags: [{ type: "Style", value: "brief" }],
    }];
    const forgottenTombstones = [{
      id: "tombstone-1",
      digestKind: "growth_statement",
      category: "preference",
      sectionKey: "work_style",
      projectDigestId: "project-1",
      sourceGrowthEventId: "memory-1",
      sourceProfileItemId: null,
      createdAt: "2026-01-03T00:20:00.000Z",
    }];
    const existingTagCatalog = [{
      tagType: "Topic",
      tagValue: "work",
      tagValueNormalized: "work",
      description: "既存の作業分類",
      aliases: "",
      usageCount: 9,
      createdBy: "app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }];
    const sourceDefaults = {
      sourceType: "session",
      sourceSessionId: "session-1",
      sourceAuditLogId: 101,
      projectDigestId: "project-1",
    };

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
          return existingTagCatalog;
        },
        async getRelevantMemories() {
          return relevantMemories;
        },
        async getRelevantProfileItems() {
          return relevantProfileItems;
        },
        async getForgottenTombstones() {
          return forgottenTombstones;
        },
        async getInstructionFiles(input) {
          capturedInstructionInput = input;
          return buildInstructionFiles();
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce({
        sourceDefaults,
        providerIds: ["copilot"],
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
      assert.notEqual(capturedInstructionInput, null);
      const instructionInput = capturedInstructionInput as unknown as GetInstructionFilesInput;
      assert.equal(Array.isArray(instructionInput.providerIds), true);
      assert.deepEqual(instructionInput.providerIds, ["copilot"]);
      assert.equal(instructionInput.recentConversationText, "ユーザー: 最近の会話テキスト");
      assert.deepEqual(instructionInput.existingTagCatalog, existingTagCatalog);
      assert.deepEqual(instructionInput.sourceDefaults, sourceDefaults);
      assert.deepEqual(instructionInput.relevantMemories, relevantMemories);
      assert.deepEqual(instructionInput.relevantProfileItems, relevantProfileItems);
      assert.deepEqual(instructionInput.forgottenTombstones, forgottenTombstones);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("relevant 取得 deps が未設定でも prompt には空配列が渡される", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;
    let capturedInstructionInput: GetInstructionFilesInput | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        async runStructuredGeneration() {
          return {
            parsedJson: {
              memories: [{
                statement: "要約は短く。",
                growthSourceType: "assistant_inference",
                kind: "observation",
                targetSection: "core",
                confidence: 70,
                salienceScore: 60,
              }],
            },
            rawText: "{\"invalid\"",
            usage: null,
            provider: "copilot",
            model: "mock-empty",
            threadId: "thread-empty",
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [];
        },
        async getInstructionFiles(input) {
          capturedInstructionInput = input;
          return [];
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce({
        sourceDefaults: {
          sourceType: "session",
        },
      });

      assert.equal(result.savedCount, 1);
      assert.notEqual(capturedInstructionInput, null);
      const instructionInput = capturedInstructionInput as unknown as GetInstructionFilesInput;
      assert.deepEqual(instructionInput.relevantMemories, []);
      assert.deepEqual(instructionInput.relevantProfileItems, []);
      assert.deepEqual(instructionInput.forgottenTombstones, []);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("catalog を使って tags を正規化し、catalog 不一致は newTags として保存される", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        async runStructuredGeneration() {
          return {
            parsedJson: {
              memories: [{
                statement: "タグ正規化と unknown の newTags 化を確認する",
                growthSourceType: "assistant_inference",
                kind: "observation",
                targetSection: "core",
                confidence: 72,
                salienceScore: 70,
                tags: [
                  { type: "topic", value: "work" },
                  { type: "topic", value: "focus" },
                ],
              }],
            },
            rawText: "{\"invalid\"",
            usage: null,
            provider: "copilot",
            model: "mock-catalog",
            threadId: "thread-catalog",
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [{
            tagType: "Topic",
            tagValue: "Work",
            tagValueNormalized: "work",
            description: "既存タグ",
            aliases: "",
            usageCount: 1,
            createdBy: "app",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }];
        },
        async getInstructionFiles(_input) {
          return [];
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce({
        sourceDefaults: {
          sourceType: "session",
        },
      });

      assert.equal(result.savedCount, 1);

      const db = new DatabaseSync(dbPath);
      try {
        const source = db.prepare(`
          SELECT id FROM mate_growth_events WHERE statement = ?
        `).get("タグ正規化と unknown の newTags 化を確認する") as {
          id: string;
        };
        const tagRows = db.prepare(`
          SELECT tag_type, tag_value
          FROM mate_memory_tags
          WHERE memory_id = ?
          ORDER BY tag_type, tag_value
        `).all(source.id) as Array<{ tag_type: string; tag_value: string }>;
        const catalogRows = db.prepare(`
          SELECT tag_type, tag_value, tag_value_normalized
          FROM mate_memory_tag_catalog
          WHERE tag_value_normalized IN ('work', 'focus')
          ORDER BY tag_value_normalized
        `).all() as Array<{ tag_type: string; tag_value: string; tag_value_normalized: string }>;
        const normalizedTagRows = tagRows.map((row) => ({ ...row }));
        const normalizedCatalogRows = catalogRows.map((row) => ({ ...row }));

        assert.equal(normalizedTagRows.length, 2);
        assert.equal(normalizedCatalogRows.length, 2);
        assert.equal(normalizedTagRows.some((row) => row.tag_type === "topic" && row.tag_value === "Work"), true);
        assert.equal(normalizedTagRows.some((row) => row.tag_type === "topic" && row.tag_value === "focus"), true);
        assert.equal(normalizedCatalogRows.some((row) => row.tag_type === "topic" && row.tag_value === "Work" && row.tag_value_normalized === "work"), true);
        assert.equal(normalizedCatalogRows.some((row) => row.tag_type === "topic" && row.tag_value === "focus" && row.tag_value_normalized === "focus"), true);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("schema-valid な typed refs は生成サービス経由で link table へ保存される", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      seedProfileItem(dbPath, "profile-existing");
      storage.saveGeneratedMemories({
        memories: [{
          sourceType: "session",
          growthSourceType: "assistant_inference",
          kind: "observation",
          targetSection: "core",
          statement: "既存 memory",
          statementFingerprint: "fp-existing-memory",
          confidence: 80,
          salienceScore: 70,
          id: "memory-existing",
        }],
      });

      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });
      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        async runStructuredGeneration() {
          return {
            parsedJson: {
              memories: [{
                statement: "ユーザーは短い確認を好む。",
                growthSourceType: "assistant_inference",
                kind: "preference",
                targetSection: "work_style",
                confidence: 88,
                salienceScore: 76,
                relation: "updates",
                relatedRefs: [
                  { type: "memory", id: "memory-existing" },
                  { type: "profile_item", id: "profile-existing" },
                  { type: "profile_item", id: "profile-missing" },
                ],
                supersedesRefs: [],
                targetClaimKey: "reply_length",
                tags: [{ type: "Topic", value: "work" }],
                newTags: [{ type: "Style", value: "brief", reason: "短い確認という分類が必要" }],
                sourceType: "session",
                sourceSessionId: "session-refs",
                sourceAuditLogId: 444,
                projectDigestId: null,
              }],
            },
            rawText: "{\"invalid\"",
            usage: null,
            provider: "copilot",
            model: "mock-refs",
            threadId: "thread-refs",
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [{ tagType: "Topic", tagValue: "work" }];
        },
        async getInstructionFiles(_input) {
          return [];
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce();
      assert.equal(result.savedCount, 1);

      const db = new DatabaseSync(dbPath);
      try {
        const source = db.prepare("SELECT id FROM mate_growth_events WHERE statement = ?").get("ユーザーは短い確認を好む。") as {
          id: string;
        };
        const memoryLinks = db.prepare(`
          SELECT target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = ?
        `).all(source.id) as Array<{ target_growth_event_id: string; link_type: string }>;
        const profileLinks = db.prepare(`
          SELECT profile_item_id, link_type
          FROM mate_growth_event_profile_item_links
          WHERE growth_event_id = ?
        `).all(source.id) as Array<{ profile_item_id: string; link_type: string }>;
        const tagRows = db.prepare(`
          SELECT tag_type, tag_value
          FROM mate_memory_tags
          WHERE memory_id = ?
          ORDER BY tag_type, tag_value
        `).all(source.id) as Array<{ tag_type: string; tag_value: string }>;

        assert.deepEqual(memoryLinks.map((row) => ({ ...row })), [{
          target_growth_event_id: "memory-existing",
          link_type: "updates",
        }]);
        assert.deepEqual(profileLinks.map((row) => ({ ...row })), [{
          profile_item_id: "profile-existing",
          link_type: "updates",
        }]);
        assert.deepEqual(tagRows.map((row) => ({ ...row })), [{
          tag_type: "style",
          tag_value: "brief",
        }, {
          tag_type: "topic",
          tag_value: "work",
        }]);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("growthStorage を指定すると growth run と event が呼ばれる", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;

    const growthRuns: unknown[] = [];
    const growthUpserts: unknown[] = [];
    const growthFinishes: unknown[] = [];
    const growthFails: unknown[] = [];

    const growthStorage = {
      createRun(input: unknown) {
        growthRuns.push(input);
        return 77;
      },
      upsertEvent(input: unknown) {
        growthUpserts.push(input);
        return { id: "growth-event", created: true, state: "candidate" as const };
      },
      finishRun(runId: unknown, input: unknown) {
        growthFinishes.push({ runId, input });
      },
      failRun(runId: unknown, errorPreview: unknown) {
        growthFails.push({ runId, errorPreview });
      },
    };

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        growthStorage,
        async runStructuredGeneration() {
          return {
            parsedJson: {
              memories: [{
                statement: "ユーザーは丁寧語をよく使う。",
                growthSourceType: "assistant_inference",
                kind: "conversation",
                targetSection: "core",
                confidence: 90,
                salienceScore: 72,
                tags: [{ type: "Topic", value: "language" }],
                relation: "updates",
                relatedRefs: ["event-old"],
                supersedesRefs: ["event-superseded"],
              }, {
                statement: "投影対象が不明な知見",
                growthSourceType: "assistant_inference",
                kind: "observation",
                targetSection: "none",
                confidence: 40,
                salienceScore: 20,
              }],
            },
            rawText: "{\"invalid\"",
            usage: null,
            provider: "copilot",
            model: "mock-2",
            threadId: "thread-2",
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [];
        },
        async getInstructionFiles(_input) {
          return [];
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      const result = await service.runOnce({
        sourceDefaults: {
          sourceType: "session",
          sourceSessionId: "session-77",
          sourceAuditLogId: 333,
          projectDigestId: "project-77",
        },
      });

      assert.equal(result.savedCount, 2);
      assert.equal(growthRuns.length, 1);
      assert.equal(growthUpserts.length, 2);
      assert.equal(growthFinishes.length, 1);
      assert.equal(growthFails.length, 0);

      const run = growthRuns[0] as {
        triggerReason: string;
        sourceType: string;
        sourceSessionId: string | null;
        sourceAuditLogId: number | null;
        projectDigestId: string | null;
        providerId: string | null;
        model: string | null;
        candidateCount: number;
      };
      assert.equal(run.triggerReason, "mate-memory-generation");
      assert.equal(run.sourceType, "session");
      assert.equal(run.sourceSessionId, "session-77");
      assert.equal(run.sourceAuditLogId, 333);
      assert.equal(run.projectDigestId, "project-77");
      assert.equal(run.providerId, "copilot");
      assert.equal(run.model, "mock-2");
      assert.equal(run.candidateCount, 2);

      const firstEvent = growthUpserts[0] as {
        targetSection: string;
        projectionAllowed: boolean;
        sourceGrowthRunId: number;
        relation: string;
      };
      const secondEvent = growthUpserts[1] as { targetSection: string; projectionAllowed: boolean; sourceGrowthRunId: number };
      assert.equal(firstEvent.sourceGrowthRunId, 77);
      assert.equal(firstEvent.targetSection, "core");
      assert.equal(firstEvent.projectionAllowed, true);
      assert.equal(firstEvent.relation, "updates");
      assert.equal(secondEvent.sourceGrowthRunId, 77);
      assert.equal(secondEvent.targetSection, "none");
      assert.equal(secondEvent.projectionAllowed, false);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("growthStorage 付きで schema invalid は save せず failed run が記録される", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;
    const growthRuns: unknown[] = [];
    const growthUpserts: unknown[] = [];
    const growthFinishes: unknown[] = [];
    const growthFails: unknown[] = [];

    const growthStorage = {
      createRun(input: unknown) {
        growthRuns.push(input);
        return 88;
      },
      upsertEvent(input: unknown) {
        growthUpserts.push(input);
      },
      finishRun(runId: unknown, input: unknown) {
        growthFinishes.push({ runId, input });
      },
      failRun(runId: unknown, errorPreview: unknown) {
        growthFails.push({ runId, errorPreview });
      },
    };

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });
      const workspacePath = workspace.getWorkspacePath();
      const lockPath = path.join(workspacePath, ".lock");

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        growthStorage,
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
            model: "mock-invalid-schema",
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
          sourceSessionId: "session-88",
          sourceAuditLogId: 808,
          projectDigestId: "project-88",
        },
        providerIds: ["copilot"],
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
      assert.equal(growthRuns.length, 1);
      assert.equal(growthFinishes.length, 0);
      assert.equal(growthUpserts.length, 0);
      assert.equal(growthFails.length, 1);

      const run = growthRuns[0] as {
        triggerReason: string;
        sourceType: string;
        sourceSessionId: string | null;
        sourceAuditLogId: number | null;
        projectDigestId: string | null;
        providerId: string | null;
        model: string | null;
        candidateCount: number;
      };
      assert.equal(run.sourceType, "session");
      assert.equal(run.sourceSessionId, "session-88");
      assert.equal(run.sourceAuditLogId, 808);
      assert.equal(run.projectDigestId, "project-88");
      assert.equal(run.providerId, "copilot");
      assert.equal(run.model, "mock-invalid-schema");
      assert.equal(run.candidateCount, 0);
      assert.equal(run.triggerReason, "mate-memory-generation");

      const fail = growthFails[0] as { errorPreview: string };
      assert.equal(fail.errorPreview.includes("kind が不正だよ"), true);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("growthStorage 付きで JSON parse failure も failed run が記録される", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;
    const growthRuns: unknown[] = [];
    const growthFails: unknown[] = [];

    const growthStorage = {
      createRun(input: unknown) {
        growthRuns.push(input);
        return 89;
      },
      upsertEvent() {
        throw new Error("should not upsert");
      },
      finishRun() {
        throw new Error("should not finish");
      },
      failRun(runId: unknown, errorPreview: unknown) {
        growthFails.push({ runId, errorPreview });
      },
    };

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        growthStorage,
        async runStructuredGeneration() {
          return {
            rawText: "{\"memories\":[",
            usage: null,
            provider: "copilot",
            model: "mock-invalid-json",
            threadId: null,
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [];
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
          sourceType: "mate_talk",
          sourceSessionId: "mate-talk-1",
        },
      }));

      const db = new DatabaseSync(dbPath);
      try {
        const savedEvent = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        assert.equal(savedEvent.count, 0);
      } finally {
        db.close();
      }

      assert.equal(growthRuns.length, 1);
      assert.equal(growthFails.length, 1);
      const run = growthRuns[0] as {
        sourceType: string;
        sourceSessionId: string | null;
        providerId: string | null;
        model: string | null;
        candidateCount: number;
      };
      assert.equal(run.sourceType, "mate_talk");
      assert.equal(run.sourceSessionId, "mate-talk-1");
      assert.equal(run.providerId, "copilot");
      assert.equal(run.model, "mock-invalid-json");
      assert.equal(run.candidateCount, 0);
      const fail = growthFails[0] as { runId: number; errorPreview: string };
      assert.equal(fail.runId, 89);
      assert.equal(fail.errorPreview.length > 0, true);
    } finally {
      storage?.close();
      await cleanupDb();
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("実 DB の growthStorage でも invalid response は failed run として残る", async () => {
    const { dbPath, cleanup: cleanupDb } = await createTempDbPath();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-workspace-"));
    let storage: MateMemoryStorage | null = null;
    let growthStorage: MateGrowthStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      growthStorage = new MateGrowthStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const workspace = new MemoryRuntimeWorkspaceService({ userDataPath });

      const service = new MateMemoryGenerationService({
        workspace,
        storage,
        growthStorage,
        async runStructuredGeneration() {
          return {
            rawText: JSON.stringify({
              memories: [{
                statement: "不正な source",
                growthSourceType: "assistant_inference",
                kind: "invalid_kind",
                targetSection: "core",
                confidence: 10,
                salienceScore: 20,
              }],
            }),
            usage: null,
            provider: "copilot",
            model: "mock-real-growth-storage",
            threadId: null,
            rawItemsJson: "{\"type\":\"mock\"}",
          };
        },
        async getTagCatalog() {
          return [];
        },
        async getInstructionFiles(_input) {
          return [];
        },
        async getRecentConversationText() {
          return "ユーザー: 最近の会話テキスト";
        },
      });

      await assert.rejects(() => service.runOnce(), /kind が不正だよ。/);

      const db = new DatabaseSync(dbPath);
      try {
        const savedEvent = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        const run = db.prepare(`
          SELECT source_type, provider_id, model, status, candidate_count, error_preview
          FROM mate_growth_runs
          ORDER BY id DESC
          LIMIT 1
        `).get() as {
          source_type: string;
          provider_id: string;
          model: string;
          status: string;
          candidate_count: number;
          error_preview: string;
        };

        assert.equal(savedEvent.count, 0);
        assert.equal(run.source_type, "session");
        assert.equal(run.provider_id, "copilot");
        assert.equal(run.model, "mock-real-growth-storage");
        assert.equal(run.status, "failed");
        assert.equal(run.candidate_count, 0);
        assert.equal(run.error_preview.includes("kind が不正だよ"), true);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      growthStorage?.close();
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
