import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateProfileItemStorage } from "../../src-electron/mate-profile-item-storage.js";
import { MateProjectContextService } from "../../src-electron/mate-project-context-service.js";

const BASE_TIME = "2026-01-01T00:00:00.000Z";

type SemanticRetrievalResult = { embedding: { ownerId: string }; score: number };
type SemanticRetrievalService = {
  retrieve: (request: {
    queryText: string;
    ownerType: "profile_item";
    limit?: number;
    candidateLimit?: number;
    minScore?: number;
  }) => Promise<SemanticRetrievalResult[]>;
};

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

function updateProfileItemUpdatedAt(dbPath: string, itemId: string, updatedAt: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE mate_profile_items SET updated_at = ? WHERE id = ?").run(updatedAt, itemId);
  } finally {
    db.close();
  }
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

      const text = await service.getProjectDigestContextText(digestId);
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

      const text = await service.getProjectDigestContextText(digestId);
      assert.equal(text, null);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("queryText でスコアリングして関連度順に並び替える", async () => {
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
        claimKey: "api-tag",
        claimValue: "authentication",
        renderedText: "auth notes",
        confidence: 50,
        salienceScore: 10,
        projectionAllowed: true,
        tags: [{ type: "topic", value: "api token" }],
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "token",
        claimValue: "api token",
        renderedText: "endpoint notes",
        confidence: 50,
        salienceScore: 20,
        projectionAllowed: true,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "other",
        claimValue: "random",
        renderedText: "no match",
        confidence: 50,
        salienceScore: 80,
        projectionAllowed: true,
      });

      const text = await service.getProjectDigestContextText(digestId, { queryText: "api token" });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.deepEqual(itemLines, [
        "- **token:** endpoint notes",
        "- **api-tag:** auth notes",
        "- **other:** no match",
      ]);
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

      const text = await service.getProjectDigestContextText(digestId, { limit: 2 });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.equal(itemLines.length, 2);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("queryText 指定時は limit 適用前に関連度で選別する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      service = new MateProjectContextService(storage);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      const oldRelevant = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "old-relevant",
        claimValue: "Needle detail",
        renderedText: "Needle detail",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });
      const newUnrelated = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "new-unrelated",
        claimValue: "random",
        renderedText: "New unrelated",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });

      updateProfileItemUpdatedAt(dbPath, oldRelevant.id, "2026-01-01T00:00:00.000Z");
      updateProfileItemUpdatedAt(dbPath, newUnrelated.id, "2026-01-01T01:00:00.000Z");

      const text = await service.getProjectDigestContextText(digestId, { queryText: "needle", limit: 1 });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.deepEqual(itemLines, ["- **old-relevant:** Needle detail"]);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("semantic score で lexical より低い item でも上位になる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      const lexicalItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "lexical-top",
        claimValue: "query-item",
        renderedText: "This text does not match the query",
        confidence: 50,
        salienceScore: 60,
        projectionAllowed: true,
      });
      const semanticItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "semantic-top",
        claimValue: "unrelated text",
        renderedText: "Different text",
        confidence: 50,
        salienceScore: 40,
        projectionAllowed: true,
      });

      service = new MateProjectContextService(storage, {
        retrieve: async () => [
          {
            embedding: {
              ownerId: semanticItem.id,
            },
            score: 2,
          },
        ],
      });

      const text = await service.getProjectDigestContextText(digestId, { queryText: "target" });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.deepEqual(itemLines, [
        `- **${semanticItem.claimKey}:** ${semanticItem.renderedText}`,
        `- **${lexicalItem.claimKey}:** ${lexicalItem.renderedText}`,
      ]);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("retrieval ownerId が別 section / project / disabled / projection false の item を除外する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);
      const otherProjectDigestId = "pd-ctx-2";

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
          ) VALUES (?, ?, 'git', 'git:ctx2', '/tmp', '', 'ctx2', '/tmp/ctx2.digest', '', 0, NULL, NULL, NULL, NULL, ?, ?)
        `).run(otherProjectDigestId, "current", BASE_TIME, BASE_TIME);
      } finally {
        db.close();
      }

      const semanticItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "semantic-target",
        claimValue: "non lexical",
        renderedText: "Non lexical content",
        confidence: 50,
        salienceScore: 10,
        projectionAllowed: true,
      });
      const lexicalItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "lexical-only",
        claimValue: "query match",
        renderedText: "query match",
        confidence: 50,
        salienceScore: 80,
        projectionAllowed: true,
      });
      const coreItem = storage.upsertProfileItem({
        sectionKey: "core",
        category: "note",
        claimKey: "core-item",
        claimValue: "core value",
        renderedText: "core value",
        confidence: 50,
        salienceScore: 100,
        projectionAllowed: true,
      });
      const disabledItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "disabled-item",
        claimValue: "disabled value",
        renderedText: "disabled value",
        confidence: 50,
        salienceScore: 70,
        projectionAllowed: true,
      });
      storage.disableProfileItem(disabledItem.id);
      const hiddenItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "hidden-item",
        claimValue: "hidden value",
        renderedText: "hidden value",
        confidence: 50,
        salienceScore: 70,
        projectionAllowed: false,
      });
      const otherProjectItem = storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: otherProjectDigestId,
        category: "note",
        claimKey: "other-project-item",
        claimValue: "other project",
        renderedText: "other project",
        confidence: 50,
        salienceScore: 70,
        projectionAllowed: true,
      });

      service = new MateProjectContextService(storage, {
        retrieve: async () => [
          {
            embedding: {
              ownerId: coreItem.id,
            },
            score: 10,
          },
          {
            embedding: {
              ownerId: disabledItem.id,
            },
            score: 10,
          },
          {
            embedding: {
              ownerId: hiddenItem.id,
            },
            score: 10,
          },
          {
            embedding: {
              ownerId: otherProjectItem.id,
            },
            score: 10,
          },
          {
            embedding: {
              ownerId: semanticItem.id,
            },
            score: 5,
          },
          {
            embedding: {
              ownerId: lexicalItem.id,
            },
            score: 0,
          },
        ],
      });

      const text = await service.getProjectDigestContextText(digestId, { queryText: "query" });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.deepEqual(itemLines, [
        `- **${semanticItem.claimKey}:** ${semanticItem.renderedText}`,
        `- **${lexicalItem.claimKey}:** ${lexicalItem.renderedText}`,
      ]);
      assert.equal(itemLines.some((line) => line.includes("core-item")), false);
      assert.equal(itemLines.some((line) => line.includes("disabled-item")), false);
      assert.equal(itemLines.some((line) => line.includes("hidden-item")), false);
      assert.equal(itemLines.some((line) => line.includes("other-project-item")), false);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("semantic retrieval が throw しても lexical ranking で返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-project-context-service-"));
    const dbPath = path.join(tempDirectory, "withmate-v4.db");
    let storage: MateProfileItemStorage | null = null;
    let service: MateProjectContextService | null = null;

    try {
      storage = new MateProfileItemStorage(dbPath);
      service = new MateProjectContextService(storage, {
        retrieve: async () => {
          throw new Error("embedding unavailable");
        },
      });
      seedCurrentMate(dbPath);
      const digestId = seedProjectDigest(dbPath);

      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "high-lexical",
        claimValue: "Needle detail",
        renderedText: "Needle detail",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });
      storage.upsertProfileItem({
        sectionKey: "project_digest",
        projectDigestId: digestId,
        category: "note",
        claimKey: "low-lexical",
        claimValue: "other",
        renderedText: "Other detail",
        confidence: 50,
        salienceScore: 10,
        projectionAllowed: true,
      });

      const text = await service.getProjectDigestContextText(digestId, { queryText: "needle" });
      const itemLines = (text?.split("\n") ?? []).filter((line) => line.startsWith("- "));
      assert.deepEqual(itemLines, [
        "- **high-lexical:** Needle detail",
        "- **low-lexical:** Other detail",
      ]);
    } finally {
      storage?.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
