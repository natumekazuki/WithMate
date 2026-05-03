import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateProfileItemStorage } from "../../src-electron/mate-profile-item-storage.js";

const BASE_TIME = "2026-01-01T00:00:00.000Z";

function seedCurrentMate(dbPath: string): void {
  const now = BASE_TIME;
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

function seedProjectDigest(dbPath: string): string {
  const now = BASE_TIME;
  const projectDigestId = "pd_1";
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO mate_project_digests (
        id,
        mate_id,
        project_type,
        project_key,
        workspace_path,
        git_root,
        display_name,
        digest_file_path,
        sha256,
        byte_size,
        active_revision_id,
        last_growth_event_id,
        last_compiled_at,
        disabled_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 'git', 'git:example', '/tmp', '', 'example', '/tmp/example.digest', '', 0, NULL, NULL, NULL, NULL, ?, ?)
    `).run(projectDigestId, "current", now, now);
  } finally {
    db.close();
  }

  return projectDigestId;
}

function seedGrowthEvent(dbPath: string, growthEventId: string): void {
  const now = BASE_TIME;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO mate_growth_events (
        id,
        mate_id,
        source_type,
        growth_source_type,
        kind,
        target_section,
        statement,
        statement_fingerprint,
        rationale_preview,
        retention,
        relation,
        target_claim_key,
        confidence,
        salience_score,
        recurrence_count,
        projection_allowed,
        state,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      ) VALUES (?, 'current', 'system', 'assistant_inference', 'preference', 'core', 'generated', 'generated', '', 'auto', 'new', 'x', 1, 1, 1, 0, 'applied', ?, ?, ?, ?)
    `).run(growthEventId, now, now, now, now);
  } finally {
    db.close();
  }
}

