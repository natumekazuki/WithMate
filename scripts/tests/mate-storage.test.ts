import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
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

  it("createMate は displayName のみでプロフィールと初期関連行を作る", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    let storage: MateStorage | null = null;

    try {
      storage = new MateStorage(dbPath, userDataPath);
      const profile = await storage.createMate({ displayName: "Mika" });

      assert.equal(profile.state, "active");
      assert.equal(profile.displayName, "Mika");
      assert.equal(profile.sections.length, 4);
      assert.equal(profile.activeRevisionId === null, false);

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
          SELECT seq, kind, status, summary
          FROM mate_profile_revisions
          WHERE id = ?
        `).get(updatedProfile.activeRevisionId) as {
          seq: number;
          kind: string;
          status: string;
          summary: string;
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
});
