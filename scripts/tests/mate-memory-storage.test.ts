import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateMemoryStorage, type MateGeneratedMemoryInput } from "../../src-electron/mate-memory-storage.js";

const BASE_TIME = "2026-01-02T00:00:00.000Z";

function createTempDbPath(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-memory-storage-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

function seedProfileItem(dbPath: string, id: string): void {
  const now = BASE_TIME;
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
    `).run(id, `${id}-claim`, id, id, id, now, now, now, now, now);
  } finally {
    db.close();
  }
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

  it("saveGeneratedMemories は relatedRefs / supersedesRefs を event link として保存する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-related",
          statement: "関連元のメモリ",
          statementFingerprint: "fp-related",
        })],
      });
      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-superseded",
          statement: "上書き対象のメモリ",
          statementFingerprint: "fp-superseded",
        })],
      });

      const [saved] = storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-source",
          statement: "保存対象メモリ",
          statementFingerprint: "fp-source",
          relation: "updates",
          relatedRefs: ["mem-related", "mem-related", "mem-source", "mem-missing"],
          supersedesRefs: ["mem-superseded"],
        })],
      });

      assert.equal(saved.id, "mem-source");

      const db = new DatabaseSync(dbPath);
      try {
        const links = db.prepare(`
          SELECT source_growth_event_id, target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'mem-source'
          ORDER BY target_growth_event_id, link_type
        `).all() as Array<{ source_growth_event_id: string; target_growth_event_id: string; link_type: string }>;

        assert.deepEqual(links.map((link) => ({ ...link })), [{
          source_growth_event_id: "mem-source",
          target_growth_event_id: "mem-related",
          link_type: "updates",
        }, {
          source_growth_event_id: "mem-source",
          target_growth_event_id: "mem-superseded",
          link_type: "supersedes",
        }]);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("saveGeneratedMemories は refs 省略更新では既存 link を保持し、明示空配列では削除する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-related",
          statement: "関連元",
          statementFingerprint: "fp-related-keep",
        })],
      });
      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-source",
          statement: "更新対象",
          statementFingerprint: "fp-source-keep",
          relation: "updates",
          relatedRefs: ["mem-related"],
          supersedesRefs: [],
        })],
      });

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-source",
          statement: "更新対象",
          statementFingerprint: "fp-source-keep",
          relation: "updates",
        })],
      });

      const dbAfterOmitted = new DatabaseSync(dbPath);
      try {
        const countAfterOmitted = dbAfterOmitted.prepare(`
          SELECT COUNT(*) AS count
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'mem-source'
        `).get() as { count: number };
        assert.equal(countAfterOmitted.count, 1);
      } finally {
        dbAfterOmitted.close();
      }

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-source",
          statement: "更新対象",
          statementFingerprint: "fp-source-keep",
          relation: "updates",
          relatedRefs: [],
          supersedesRefs: [],
        })],
      });

      const dbAfterExplicitEmpty = new DatabaseSync(dbPath);
      try {
        const countAfterExplicitEmpty = dbAfterExplicitEmpty.prepare(`
          SELECT COUNT(*) AS count
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'mem-source'
        `).get() as { count: number };
        assert.equal(countAfterExplicitEmpty.count, 0);
      } finally {
        dbAfterExplicitEmpty.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("listRelevantMemoriesForGeneration は state フィルタ付きで limit 付きソート結果とタグを返す", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      storage.saveGeneratedMemories({ memories: [buildMemory({
        id: "memory-new",
        statement: "新規情報",
        statementFingerprint: "fp-new",
        salienceScore: 70,
        tags: [{ type: "Topic", value: "Focus" }],
      })] });
      storage.saveGeneratedMemories({ memories: [buildMemory({
        id: "memory-old",
        statement: "既存情報",
        statementFingerprint: "fp-old",
        salienceScore: 70,
        tags: [{ type: "Topic", value: "Work" }],
      })] });
      storage.saveGeneratedMemories({ memories: [buildMemory({
        id: "memory-low",
        statement: "低優先情報",
        statementFingerprint: "fp-low",
        salienceScore: 65,
        tags: [{ type: "Topic", value: "Calm" }],
      })] });
      storage.saveGeneratedMemories({ memories: [buildMemory({
        id: "memory-failed",
        statement: "失敗除外情報",
        statementFingerprint: "fp-failed",
        salienceScore: 90,
        tags: [{ type: "Mood", value: "failed" }],
      })] });
      storage.saveGeneratedMemories({ memories: [buildMemory({
        id: "memory-forgot",
        statement: "忘却除外情報",
        statementFingerprint: "fp-forgot",
        salienceScore: 80,
        tags: [{ type: "Mood", value: "forgot" }],
      })] });
      storage.deleteMemory("memory-forgot");

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_events SET updated_at = ?, state = 'failed' WHERE id = ?").run("2026-01-05T00:00:00.000Z", "memory-failed");
        db.prepare("UPDATE mate_growth_events SET updated_at = ? WHERE id = ?").run("2026-01-04T00:00:00.000Z", "memory-new");
        db.prepare("UPDATE mate_growth_events SET updated_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", "memory-old");
      } finally {
        db.close();
      }

      const relevant = storage.listRelevantMemoriesForGeneration({ limit: 2 });
      assert.equal(relevant.length, 2);
      assert.deepEqual(relevant.map((memory) => memory.id), ["memory-new", "memory-old"]);
      assert.equal(relevant[0].state, "candidate");
      assert.equal(relevant[0].relation, "new");
      assert.equal(relevant[0].targetClaimKey, "");
      assert.deepEqual(relevant[0].tags.map((tag) => ({ ...tag })), [{
        type: "topic",
        value: "Focus",
      }]);
      assert.deepEqual(relevant[1].tags.map((tag) => ({ ...tag })), [{
        type: "topic",
        value: "Work",
      }]);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("saveGeneratedMemories は profile_item refs を profile item link として保存し、存在しない profile item を無視する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      seedProfileItem(dbPath, "profile-1");
      seedProfileItem(dbPath, "profile-2");

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-related",
          statement: "関連元の記憶",
          statementFingerprint: "fp-related",
        })],
      });

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-source",
          statement: "保存対象記憶",
          statementFingerprint: "fp-source",
          relation: "reinforces",
          relatedRefs: [
            { type: "memory", id: "mem-related" },
            { type: "profile_item", id: "profile-1" },
            { type: "profile_item", id: "missing" },
          ],
          supersedesRefs: [{ type: "profile_item", id: "profile-2" }],
        })],
      });

      const db = new DatabaseSync(dbPath);
      try {
        const memoryLinks = db.prepare(`
          SELECT source_growth_event_id, target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'mem-source'
          ORDER BY target_growth_event_id, link_type
        `).all() as Array<{ source_growth_event_id: string; target_growth_event_id: string; link_type: string }>;

        const profileLinks = db.prepare(`
          SELECT growth_event_id, profile_item_id, link_type
          FROM mate_growth_event_profile_item_links
          WHERE growth_event_id = 'mem-source'
          ORDER BY profile_item_id, link_type
        `).all() as Array<{ growth_event_id: string; profile_item_id: string; link_type: string }>;

        assert.deepEqual(memoryLinks.map((link) => ({ ...link })), [{
          source_growth_event_id: "mem-source",
          target_growth_event_id: "mem-related",
          link_type: "reinforces",
        }]);
        assert.deepEqual(profileLinks.map((link) => ({ ...link })), [{
          growth_event_id: "mem-source",
          profile_item_id: "profile-1",
          link_type: "reinforces",
        }, {
          growth_event_id: "mem-source",
          profile_item_id: "profile-2",
          link_type: "supersedes",
        }]);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("saveGeneratedMemories は newTags を catalog と memory_tags に反映する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-newtags",
          statement: "新規タグ確認",
          statementFingerprint: "fp-newtags",
          tags: [{ type: "Topic", value: "work" }],
          newTags: [
            { type: "Area", value: "focus", reason: "新規タグを追加するため" },
          ],
        })],
      });

      storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-newtags",
          statement: "新規タグ確認",
          statementFingerprint: "fp-newtags",
          tags: [],
          newTags: [
            { type: "Area", value: "focus", reason: "2 回目も採用" },
          ],
        })],
      });

      const db = new DatabaseSync(dbPath);
      try {
        const tagRows = db.prepare("SELECT tag_type, tag_value FROM mate_memory_tags WHERE memory_id = ? ORDER BY id").all("mem-newtags") as Array<
          { tag_type: string; tag_value: string }
        >;
        const catalogRow = db.prepare(`
          SELECT usage_count FROM mate_memory_tag_catalog
          WHERE tag_type = 'area' AND tag_value_normalized = 'focus'
        `).get() as { usage_count: number } | undefined;

        assert.deepEqual(tagRows.map((tag) => ({ ...tag })), [{
          tag_type: "area",
          tag_value: "focus",
        }]);
        assert.equal(catalogRow?.usage_count, 2);
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

  it("deleteMemory は growth event を forgotten 化し tombstone を生成する", async () => {
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

        const tombstoneRows = db.prepare(`
          SELECT
            id,
            digest_kind,
            category,
            section_key,
            project_digest_id,
            source_growth_event_id
          FROM mate_forgotten_tombstones
          WHERE source_growth_event_id = ?
        `).all(saved.id) as Array<{
          id: string;
          digest_kind: string;
          category: string;
          section_key: string;
          project_digest_id: string | null;
          source_growth_event_id: string;
        }>;

        assert.equal(tombstoneRows.length, 1);
        assert.equal(tombstoneRows[0].source_growth_event_id, saved.id);
        assert.equal(tombstoneRows[0].digest_kind, "growth_statement");
        assert.equal(tombstoneRows[0].category, "note");
        assert.equal(tombstoneRows[0].section_key, "core");
        assert.equal(tombstoneRows[0].project_digest_id, null);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("forgotten 化した memory は同じ fingerprint の再生成で復活しない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const [forgotten] = storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-forgotten-original",
          statement: "復活させない対象",
          statementFingerprint: "fp-no-revive",
        })],
      });

      storage.deleteMemory(forgotten.id);
      const [regenerated] = storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-forgotten-regenerated",
          statement: "復活させない対象",
          statementFingerprint: "fp-no-revive",
        })],
      });

      assert.notEqual(regenerated.id, forgotten.id);
      assert.equal(regenerated.created, true);

      const db = new DatabaseSync(dbPath);
      try {
        const rows = db.prepare(`
          SELECT id, state
          FROM mate_growth_events
          WHERE statement_fingerprint = ?
          ORDER BY id
        `).all("fp-no-revive") as Array<{ id: string; state: string }>;
        assert.deepEqual(rows.map((row) => ({ ...row })), [{
          id: "mem-forgotten-original",
          state: "forgotten",
        }, {
          id: "mem-forgotten-regenerated",
          state: "candidate",
        }]);
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
      assert.equal(moodEntries[0].description, "");
      assert.equal(moodEntries[0].aliases, "");
      assert.equal(moodEntries[0].createdBy, "llm");
      assert.equal(typeof moodEntries[0].createdAt, "string");
      assert.equal(typeof moodEntries[0].updatedAt, "string");
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("deleteMemory を繰り返しても tombstone 重複しない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const [saved] = storage.saveGeneratedMemories({
        memories: [buildMemory({
          statement: "重複削除テスト対象",
          statementFingerprint: "fp-forget-dup",
          targetSection: "core",
        })],
      });

      storage.deleteMemory(saved.id);
      const dbAfterFirstDelete = new DatabaseSync(dbPath);
      let firstForgottenAt = "";
      try {
        const row = dbAfterFirstDelete.prepare("SELECT forgotten_at FROM mate_growth_events WHERE id = ?").get(saved.id) as {
          forgotten_at: string;
        };
        firstForgottenAt = row.forgotten_at;
      } finally {
        dbAfterFirstDelete.close();
      }
      storage.deleteMemory(saved.id);

      const db = new DatabaseSync(dbPath);
      try {
        const tombstoneRows = db.prepare("SELECT COUNT(*) AS count FROM mate_forgotten_tombstones WHERE source_growth_event_id = ?").get(
          saved.id,
        ) as { count: number };
        const row = db.prepare("SELECT forgotten_at FROM mate_growth_events WHERE id = ?").get(saved.id) as {
          forgotten_at: string;
        };
        assert.equal(tombstoneRows.count, 1);
        assert.equal(row.forgotten_at, firstForgottenAt);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("listForgottenTombstonesForGeneration は作成順 desc で limit を反映し raw statement を返さない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateMemoryStorage | null = null;

    try {
      storage = new MateMemoryStorage(dbPath);
      seedCurrentMateProfile(dbPath);
      const first = storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-older",
          statement: "削除対象A",
          statementFingerprint: "fp-forget-a",
          targetSection: "core",
          kind: "preference",
        })],
      });
      const second = storage.saveGeneratedMemories({
        memories: [buildMemory({
          id: "mem-later",
          statement: "削除対象B",
          statementFingerprint: "fp-forget-b",
          targetSection: "none",
          kind: "conversation",
        })],
      });

      storage.deleteMemory(first[0].id);
      storage.deleteMemory(second[0].id);

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_forgotten_tombstones SET created_at = ? WHERE source_growth_event_id = ?").run(
          "2026-01-01T00:00:00.000Z",
          first[0].id,
        );
        db.prepare("UPDATE mate_forgotten_tombstones SET created_at = ? WHERE source_growth_event_id = ?").run(
          "2026-01-02T00:00:00.000Z",
          second[0].id,
        );
      } finally {
        db.close();
      }

      const forgot = storage.listForgottenTombstonesForGeneration({ limit: 1 });
      assert.equal(forgot.length, 1);
      assert.equal(forgot[0].sourceGrowthEventId, second[0].id);
      assert.equal(forgot[0].sectionKey, "notes");
      assert.equal(forgot[0].category, "note");
      assert.equal((forgot[0] as { statement?: unknown }).statement, undefined);
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});
