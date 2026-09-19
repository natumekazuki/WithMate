import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory-v6-worker-client.js";
import { MemoryV6FileQuotaExceededError, MemoryV6IdempotencyConflictError, type MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";
import { CharacterAffectIdempotencyConflictError, CharacterAffectVersionConflictError } from "../../src-electron/character-affect-storage.js";
import type { AffectEventInput } from "../../src/character-affect/affect-contract.js";

// @test-value v2
// kind = "regression"
// claim = "Memory mutationのquota・idempotency拒否は実Worker往復後もドメイン例外であり、失敗した本文を保存しない"
// oracle = { type = "contract", ref = "src-electron/storage-worker-dispatcher.ts; src-electron/storage-worker-client.ts; src-electron/memory-v6-storage.ts" }
// fault = "dispatcherのserializationまたはclientのrehydrationが既知のmutation拒否をunknown outcomeへ変換するか、拒否したentryを部分保存する"
// observable = "実Memory Worker facadeの例外型・quota詳細とgetEntryの永続化内容"
// observation_boundary = "component-behavior"
// scope = "memory-worker-domain-errors"
// lifecycle = "permanent"
// impact = "結果不明と入力拒否を混同せず、既存のquota・再送競合応答を維持する"
// distinction = "clientへ合成errorを送るtestと異なり、実dispatcherとSQLite mutationの拒否経路を通す"
// @end-test-value
test("Memory Worker preserves quota and idempotency rejection types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-memory-worker-domain-"));
  let worker: MemoryV6WorkerClient | undefined;
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    worker = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage-worker-entry.ts", import.meta.url) });
    const input: Parameters<MemoryV6Storage["appendEntry"]>[0] = {
      id: "entry-a", target: { owner: { type: "user", id: "local-user" }, scope: { type: "global", id: "global" } },
      kind: "note", title: "Original", body: "Original body", preview: "Original body", tags: [],
      source: { type: "agent", sessionId: null, messageId: null, providerId: "codex" },
      idempotencyKey: "append-a", bindingIdHash: "binding-a",
    };
    await assert.rejects(worker.storage.appendEntry({
      ...input, fileQuotaBytes: 1,
      protectedObjects: [{ objectId: "a".repeat(32), role: "evidence", mediaKind: "image", contentType: "image/png",
        displayName: "example.png", summary: "Example", originalBytes: 10, storedBytes: 20, sha256: "b".repeat(64), keyId: "key-a" }],
    }), (error: unknown) => {
      assert.ok(error instanceof MemoryV6FileQuotaExceededError);
      assert.equal(error.quotaBytes, 1);
      assert.equal(error.usedBytes, 0);
      assert.equal(error.incomingBytes, 10);
      return true;
    });
    assert.equal(await worker.storage.getEntry(input.id!), null);
    await worker.storage.appendEntry(input);
    await assert.rejects(worker.storage.appendEntry({ ...input, body: "Conflicting body" }), MemoryV6IdempotencyConflictError);
    assert.equal((await worker.storage.getEntry(input.id!))?.body, "Original body");
  } finally {
    await worker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "regression"
// claim = "Affect mutationのversion・idempotency拒否は実Workerを越えて型と期待versionを維持する"
// oracle = { type = "contract", ref = "src-electron/storage-worker-dispatcher.ts; src-electron/storage-worker-client.ts; src-electron/character-affect-storage.ts" }
// fault = "dispatcherのserializationまたはclientのrehydrationがAffect拒否をunknown errorへ変換し、競合の型とversion情報を失う"
// observable = "実Worker APIの例外型・expectedVersion/actualVersionと確定済みeventの内容"
// observation_boundary = "component-behavior"
// scope = "affect-worker-domain-errors"
// lifecycle = "permanent"
// impact = "古いcontextの拒否と同一keyの競合を既存API契約通り区別できる"
// distinction = "同期Affect storage testやclientだけのerror fixtureではdispatcherのmutation分類を検出できない"
// @end-test-value
test("Affect Worker preserves version and idempotency rejection types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-affect-worker-domain-"));
  let worker: MemoryV6WorkerClient | undefined;
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character-a', 'A', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')");
      db.exec(`INSERT INTO sessions_v6 (id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at)
        VALUES ('session-a', 'A', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}',
        '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')`);
    } finally { db.close(); }
    worker = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage-worker-entry.ts", import.meta.url) });
    const event: AffectEventInput = {
      schemaVersion: "withmate-affect-v1", characterId: "character-a", userId: "local-user", sessionId: "session-a",
      layer: "relationship", targetType: "user", targetId: "local-user", family: "relief",
      value: { label: "Relief", valence: 0.1, arousal: 0.1 }, intensity: 0.1,
      reason: "Completed task", evidence: "Task completed", occurredAt: "2026-09-19T00:00:00.000Z", idempotencyKey: "event-a",
    };
    const state = await worker.affectStorage.getStateVersion({ characterId: "character-a", userId: "local-user", sessionId: "session-a" });
    await assert.rejects(worker.affectStorage.recordEvent(event, { expectedVersion: "stale-version" }), (error: unknown) => {
      assert.ok(error instanceof CharacterAffectVersionConflictError);
      assert.equal(error.expectedVersion, "stale-version");
      assert.equal(error.actualVersion, state.version);
      return true;
    });
    const saved = await worker.affectStorage.recordEvent(event);
    await assert.rejects(worker.affectStorage.recordEvent({ ...event, reason: "Different request" }), CharacterAffectIdempotencyConflictError);
    assert.equal((await worker.affectStorage.getEvent({ eventId: saved.event.id, characterId: "character-a", userId: "local-user" }))?.reason, event.reason);
  } finally {
    await worker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
