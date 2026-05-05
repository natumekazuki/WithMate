import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateStorage } from "../../src-electron/mate-storage.js";

const EMPTY_SHA256 = createHash("sha256").update("", "utf8").digest("hex");

function createTempPaths(): Promise<{ dbPath: string; userDataPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-storage-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

describe("MateStorage", () => {
  it("initialize 後は Mate 未作成状態を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      assert.equal(storage.getMateState(), "not_created");
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("recovery 後は staging / committing_files のみ failed になる（ready / failed はそのまま）", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });

      const activeRevisionId = profile.activeRevisionId;
      const before = new DatabaseSync(dbPath);
      const now = new Date().toISOString();
      const stagingRevisionId = randomUUID();
      const committingRevisionId = randomUUID();
      const readyRevisionId = randomUUID();
      const failedRevisionId = randomUUID();
      const failedAt = "2025-01-01T00:00:00.000Z";

      before.prepare(`
        INSERT INTO mate_profile_revisions (
          id,
          mate_id,
          seq,
          parent_revision_id,
          status,
          kind,
          source_growth_event_id,
          summary,
          snapshot_dir_path,
          created_by,
          created_at,
          ready_at,
          failed_at,
          reverted_by_revision_id
        ) VALUES (?, ?, ?, ?, ?, 'growth_apply', NULL, ?, '', 'system', ?, NULL, NULL, NULL)
      `).run(stagingRevisionId, "current", 2, activeRevisionId, "staging", "staging", now);

      before.prepare(`
        INSERT INTO mate_profile_revisions (
          id,
          mate_id,
          seq,
          parent_revision_id,
          status,
          kind,
          source_growth_event_id,
          summary,
          snapshot_dir_path,
          created_by,
          created_at,
          ready_at,
          failed_at,
          reverted_by_revision_id
        ) VALUES (?, ?, ?, ?, ?, 'growth_apply', NULL, ?, '', 'system', ?, NULL, NULL, NULL)
      `).run(committingRevisionId, "current", 3, activeRevisionId, "committing_files", "committing", now);

      before.prepare(`
        INSERT INTO mate_profile_revisions (
          id,
          mate_id,
          seq,
          parent_revision_id,
          status,
          kind,
          source_growth_event_id,
          summary,
          snapshot_dir_path,
          created_by,
          created_at,
          ready_at,
          failed_at,
          reverted_by_revision_id
        ) VALUES (?, ?, ?, ?, 'ready', 'growth_apply', NULL, 'ready', '', 'system', ?, ?, NULL, NULL)
      `).run(readyRevisionId, "current", 4, activeRevisionId, now, now);

      before.prepare(`
        INSERT INTO mate_profile_revisions (
          id,
          mate_id,
          seq,
          parent_revision_id,
          status,
          kind,
          source_growth_event_id,
          summary,
          snapshot_dir_path,
          created_by,
          created_at,
          ready_at,
          failed_at,
          reverted_by_revision_id
        ) VALUES (?, ?, ?, ?, 'failed', 'growth_apply', NULL, 'failed', '', 'system', ?, ?, ?, NULL)
      `).run(failedRevisionId, "current", 5, activeRevisionId, now, now, failedAt);
      before.close();

      storage.close();
      storage = null;

      storage = new MateStorage(dbPath, userDataPath);
      assert.equal(storage.getMateState(), "active");

      const after = new DatabaseSync(dbPath);
      try {
        const rows = after.prepare(`
          SELECT id, status, failed_at
          FROM mate_profile_revisions
          WHERE mate_id = 'current'
            AND id IN (?, ?, ?, ?)
        `).all(stagingRevisionId, committingRevisionId, readyRevisionId, failedRevisionId) as Array<{
          id: string;
          status: string;
          failed_at: string | null;
        }>;

        assert.equal(rows.length, 4);

        const byId = new Map(rows.map((row) => [row.id, row]));

        assert.equal(byId.get(stagingRevisionId)?.status, "failed");
        assert.equal(byId.get(stagingRevisionId)?.failed_at !== null, true);
        assert.equal(byId.get(committingRevisionId)?.status, "failed");
        assert.equal(byId.get(committingRevisionId)?.failed_at !== null, true);
        assert.equal(byId.get(readyRevisionId)?.status, "ready");
        assert.equal(byId.get(readyRevisionId)?.failed_at, null);
        assert.equal(byId.get(failedRevisionId)?.status, "failed");
        assert.equal(byId.get(failedRevisionId)?.failed_at, failedAt);

        const reopenedProfile = storage.getMateProfile();
        assert.equal(reopenedProfile?.activeRevisionId, activeRevisionId);
      } finally {
        after.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("getMateProfile は active_revision_id が staging でも最新の ready revision を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });
      const initialRevisionId = profile.activeRevisionId;

      if (!initialRevisionId) {
        throw new Error("初期の active revision が見つからないよ。");
      }

      const now = new Date().toISOString();
      const stagingRevisionId = randomUUID();
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          INSERT INTO mate_profile_revisions (
            id,
            mate_id,
            seq,
            parent_revision_id,
            status,
            kind,
            source_growth_event_id,
            summary,
            snapshot_dir_path,
            created_by,
            created_at,
            ready_at,
            failed_at,
            reverted_by_revision_id
          ) VALUES (?, ?, ?, ?, 'staging', 'growth_apply', NULL, 'staging', '', 'system', ?, NULL, NULL, NULL)
        `).run(stagingRevisionId, "current", 2, initialRevisionId, now);

        db.prepare(`
          UPDATE mate_profile
          SET active_revision_id = ?
          WHERE id = ?
        `).run(stagingRevisionId, "current");

        const reopenedProfile = storage.getMateProfile();
        assert.equal(reopenedProfile?.activeRevisionId, initialRevisionId);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("getMateProfile は failed / missing でも最新の ready revision を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });
      const initialRevisionId = profile.activeRevisionId;

      if (!initialRevisionId) {
        throw new Error("初期の active revision が見つからないよ。");
      }

      const now = new Date().toISOString();
      const failedRevisionId = randomUUID();
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          INSERT INTO mate_profile_revisions (
            id,
            mate_id,
            seq,
            parent_revision_id,
            status,
            kind,
            source_growth_event_id,
            summary,
            snapshot_dir_path,
            created_by,
            created_at,
            ready_at,
            failed_at,
            reverted_by_revision_id
          ) VALUES (?, ?, ?, ?, 'failed', 'growth_apply', NULL, 'failed', '', 'system', ?, NULL, ?, NULL)
        `).run(failedRevisionId, "current", 2, initialRevisionId, now, now);

        db.prepare("UPDATE mate_profile SET active_revision_id = ? WHERE id = ?").run(failedRevisionId, "current");
        const failedFallbackProfile = storage.getMateProfile();
        assert.equal(failedFallbackProfile?.activeRevisionId, initialRevisionId);

        db.prepare("UPDATE mate_profile SET active_revision_id = ? WHERE id = ?").run(randomUUID(), "current");
        const missingFallbackProfile = storage.getMateProfile();
        assert.equal(missingFallbackProfile?.activeRevisionId, initialRevisionId);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("getMateProfile は active_revision_id が null でも最新の ready revision を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });

      if (!profile.activeRevisionId) {
        throw new Error("初期の active revision が見つからないよ。");
      }

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_profile SET active_revision_id = NULL WHERE id = ?").run("current");

        const fallbackProfile = storage.getMateProfile();
        assert.equal(fallbackProfile?.activeRevisionId, profile.activeRevisionId);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("ready revision がない場合は activeRevisionId が null を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });

      if (!profile.activeRevisionId) {
        throw new Error("初期の active revision が見つからないよ。");
      }

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("DELETE FROM mate_profile_revisions WHERE mate_id = ?").run("current");
        db.prepare("UPDATE mate_profile SET active_revision_id = ? WHERE id = ?").run(profile.activeRevisionId, "current");

        const noReadyProfile = storage.getMateProfile();
        assert.equal(noReadyProfile?.activeRevisionId, null);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("createMate は displayName のみでプロフィールと初期関連行を作る", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });
      const growthSettings = storage.getMateGrowthSettings();

      assert.equal(profile.state, "active");
      assert.equal(profile.displayName, "Mika");
      assert.equal(profile.sections.length, 4);
      assert.equal(profile.activeRevisionId === null, false);
      assert.equal(growthSettings?.enabled, true);
      assert.equal(growthSettings?.autoApplyEnabled, true);
      assert.equal(growthSettings?.memoryCandidateMode, "every_turn");
      assert.equal(growthSettings?.applyIntervalMinutes, 60);

      const files = [
        path.join(userDataPath, "mate/core.md"),
        path.join(userDataPath, "mate/bond.md"),
        path.join(userDataPath, "mate/work-style.md"),
        path.join(userDataPath, "mate/notes.md"),
      ];
      for (const filePath of files) {
        const contents = await readFile(filePath, "utf8");
        assert.equal(contents, "");
      }

      const db = new DatabaseSync(dbPath);
      try {
        const profileCount = db.prepare("SELECT COUNT(*) AS count FROM mate_profile WHERE id = 'current'").get() as {
          count: number;
        };
        const sectionCount = db.prepare("SELECT COUNT(*) AS count FROM mate_profile_sections WHERE mate_id = 'current'").get() as {
          count: number;
        };
        const sectionHashCount = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_sections WHERE mate_id = 'current' AND sha256 = ?")
          .get(EMPTY_SHA256) as { count: number };
        const growthSettingCount = db
          .prepare("SELECT COUNT(*) AS count FROM mate_growth_settings WHERE mate_id = 'current'")
          .get() as { count: number };
        const embeddingSettingCount = db
          .prepare("SELECT COUNT(*) AS count FROM mate_embedding_settings WHERE mate_id = 'current'")
          .get() as { count: number };
        const revisionCount = db
          .prepare(
            "SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current' AND kind = 'initial' AND status = 'ready'",
          )
          .get() as { count: number };

        assert.equal(profileCount.count, 1);
        assert.equal(sectionCount.count, 4);
        assert.equal(sectionHashCount.count, 4);
        assert.equal(growthSettingCount.count, 1);
        assert.equal(embeddingSettingCount.count, 1);
        assert.equal(revisionCount.count, 1);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthApplyIntervalMinutes は Growth 実行間隔だけを更新する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      const updated = storage.updateMateGrowthApplyIntervalMinutes(90);
      const reopened = storage.getMateGrowthSettings();

      assert.equal(updated?.applyIntervalMinutes, 90);
      assert.equal(updated?.enabled, true);
      assert.equal(updated?.autoApplyEnabled, true);
      assert.equal(reopened?.applyIntervalMinutes, 90);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthSettings は部分更新で Growth 設定を更新する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      const updated1 = storage.updateMateGrowthSettings({
        enabled: false,
        autoApplyEnabled: false,
      });
      assert.equal(updated1?.enabled, false);
      assert.equal(updated1?.autoApplyEnabled, false);
      assert.equal(updated1?.memoryCandidateMode, "every_turn");
      assert.equal(updated1?.applyIntervalMinutes, 60);

      const updated2 = storage.updateMateGrowthSettings({
        memoryCandidateMode: "threshold",
        applyIntervalMinutes: 300.8,
      });
      assert.equal(updated2?.enabled, false);
      assert.equal(updated2?.autoApplyEnabled, false);
      assert.equal(updated2?.memoryCandidateMode, "threshold");
      assert.equal(updated2?.applyIntervalMinutes, 300);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthSettings は applyIntervalMinutes を 1..14400 に clamp/trunc する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      const below = storage.updateMateGrowthSettings({ applyIntervalMinutes: 0 });
      assert.equal(below?.applyIntervalMinutes, 1);
      const above = storage.updateMateGrowthSettings({ applyIntervalMinutes: 20000 });
      assert.equal(above?.applyIntervalMinutes, 14400);
      const decimal = storage.updateMateGrowthSettings({ applyIntervalMinutes: 12.9 });
      assert.equal(decimal?.applyIntervalMinutes, 12);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthSettings は不正な memoryCandidateMode を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      assert.throws(
        () => storage!.updateMateGrowthSettings({ memoryCandidateMode: "invalid" as never }),
        /memoryCandidateMode/,
      );
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthSettings は object 以外の入力を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      assert.throws(
        () => storage!.updateMateGrowthSettings(null as never),
        /object/,
      );
      assert.throws(
        () => storage!.updateMateGrowthSettings([] as never),
        /object/,
      );
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("updateMateGrowthSettings は Mate 未作成時に null を返す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      assert.equal(storage.updateMateGrowthSettings({ enabled: false }), null);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("createMate は既存 Mate を上書きしない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      await assert.rejects(
        () => storage!.createMate({ displayName: "Rin" }),
        /既に作成済み/,
      );

      const profile = storage.getMateProfile();
      assert.equal(profile?.displayName, "Mika");
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("resetMate で mate row と mate ディレクトリを削除する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });
      await storage.resetMate();

      assert.equal(storage.getMateState(), "not_created");

      const db = new DatabaseSync(dbPath);
      try {
        const profileCount = db.prepare("SELECT COUNT(*) AS count FROM mate_profile").get() as { count: number };
        const sectionCount = db.prepare("SELECT COUNT(*) AS count FROM mate_profile_sections").get() as { count: number };
        assert.equal(profileCount.count, 0);
        assert.equal(sectionCount.count, 0);
      } finally {
        db.close();
      }

      try {
        await access(path.join(userDataPath, "mate"), constants.F_OK);
        assert.fail("mate directory が残っている。");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("applyProfileFiles は Mate ファイルを上書きし revision と section metadata を更新する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const initialProfile = await storage.createMate({ displayName: "Mika" });
      const updatedProfile = await storage.applyProfileFiles({
        summary: "growth apply",
        files: [
          { sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n\n- Updated\n" },
          { sectionKey: "bond", relativePath: "mate/bond.md", content: "# Bond\n" },
        ],
      });

      assert.equal(updatedProfile.profileGeneration, initialProfile.profileGeneration + 1);
      assert.notEqual(updatedProfile.activeRevisionId, initialProfile.activeRevisionId);
      assert.equal(await readFile(path.join(userDataPath, "mate/core.md"), "utf8"), "# Core\n\n- Updated\n");

      const db = new DatabaseSync(dbPath);
      try {
        const revision = db.prepare(`
          SELECT seq, kind, status, summary, ready_at, failed_at
          FROM mate_profile_revisions
          WHERE id = ?
        `).get(updatedProfile.activeRevisionId) as {
          seq: number;
          kind: string;
          status: string;
          summary: string;
          ready_at: string | null;
          failed_at: string | null;
        };
        const coreSection = db.prepare(`
          SELECT sha256, byte_size, updated_by_revision_id
          FROM mate_profile_sections
          WHERE mate_id = 'current' AND section_key = 'core'
        `).get() as {
          sha256: string;
          byte_size: number;
          updated_by_revision_id: string;
        };
        const revisionSectionCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM mate_profile_revision_sections
          WHERE revision_id = ?
        `).get(updatedProfile.activeRevisionId) as { count: number };

        assert.equal(revision.seq, 2);
        assert.equal(revision.kind, "growth_apply");
        assert.equal(revision.status, "ready");
        assert.equal(revision.ready_at !== null, true);
        assert.equal(revision.failed_at, null);
        assert.equal(revision.summary, "growth apply");
        assert.equal(coreSection.sha256, createHash("sha256").update("# Core\n\n- Updated\n", "utf8").digest("hex"));
        assert.equal(coreSection.byte_size, Buffer.byteLength("# Core\n\n- Updated\n", "utf8"));
        assert.equal(coreSection.updated_by_revision_id, updatedProfile.activeRevisionId);
        assert.equal(revisionSectionCount.count, 2);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("applyProfileFiles はセクションの canonical path 以外を拒否する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });
      const beforeProfile = storage.getMateProfile();
      if (!beforeProfile) {
        throw new Error("事前プロフィールが見つからないよ。");
      }
      const db = new DatabaseSync(dbPath);
      try {
        const revisionCountBefore = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        const sectionBefore = db
          .prepare("SELECT sha256, byte_size FROM mate_profile_sections WHERE mate_id = 'current' AND section_key = 'core'")
          .get() as { sha256: string; byte_size: number };

        await assert.rejects(
          () => storage!.applyProfileFiles({
            summary: "growth apply",
            files: [{ sectionKey: "core", relativePath: "mate/other.md", content: "# Other\n" }],
          }),
          /relativePath が不正/,
        );

        const afterProfile = storage.getMateProfile();
        assert.equal(afterProfile?.profileGeneration, beforeProfile.profileGeneration);
        assert.equal(afterProfile?.activeRevisionId, beforeProfile.activeRevisionId);

        const revisionCountAfter = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        assert.equal(revisionCountAfter.count, revisionCountBefore.count);

        const sectionAfter = db
          .prepare("SELECT sha256, byte_size FROM mate_profile_sections WHERE mate_id = 'current' AND section_key = 'core'")
          .get() as { sha256: string; byte_size: number };
        assert.equal(sectionAfter.sha256, sectionBefore.sha256);
        assert.equal(sectionAfter.byte_size, sectionBefore.byte_size);
        assert.equal(sectionAfter.sha256, EMPTY_SHA256);

        assert.equal(await readFile(path.join(userDataPath, "mate/core.md"), "utf8"), "");
        await assert.rejects(
          () => access(path.join(userDataPath, "mate/other.md"), constants.F_OK),
          /ENOENT/,
        );
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("applyProfileFiles は存在しない sourceGrowthEventId の場合に DB 更新しない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      const beforeProfile = storage.getMateProfile();
      if (!beforeProfile) {
        throw new Error("事前プロフィールが見つからないよ。");
      }

      const growthEventId = randomUUID();
      const now = new Date().toISOString();
      const db = new DatabaseSync(dbPath);
      try {
        const revisionCountBefore = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        const sectionRowsBefore = db
          .prepare(
            "SELECT section_key, file_path, sha256, byte_size, updated_by_revision_id, updated_at FROM mate_profile_sections WHERE mate_id = 'current' ORDER BY section_key",
          )
          .all() as Array<{
            section_key: string;
            file_path: string;
            sha256: string;
            byte_size: number;
            updated_by_revision_id: string | null;
            updated_at: string;
          }>;

        db.prepare(`
          INSERT INTO mate_growth_events (
            id,
            mate_id,
            source_type,
            growth_source_type,
            kind,
            statement,
            target_claim_key,
            state,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at
          ) VALUES (?, 'current', 'manual', 'explicit_user_instruction', 'observation', 'test statement', '', 'candidate', ?, ?, ?, ?)
        `).run(
          growthEventId,
          now,
          now,
          now,
          now,
        );

        await assert.rejects(
          () => storage!.applyProfileFiles({
            summary: "growth apply",
            sourceGrowthEventId: randomUUID(),
            files: [{ sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n\n- Updated\n" }],
          }),
          /sourceGrowthEventId が見つからないよ/,
        );

        const afterProfile = storage.getMateProfile();
        assert.equal(afterProfile?.profileGeneration, beforeProfile.profileGeneration);
        assert.equal(afterProfile?.activeRevisionId, beforeProfile.activeRevisionId);
        assert.equal(await readFile(path.join(userDataPath, "mate/core.md"), "utf8"), "");
        assert.equal(await readFile(path.join(userDataPath, "mate/bond.md"), "utf8"), "");
        assert.equal(await readFile(path.join(userDataPath, "mate/work-style.md"), "utf8"), "");
        assert.equal(await readFile(path.join(userDataPath, "mate/notes.md"), "utf8"), "");

        const revisionCountAfter = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        assert.equal(revisionCountAfter.count, revisionCountBefore.count);

        const sectionRowsAfter = db
          .prepare(
            "SELECT section_key, file_path, sha256, byte_size, updated_by_revision_id, updated_at FROM mate_profile_sections WHERE mate_id = 'current' ORDER BY section_key",
          )
          .all() as Array<{
            section_key: string;
            file_path: string;
            sha256: string;
            byte_size: number;
            updated_by_revision_id: string | null;
            updated_at: string;
          }>;
        assert.equal(sectionRowsBefore.length, sectionRowsAfter.length);
        for (let index = 0; index < sectionRowsBefore.length; index++) {
          assert.equal(sectionRowsBefore[index].section_key, sectionRowsAfter[index].section_key);
          assert.equal(sectionRowsBefore[index].file_path, sectionRowsAfter[index].file_path);
          assert.equal(sectionRowsBefore[index].sha256, sectionRowsAfter[index].sha256);
          assert.equal(sectionRowsBefore[index].byte_size, sectionRowsAfter[index].byte_size);
          assert.equal(sectionRowsBefore[index].updated_by_revision_id, sectionRowsAfter[index].updated_by_revision_id);
          assert.equal(sectionRowsBefore[index].updated_at, sectionRowsAfter[index].updated_at);
        }
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("applyProfileFiles はファイル保存失敗時に revision を failed 化し profile_generation と active_revision_id を進めない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });

      const beforeProfile = storage.getMateProfile();
      if (!beforeProfile) {
        throw new Error("事前プロフィールが見つからないよ。");
      }

      const db = new DatabaseSync(dbPath);
      try {
        const revisionCountBefore = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        const corePath = path.join(userDataPath, "mate/core.md");
        await rm(corePath, { recursive: true, force: true });
        await mkdir(corePath);

        await assert.rejects(
          () => storage!.applyProfileFiles({
            summary: "growth apply failure",
            files: [{ sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n\n- Updated\n" }],
          }),
          /EISDIR/,
        );

        const afterProfile = storage.getMateProfile();
        assert.equal(afterProfile?.profileGeneration, beforeProfile.profileGeneration);
        assert.equal(afterProfile?.activeRevisionId, beforeProfile.activeRevisionId);

        const revisionCountAfter = db
          .prepare("SELECT COUNT(*) AS count FROM mate_profile_revisions WHERE mate_id = 'current'")
          .get() as { count: number };
        assert.equal(revisionCountAfter.count, revisionCountBefore.count + 1);

        const failedRevision = db
          .prepare(`
            SELECT status, ready_at, failed_at
            FROM mate_profile_revisions
            WHERE id = (
              SELECT id
              FROM mate_profile_revisions
              WHERE mate_id = 'current'
              ORDER BY seq DESC
              LIMIT 1
            )
          `)
          .get() as {
            status: string;
            ready_at: string | null;
            failed_at: string | null;
          };

        assert.equal(failedRevision.status, "failed");
        assert.equal(failedRevision.ready_at, null);
        assert.equal(failedRevision.failed_at !== null, true);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("applyProfileFiles は複数ファイル保存の途中失敗時に書き込み済みファイルを戻す", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      await storage.createMate({ displayName: "Mika" });
      await storage.applyProfileFiles({
        summary: "seed content",
        files: [
          { sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n\n- Stable\n" },
          { sectionKey: "bond", relativePath: "mate/bond.md", content: "# Bond\n\n- Old\n" },
        ],
      });

      const beforeProfile = storage.getMateProfile();
      if (!beforeProfile) {
        throw new Error("事前プロフィールが見つからないよ。");
      }

      const corePath = path.join(userDataPath, "mate/core.md");
      await rm(corePath, { recursive: true, force: true });
      await mkdir(corePath);

      await assert.rejects(
        () => storage!.applyProfileFiles({
          summary: "partial write failure",
          files: [
            { sectionKey: "bond", relativePath: "mate/bond.md", content: "# Bond\n\n- New\n" },
            { sectionKey: "core", relativePath: "mate/core.md", content: "# Core\n\n- New\n" },
          ],
        }),
        /EISDIR/,
      );

      const afterProfile = storage.getMateProfile();
      assert.equal(afterProfile?.profileGeneration, beforeProfile.profileGeneration);
      assert.equal(afterProfile?.activeRevisionId, beforeProfile.activeRevisionId);
      assert.equal(await readFile(path.join(userDataPath, "mate/bond.md"), "utf8"), "# Bond\n\n- Old\n");
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});
