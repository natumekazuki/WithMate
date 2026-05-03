import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateMemoryStorage, type MateGeneratedMemoryInput } from "../../src-electron/mate-memory-storage.js";

function createTempDbPath(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-storage-")).then((tmpDir) => ({
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

function buildMemory(input: Partial<MateGeneratedMemoryInput>): MateGeneratedMemoryInput {
  return {
    sourceType: "session",
    growthSourceType: "assistant_inference",
    kind: "observation",
    targetSection: "core",
    statement: "ユーザーは新しいアプローチを好む",
    confidence: 80,
    salienceScore: 60,
    tags: [
      { type: "topic", value: "work" },
      { type: " Topic ", value: "Work" },
      { type: "topic", value: "focus" },
    ],
    ...input,
  };
}

describe("MateMemoryStorage", () => {
  it("saveGeneratedMemories は growth event とタグを保存し、catalog を upsert する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const [saved] = storage.saveGeneratedMemories({
        memories: [buildMemory({})],
      });

      assert.equal(saved.created, true);
      assert.equal(saved.state, "candidate");
      assert.equal(saved.tags.length, 2);

      const db = new DatabaseSync(dbPath);
      try {
        const eventCount = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        const event = db.prepare("SELECT statement_fingerprint, state FROM mate_growth_events WHERE id = ?").get(saved.id) as {
          statement_fingerprint: string;
          state: string;
        };
        const tagCount = db.prepare("SELECT COUNT(*) AS count FROM mate_memory_tags WHERE memory_id = ?").get(saved.id) as {
          count: number;
        };
        const catalogCount = db.prepare("SELECT COUNT(*) AS count FROM mate_memory_tag_catalog WHERE state = 'active'").get() as {
          count: number;
        };

        assert.equal(eventCount.count, 1);
        assert.equal(saved.statementFingerprint, event.statement_fingerprint);
        assert.equal(event.state, "candidate");
        assert.equal(tagCount.count, 2);
        assert.equal(catalogCount.count, 2);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("fingerprint が同じなら既存イベントを再利用して tags を更新する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const first = storage.saveGeneratedMemories({
        memories: [buildMemory({
          statement: "会話内容を要約すると理解が深まる",
          tags: [{ type: "topic", value: "work" }],
        })],
      });
      const second = storage.saveGeneratedMemories({
        memories: [buildMemory({
          statement: "会話内容を要約すると理解が深まる",
          statementFingerprint: first[0].statementFingerprint,
          tags: [{ type: "emotion", value: "calm" }],
        })],
      });

      assert.equal(first[0].id, second[0].id);
      assert.equal(second[0].created, false);
      assert.equal(second[0].tags.length, 1);
      assert.equal(second[0].tags[0].type, "emotion");

      const db = new DatabaseSync(dbPath);
      try {
        const eventCount = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        const tagRows = db.prepare("SELECT tag_type, tag_value FROM mate_memory_tags WHERE memory_id = ? ORDER BY id").all(
          first[0].id,
        ) as Array<{ tag_type: string; tag_value: string }>;

        assert.equal(eventCount.count, 1);
        assert.equal(tagRows.length, 1);
        assert.equal(tagRows[0].tag_type, "emotion");
        assert.equal(tagRows[0].tag_value, "calm");
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("deleteMemory は growth event を physical delete せず forgotten 化する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const [saved] = storage.saveGeneratedMemories({
        memories: [buildMemory({ statement: "忘却テスト用メモリ" })],
      });

      storage.deleteMemory(saved.id);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT state, forgotten_at FROM mate_growth_events WHERE id = ?").get(saved.id) as {
          state: string;
          forgotten_at: string | null;
        };
        assert.equal(row.state, "forgotten");
        assert.equal(typeof row.forgotten_at, "string");
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("listMemoryTagCatalog は active の catalog を tag_type/tag_value_normalized で重複なく返す", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      storage.saveGeneratedMemories({
        memories: [buildMemory({ tags: [{ type: "Mood", value: "Calm" }] })],
      });
      storage.saveGeneratedMemories({
        memories: [buildMemory({ statement: "別の statement", tags: [{ type: " mood ", value: "calm " }] })],
      });

      const catalog = storage.listMemoryTagCatalog();
      const moodEntries = catalog.filter((entry) => entry.tagValueNormalized === "calm");
      assert.equal(moodEntries.length, 1);
      assert.equal(moodEntries[0].tagType, "mood");
      assert.equal(moodEntries[0].usageCount, 2);
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});
