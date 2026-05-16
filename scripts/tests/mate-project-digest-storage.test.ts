import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateProjectDigestStorage } from "../../src-electron/mate-project-digest-storage.js";

function seedCurrentMate(dbPath: string): void {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO mate_profile (
        id,
        state,
        display_name,
        description,
        theme_main,
        theme_sub,
        avatar_file_path,
        avatar_sha256,
        avatar_byte_size,
        active_revision_id,
        profile_generation,
        created_at,
        updated_at,
        deleted_at
      ) VALUES (?, 'active', 'current', '', '#6f8cff', '#6fb8c7', '', '', 0, NULL, 1, ?, ?, NULL)
    `).run("current", now, now);
  } finally {
    db.close();
  }
}

describe("MateProjectDigestStorage", () => {
  it("git workspace で project digest を作成し、再呼び出し時に同じ id を返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-digest-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    const repoRoot = path.join(tempDirectory, "repo");
    const workspacePath = path.join(repoRoot, "packages", "app");
    let storage: MateProjectDigestStorage | null = null;

    try {
      await mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await mkdir(workspacePath, { recursive: true });

      storage = new MateProjectDigestStorage(dbPath);
      seedCurrentMate(dbPath);
      const first = storage.resolveProjectDigestForWorkspace(workspacePath);
      const second = storage.resolveProjectDigestForWorkspace(workspacePath);

      assert.ok(first !== null);
      assert.ok(second !== null);
      assert.equal(first.projectType, "git");
      assert.equal(first.id, second.id);
      assert.equal(second.projectKey, `git:${repoRoot.replace(/\\/g, "/")}`);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT COUNT(*) AS count FROM mate_project_digests WHERE project_key = ?").get(first.projectKey) as {
          count: number;
        };
        assert.equal(row.count, 1);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("directory workspace では null を返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-digest-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    const workspacePath = path.join(tempDirectory, "scratch");
    let storage: MateProjectDigestStorage | null = null;

    try {
      await mkdir(workspacePath, { recursive: true });

      storage = new MateProjectDigestStorage(dbPath);
      const digest = storage.resolveProjectDigestForWorkspace(workspacePath);

      assert.equal(digest, null);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rewriteProjectDigestProjection で projection metadata と markdown ファイルを更新できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-digest-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    const userDataPath = path.join(tempDirectory, "user-data");
    const workspacePath = path.join(tempDirectory, "workspace");
    let storage: MateProjectDigestStorage | null = null;

    try {
      await mkdir(path.join(tempDirectory, ".git"), { recursive: true });
      await mkdir(workspacePath, { recursive: true });

      storage = new MateProjectDigestStorage(dbPath);
      seedCurrentMate(dbPath);
      const digest = storage.resolveProjectDigestForWorkspace(workspacePath);
      assert.ok(digest);
      const eventId = "event-1";

      const dbForEvent = new DatabaseSync(dbPath);
      try {
        dbForEvent.prepare(`
          INSERT INTO mate_growth_events (
            id,
            mate_id,
            source_type,
            growth_source_type,
            kind,
            target_section,
            statement,
            statement_fingerprint,
            confidence,
            salience_score,
            state,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at
          ) VALUES (?, 'current', 'session', 'repeated_user_behavior', 'project_context', 'project_digest', 'test', 'fingerprint', 80, 70, 'candidate', ?, ?, ?, ?)
        `).run(
          eventId,
          new Date("2026-01-01T00:00:00.001Z").toISOString(),
          new Date("2026-01-01T00:00:00.002Z").toISOString(),
          new Date("2026-01-01T00:00:00.003Z").toISOString(),
          new Date("2026-01-01T00:00:00.004Z").toISOString(),
        );
      } finally {
        dbForEvent.close();
      }

      const digestText = [
        "### Project Digest",
        "- **project-context:** このプロジェクトでは TypeScript を重視する",
      ].join("\n");
      await storage.rewriteProjectDigestProjection({
        projectDigestId: digest.id,
        userDataPath,
        content: digestText,
        activeRevisionId: null,
        lastGrowthEventId: eventId,
      });

      const absolutePath = path.join(userDataPath, digest.digestFilePath);
      const writtenText = await readFile(absolutePath, "utf8");
      assert.equal(writtenText, digestText);
      assert.equal(path.isAbsolute(digest.digestFilePath), false);

      const expectedSha256 = createHash("sha256").update(digestText, "utf8").digest("hex");
      const expectedByteSize = Buffer.byteLength(digestText, "utf8");

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT digest_file_path, sha256, byte_size, last_growth_event_id, last_compiled_at, updated_at FROM mate_project_digests WHERE id = ?").get(digest.id) as {
          digest_file_path: string;
          sha256: string;
          byte_size: number;
          last_growth_event_id: string | null;
          last_compiled_at: string | null;
          updated_at: string;
        };
        assert.equal(row.digest_file_path, digest.digestFilePath);
        assert.equal(row.sha256, expectedSha256);
        assert.equal(row.byte_size, expectedByteSize);
        assert.equal(row.last_growth_event_id, "event-1");
        assert.equal(typeof row.last_compiled_at, "string");
        assert.equal(row.updated_at.length > 0, true);
      } finally {
        db.close();
      }
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
