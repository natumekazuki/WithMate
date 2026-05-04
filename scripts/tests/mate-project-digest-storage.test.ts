import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
});
