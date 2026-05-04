import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateProfileItemStorage } from "../../src-electron/mate-profile-item-storage.js";
import { MateProjectContextService } from "../../src-electron/mate-project-context-service.js";

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
  const projectDigestId = "pd-ctx-1";
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
      ) VALUES (?, ?, 'git', 'git:ctx', '/tmp', '', 'ctx', '/tmp/ctx.digest', '', 0, NULL, NULL, NULL, NULL, ?, ?)
    `).run(projectDigestId, "current", now, now);
  } finally {
    db.close();
  }

  return projectDigestId;
}

describe("MateProjectContextService", () => {
  it("active かつ projectionAllowed の project_digest Profile Item だけを Markdown にして返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      service = new MateProjectContextService(storage);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "keep-item",
        claimValue: "Keep this",
        renderedText: "Keep this in context",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "skip-item",
        claimValue: "Skip this",
        renderedText: "Skip this from prompt",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: false,
      });
      storage.upsertProfileItem({
        sectionKey: "core",
        category: "note",
        claimKey: "core-item",
        claimValue: "Not project digest",
        renderedText: "Should not be included",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });

      const text = service.getProjectDigestContextText(digestId);
      assert.equal(text === null, false);
      assert.equal(text?.includes("### Project Digest"), true);
      assert.equal(text?.includes("- **keep-item:** Keep this in context"), true);
      assert.equal(text?.includes("- **skip-item:** Skip this from prompt"), false);
      assert.equal(text?.includes("- **core-item:** Should not be included"), false);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("project digest の有効な Profile Item が無い場合は null を返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      service = new MateProjectContextService(storage);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      const item = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "disabled-item",
        claimValue: "disabled",
        renderedText: "Disabled profile",
        confidence: 40,
        salienceScore: 40,
        projectionAllowed: true,
      });
      storage.forgetProfileItem(item.id);

      const text = service.getProjectDigestContextText(digestId);
      assert.equal(text, null);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("limit を適用して件数を絞る", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      service = new MateProjectContextService(storage);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "context-1",
        claimValue: "v1",
        renderedText: "Context one",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "context-2",
        claimValue: "v2",
        renderedText: "Context two",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "context-3",
        claimValue: "v3",
        renderedText: "Context three",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });

      const text = service.getProjectDigestContextText(digestId, { limit: 2 });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.equal(itemLines.length, 2);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