function seedProfileRevision(dbPath: string, revisionId: string, sequence = 1): void {
  const now = BASE_TIME;
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
      ) VALUES (?, 'current', ?, NULL, 'ready', 'manual_edit', NULL, 'revision', '', 'system', ?, ?, NULL, NULL)
    `).run(revisionId, sequence, now, now);
  } finally {
    db.close();
  }
}

describe("MateProfileItemStorage", () => {
  it("upsert は project_digest を除き project_digest_id を null 化し、同一 claim は上書きしてタグを差し替えます", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-profile-item-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);

      const first = storage.upsertProfileItem({
        sectionKey: "core",
        category: "preference",
        claimKey: "foo",
        claimValue: "A",
        renderedText: "Preference A",
        normalizedClaim: "preference a",
        confidence: 40,
        salienceScore: 45,
        recurrenceCount: 2,
        projectionAllowed: true,
        tags: [{ type: "style", value: "Concise" }],
      });

      const second = storage.upsertProfileItem({
        sectionKey: "core",
        category: "preference",
        claimKey: "foo",
        claimValue: "B",
        renderedText: "Preference B",
        normalizedClaim: "preference b",
        confidence: 50,
        salienceScore: 55,
        tags: [],
      });

      assert.equal(first.id, second.id);
      assert.equal(second.claimValue, "B");
      assert.equal(second.tags.length, 0);
      assert.equal(second.projectDigestId, null);

      const listed = storage.listProfileItems({ sectionKey: "core", state: "active" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].claimKey, "foo");
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("sectionKey=project_digest では projectDigestId を必須にし、保存時に紐付けます", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-profile-item-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      assert.throws(() => {
        storage.upsertProfileItem({
          sectionKey: "project_digest",
          category: "note",
          claimKey: "project_note",
          claimValue: "note in digest",
          renderedText: "Project note",
          normalizedClaim: "project note",
          confidence: 80,
          salienceScore: 75,
        });
      }, /projectDigestId/);

      const item = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "project_note",
        claimValue: "note in digest",
        renderedText: "Project note",
        normalizedClaim: "project note",
        confidence: 80,
        salienceScore: 75,
      });

      assert.equal(item.projectDigestId, digestId);
      assert.equal(item.sectionKey, "project_digest");
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("sourceGrowthEventId がある場合、作成時 created_by / 更新時 reinforced_by を source に保存します", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-profile-item-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const growthEventId = "ge-item-1";
      seedGrowthEvent(dbPath, growthEventId);

      const created = storage.upsertProfileItem({
        sectionKey: "core",
        category: "relationship",
        claimKey: "relation",
        claimValue: "friendly",
        renderedText: "Friendly tone",
        normalizedClaim: "friendly tone",
        confidence: 60,
        salienceScore: 60,
        sourceGrowthEventId: growthEventId,
      });

      const db = new DatabaseSync(dbPath);
      const linksAfterCreate = db.prepare(`
        SELECT link_type
        FROM mate_profile_item_sources
        WHERE profile_item_id = ?
        ORDER BY link_type
      `).all(created.id) as Array<{ link_type: string }>;
      assert.deepEqual(linksAfterCreate.map((row) => row.link_type), ["created_by"]);

      storage.upsertProfileItem({
        id: created.id,
        sectionKey: "core",
        category: "relationship",
        claimKey: "relation",
        claimValue: "friendly",
        renderedText: "Friendly tone v2",
        normalizedClaim: "friendly tone v2",
        confidence: 65,
        salienceScore: 65,
        sourceGrowthEventId: growthEventId,
      });

      const linksAfterUpdate = db.prepare(`
        SELECT link_type
        FROM mate_profile_item_sources
        WHERE profile_item_id = ?
        ORDER BY link_type
      `).all(created.id) as Array<{ link_type: string }>;
      db.close();

      assert.deepEqual(linksAfterUpdate.map((row) => row.link_type), ["created_by", "reinforced_by"]);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("listProfileItems で section/category/state/projectDigestId を絞り込めます", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-profile-item-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      storage.upsertProfileItem({
        sectionKey: "notes",
        category: "note",
        claimKey: "note-1",
        claimValue: "note one",
        renderedText: "Note one",
        normalizedClaim: "note one",
        confidence: 10,
        salienceScore: 10,
      });
      storage.upsertProfileItem({
        sectionKey: "notes",
        category: "note",
        claimKey: "note-2",
        claimValue: "note two",
        renderedText: "Note two",
        normalizedClaim: "note two",
        confidence: 11,
        salienceScore: 11,
      });
      storage.upsertProfileItem({
        sectionKey: "work_style",
        category: "work_style",
        claimKey: "work-1",
        claimValue: "work one",
        renderedText: "Work one",
        normalizedClaim: "work one",
        confidence: 20,
        salienceScore: 20,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "preference",
        claimKey: "pref-1",
        claimValue: "pref one",
        renderedText: "Preference one",
        normalizedClaim: "preference one",
        confidence: 30,
        salienceScore: 30,
      });

      const allNotes = storage.listProfileItems({ sectionKey: "notes" });
      const globalNotes = storage.listProfileItems({ sectionKey: "notes", category: "note" });
      const byState = storage.listProfileItems({ state: "active", category: "work_style" });
      const byProjectDigest = storage.listProfileItems({ sectionKey: "project_digest", projectDigestId: digestId });

      assert.equal(allNotes.length, 2);
      assert.equal(globalNotes.length, 2);
      assert.equal(byState.length, 1);
      assert.equal(byProjectDigest.length, 1);
      assert.equal(byProjectDigest[0].category, "preference");
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("forgetProfileItem と disableProfileItem が状態遷移と時刻更新を行います", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-profile-item-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const forgetRevision = "rev_forget";
      const disableRevision = "rev_disable";
      seedProfileRevision(dbPath, forgetRevision, 1);
      seedProfileRevision(dbPath, disableRevision, 2);

      const item = storage.upsertProfileItem({
        sectionKey: "core",
        category: "boundary",
        claimKey: "boundary-1",
        claimValue: "boundary value",
        renderedText: "Boundary",
        normalizedClaim: "boundary",
        confidence: 20,
        salienceScore: 20,
      });

      storage.forgetProfileItem(item.id, forgetRevision);
      const forgotten = storage.listProfileItems({ sectionKey: "core", category: "boundary", state: "forgotten" });
      assert.equal(forgotten.length, 1);
      assert.equal(forgotten[0].forgottenRevisionId, forgetRevision);
      assert.equal(forgotten[0].forgottenAt !== null, true);

      storage.disableProfileItem(item.id, disableRevision);
      const disabled = storage.listProfileItems({ sectionKey: "core", category: "boundary", state: "disabled" });
      assert.equal(disabled.length, 1);
      assert.equal(disabled[0].disabledRevisionId, disableRevision);
      assert.equal(disabled[0].disabledAt !== null, true);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});


