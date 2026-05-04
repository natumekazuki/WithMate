import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateSemanticEmbeddingStorage } from "../../src-electron/mate-semantic-embedding-storage.js";

function createTempDbPath(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-semantic-embedding-"))
    .then((tmpDir) => ({
      dbPath: path.join(tmpDir, "withmate-v4.db"),
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true });
      },
    }));
}

function seedCurrentMate(dbPath: string): void {
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
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
    `).run(now, now);
  } finally {
    db.close();
  }
}

function assertFloatArrayClose(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const diff = Math.abs(actual[index] - expected[index]);
    assert.ok(diff < 0.0001, `vector[${index}] が一致しません: ${actual[index]} != ${expected[index]}`);
  }
}

function listCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM mate_semantic_embeddings").get() as {
      count: number;
    }).count;
  } finally {
    db.close();
  }
}

function getBaseEmbedding() {
  return {
    ownerType: "growth_event" as const,
    ownerId: "growth-event-1",
    embeddingBackendType: "local_transformers_js",
    embeddingModelId: "Xenova/multilingual-e5-small",
  };
}

describe("MateSemanticEmbeddingStorage", () => {
  it("upsert / get で Float32 little-endian BLOB の roundtrip ができる", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateSemanticEmbeddingStorage | null = null;

    try {
      storage = new MateSemanticEmbeddingStorage(dbPath);
      seedCurrentMate(dbPath);

      const input = {
        ...getBaseEmbedding(),
        text: "ユーザーは短文で要点を話す傾向がある",
        vector: new Float32Array([0.5, -1.25, 3.5, 10.0]),
      };

      const upserted = storage.upsertEmbedding(input);
      const loaded = storage.getEmbedding(input);
      assert.ok(loaded);
      assert.equal(upserted.id, loaded.id);
      assert.equal(loaded.embeddingBackendType, input.embeddingBackendType);
      assert.equal(loaded.embeddingModelId, input.embeddingModelId);
      assert.equal(loaded.ownerType, input.ownerType);
      assert.equal(loaded.ownerId, input.ownerId);
      assert.equal(loaded.dimension, input.vector.length);
      assertFloatArrayClose(loaded.vector, Array.from(input.vector));
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("同一 owner/text/backend/model の upsert は1件に統合され、updatedAt が更新される", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateSemanticEmbeddingStorage | null = null;

    try {
      storage = new MateSemanticEmbeddingStorage(dbPath);
      seedCurrentMate(dbPath);

      const request = {
        ...getBaseEmbedding(),
        text: "更新対象テキスト",
      };

      const first = storage.upsertEmbedding({
        ...request,
        vector: new Float32Array([1.0, 2.0, 3.0]),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = storage.upsertEmbedding({
        ...request,
        vector: new Float32Array([2.0, 3.0, 4.0]),
      });

      assert.equal(first.id, second.id);
      assert.ok(second.updatedAt > first.updatedAt);
      assertFloatArrayClose(second.vector, [2.0, 3.0, 4.0]);
      assert.equal(storage.listEmbeddingsForOwner(request.ownerType, request.ownerId).length, 1);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("text が変わると別レコードとして保存される", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateSemanticEmbeddingStorage | null = null;

    try {
      storage = new MateSemanticEmbeddingStorage(dbPath);
      seedCurrentMate(dbPath);

      const base = getBaseEmbedding();
      const first = storage.upsertEmbedding({
        ...base,
        text: "text-a",
        vector: [1, 2, 3],
      });
      const second = storage.upsertEmbedding({
        ...base,
        text: "text-b",
        vector: [4, 5, 6],
      });

      const list = storage.listEmbeddingsForOwner(base.ownerType, base.ownerId);

      assert.notEqual(first.id, second.id);
      assert.equal(list.length, 2);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("owner か model で削除でき、削除件数が返る", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateSemanticEmbeddingStorage | null = null;

    try {
      storage = new MateSemanticEmbeddingStorage(dbPath);
      seedCurrentMate(dbPath);

      const base = getBaseEmbedding();
      storage.upsertEmbedding({
        ...base,
        ownerId: "owner-a",
        text: "a1",
        vector: [1, 2, 3],
      });
      storage.upsertEmbedding({
        ...base,
        ownerId: "owner-a",
        text: "a2",
        vector: [4, 5, 6],
      });
      storage.upsertEmbedding({
        ...base,
        ownerId: "owner-b",
        text: "b1",
        vector: [7, 8, 9],
      });

      const removedForOwner = storage.deleteEmbeddingsForOwner("growth_event", "owner-a");
      assert.equal(removedForOwner, 2);
      assert.equal(storage.listEmbeddingsForOwner("growth_event", "owner-a").length, 0);

      const removedForModel = storage.deleteEmbeddingsForModel(base.embeddingBackendType, base.embeddingModelId);
      assert.equal(removedForModel, 1);
      assert.equal(listCount(dbPath), 0);
    } finally {
      storage?.close();
      await cleanup();
    }
  });

  it("invalid input は reject される", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    let storage: MateSemanticEmbeddingStorage | null = null;

    try {
      storage = new MateSemanticEmbeddingStorage(dbPath);
      seedCurrentMate(dbPath);

      const base = {
        ownerType: "growth_event" as const,
        ownerId: "owner-a",
        text: "text",
        embeddingBackendType: "backend",
        embeddingModelId: "model",
      };

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          ownerId: "",
          vector: [1, 2, 3],
        });
      }, /ownerId/);

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          text: "",
          vector: [1, 2, 3],
        });
      }, /text/);

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          embeddingBackendType: "",
          vector: [1, 2, 3],
        });
      }, /embeddingBackendType/);

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          embeddingModelId: "",
          vector: [1, 2, 3],
        });
      }, /embeddingModelId/);

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          text: "empty vector",
          vector: [],
        });
      }, /vector/);

      assert.throws(() => {
        storage!.upsertEmbedding({
          ...base,
          text: "invalid number",
          vector: [1, Number.NaN],
        });
      }, /vector/);
    } finally {
      storage?.close();
      await cleanup();
    }
  });
});

