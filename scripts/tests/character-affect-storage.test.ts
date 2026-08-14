import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import { AFFECT_SCHEMA_VERSION, type AffectEventInput } from "../../src/character-affect/affect-contract.js";
import {
  CharacterAffectIdempotencyConflictError,
  CharacterAffectStorage,
  CharacterAffectVersionConflictError,
} from "../../src-electron/character-affect-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";

function createFixture(): { directory: string; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "withmate-affect-"));
  const dbPath = join(directory, "withmate-v6.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    ensureV6Schema(db);
    db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES ('character-a', 'Character A', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES ('character-b', 'Character B', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')
    `).run();
    const insertSession = db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}', ?, ?, ?)
    `);
    for (const sessionId of ["session-a", "session-b"]) {
      insertSession.run(
        sessionId,
        sessionId,
        "2026-08-09T00:00:00.000Z",
        "2026-08-09T00:00:00.000Z",
        "2026-08-09T00:00:00.000Z",
      );
    }
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at
      ) VALUES ('session-other', 'Other', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-b', '{}', ?, ?, ?)
    `).run(
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
  return { directory, dbPath };
}

function event(overrides: Partial<AffectEventInput> = {}): AffectEventInput {
  return {
    schemaVersion: AFFECT_SCHEMA_VERSION,
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "bug",
    targetId: "bug-1",
    family: "frustration",
    value: { label: "frustration", valence: -0.6, arousal: 0.7 },
    intensity: 0.5,
    reason: "The same bug recurred.",
    evidence: "The test failed again.",
    occurredAt: "2026-08-09T01:00:00.000Z",
    idempotencyKey: "event-a",
    ...overrides,
  };
}

function affectStorage(dbPath: string): CharacterAffectStorage {
  return new CharacterAffectStorage(dbPath, {
    now: () => new Date("2026-08-09T01:00:00.000Z"),
  });
}

type WorkerMessage = {
  type: "locked" | "released" | "ready" | "attempting" | "result" | "error";
  created?: boolean;
  eventId?: string;
  message?: string;
};

function createMailbox(worker: Worker): { next(type: WorkerMessage["type"]): Promise<WorkerMessage> } {
  const queued: WorkerMessage[] = [];
  let exitError: Error | null = null;
  const waiters: Array<{
    type: WorkerMessage["type"];
    resolve(message: WorkerMessage): void;
    reject(error: Error): void;
  }> = [];
  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "error") {
      const error = new Error(message.message ?? "Character Affect concurrency worker failed.");
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter.reject(error);
      }
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index >= 0) {
      waiters.splice(index, 1)[0]!.resolve(message);
    } else {
      queued.push(message);
    }
  });
  worker.on("error", (error) => {
    exitError = error;
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(error);
    }
  });
  worker.on("exit", (code) => {
    if (code === 0 && waiters.length === 0) {
      return;
    }
    exitError = new Error(`Character Affect concurrency worker exited before completing a message (code ${code}).`);
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(exitError);
    }
  });
  return {
    next(type) {
      const index = queued.findIndex((message) => message.type === type);
      if (index >= 0) {
        return Promise.resolve(queued.splice(index, 1)[0]!);
      }
      if (exitError) {
        return Promise.reject(exitError);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve(message: WorkerMessage) {
            clearTimeout(timeout);
            resolve(message);
          },
          reject(error: Error) {
            clearTimeout(timeout);
            reject(error);
          },
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for Character Affect worker message: ${type}`));
        }, 10_000);
        waiters.push(waiter);
      });
    },
  };
}

async function waitForStarted(counter: Int32Array, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Atomics.load(counter, 0) < count) {
    if (Date.now() >= deadline) {
      throw new Error("Append workers did not reach the concurrency barrier.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("CharacterAffectStorage", () => {
  it("別接続のwrite lockと複数Session appendを実際に重ね、busy timeout内で欠落なく直列化する", async () => {
    const fixture = createFixture();
    const workerUrl = new URL("./fixtures/character-affect-concurrency-worker.ts", import.meta.url);
    let blocker: Worker | undefined;
    const startedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const started = new Int32Array(startedBuffer);
    const relationship = event({
      layer: "relationship",
      targetType: "relationship",
      targetId: "local-user:character-a",
      value: { label: "trust", valence: 0.7 },
      reason: "Both sessions share relationship trust.",
      evidence: "The user requested concurrent verification.",
      occurredAt: "2026-08-09T01:02:00.000Z",
      idempotencyKey: "concurrent-relationship",
    });
    const appendEvents = [
      event({ idempotencyKey: "concurrent-session-a" }),
      event({
        sessionId: "session-b",
        targetType: "task",
        targetId: "task-b",
        value: { label: "satisfaction", valence: 0.8 },
        reason: "Task B succeeded.",
        evidence: "Build B passed.",
        occurredAt: "2026-08-09T01:01:00.000Z",
        idempotencyKey: "concurrent-session-b",
      }),
      relationship,
      relationship,
    ];
    const appendWorkers: Worker[] = [];
    const appendMailboxes: Array<ReturnType<typeof createMailbox>> = [];
    try {
      for (const appendEvent of appendEvents) {
        const worker = new Worker(workerUrl, {
          workerData: {
            mode: "append",
            dbPath: fixture.dbPath,
            event: appendEvent,
            started: startedBuffer,
          },
        });
        const mailbox = createMailbox(worker);
        appendWorkers.push(worker);
        appendMailboxes.push(mailbox);
        await mailbox.next("ready");
      }
      blocker = new Worker(workerUrl, { workerData: { mode: "blocker", dbPath: fixture.dbPath } });
      const blockerMailbox = createMailbox(blocker);
      await blockerMailbox.next("locked");
      const resultPromises = appendMailboxes.map((mailbox) => mailbox.next("result"));
      for (const worker of appendWorkers) {
        worker.postMessage({ type: "start" });
      }
      await Promise.all(appendMailboxes.map((mailbox) => mailbox.next("attempting")));
      await waitForStarted(started, appendWorkers.length);

      let resultWhileLocked = false;
      void Promise.race(resultPromises).then(() => {
        resultWhileLocked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(resultWhileLocked, false);

      blocker.postMessage({ type: "release" });
      const results = await Promise.all(resultPromises);
      await blockerMailbox.next("released");
      assert.equal(results.filter((result) => result.created === true).length, 3);
      assert.equal(results.filter((result) => result.created === false).length, 1);
      assert.equal(new Set(results.map((result) => result.eventId)).size, 3);

      const storage = affectStorage(fixture.dbPath);
      try {
        const stateA = storage.getEffectiveState({
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-a",
        });
        const stateB = storage.getEffectiveState({
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-b",
        });
        assert.ok(stateA.components.some((item) => item.targetId === "bug-1"));
        assert.ok(!stateA.components.some((item) => item.targetId === "task-b"));
        assert.ok(stateB.components.some((item) => item.targetId === "task-b"));
        assert.ok(!stateB.components.some((item) => item.targetId === "bug-1"));
        assert.ok(stateA.components.some((item) => item.label === "trust"));
        assert.ok(stateB.components.some((item) => item.label === "trust"));
        assert.equal(storage.getMetrics().idempotencyReplays, 1);
      } finally {
        storage.close();
      }

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const counts = db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM character_affect_events_v6) AS events,
            (SELECT COUNT(*) FROM character_affect_idempotency_v6) AS idempotency,
            (SELECT COUNT(*) FROM character_affect_mutations_v6 WHERE operation = 'record') AS records,
            (SELECT COUNT(*) FROM character_affect_observations_v6 WHERE outcome = 'replayed') AS replays
        `).get() as { events: number; idempotency: number; records: number; replays: number };
        assert.deepEqual({ ...counts }, { events: 3, idempotency: 3, records: 3, replays: 1 });
      } finally {
        db.close();
      }
    } finally {
      await Promise.allSettled(
        [...(blocker ? [blocker] : []), ...appendWorkers].map((worker) => worker.terminate()),
      );
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("sessionごとの状態を分離し、relationshipだけを共有する", () => {
    const fixture = createFixture();
    const storageA = affectStorage(fixture.dbPath);
    const storageB = affectStorage(fixture.dbPath);
    try {
      storageA.recordEvent(event());
      storageB.recordEvent(event({
        sessionId: "session-b",
        targetId: "task-b",
        targetType: "task",
        value: { label: "satisfaction", valence: 0.8 },
        reason: "Task B succeeded.",
        evidence: "Build B passed.",
        occurredAt: "2026-08-09T01:01:00.000Z",
        idempotencyKey: "event-b",
      }));
      storageA.recordEvent(event({
        layer: "relationship",
        targetType: "relationship",
        targetId: "local-user:character-a",
        value: { label: "trust", valence: 0.7 },
        reason: "The user checked the result carefully.",
        evidence: "The user requested a direct verification.",
        occurredAt: "2026-08-09T01:02:00.000Z",
        idempotencyKey: "event-relationship",
      }));

      const stateA = storageA.getEffectiveState({ characterId: "character-a", userId: "local-user", sessionId: "session-a" });
      const stateB = storageB.getEffectiveState({ characterId: "character-a", userId: "local-user", sessionId: "session-b" });
      assert.ok(stateA.components.some((item) => item.targetId === "bug-1"));
      assert.ok(!stateA.components.some((item) => item.targetId === "task-b"));
      assert.ok(stateB.components.some((item) => item.targetId === "task-b"));
      assert.ok(!stateB.components.some((item) => item.targetId === "bug-1"));
      assert.ok(stateA.components.some((item) => item.label === "trust"));
      assert.ok(stateB.components.some((item) => item.label === "trust"));
      const sessionBInspection = storageB.inspect({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-b",
      });
      const relationshipEvent = sessionBInspection.events.find(
        (item) => item.idempotencyKey === "event-relationship",
      );
      assert.ok(relationshipEvent);
      assert.ok(sessionBInspection.mutations.some((item) => item.eventId === relationshipEvent.id));
      assert.throws(
        () => storageA.inspect({
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-other",
        }),
        /does not belong to the Character affect owner/,
      );
    } finally {
      storageA.close();
      storageB.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("retryは二重登録せず、異なるrequestでのkey再利用を拒否する", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const first = storage.recordEvent(event());
      const replay = storage.recordEvent(event());
      assert.equal(first.created, true);
      assert.equal(replay.created, false);
      assert.equal(replay.event.id, first.event.id);
      assert.throws(
        () => storage.recordEvent(event({ reason: "Different request." })),
        CharacterAffectIdempotencyConflictError,
      );
      assert.equal(storage.inspect({ characterId: "character-a", userId: "local-user" }).events.length, 1);
      assert.equal(storage.getMetrics().idempotencyReplays, 1);
      assert.equal(storage.getMetrics().idempotencyConflictsRejected, 1);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("同一idempotency keyのreplayをexpected version検査より先に解決する", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const initialVersion = storage.getStateVersion({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      }).version;
      const first = storage.recordEvent(event(), { expectedVersion: initialVersion });
      const replay = storage.recordEvent(event(), { expectedVersion: initialVersion });
      assert.equal(replay.created, false);
      assert.equal(replay.event.id, first.event.id);
      assert.throws(
        () => storage.recordEvent(event({ idempotencyKey: "uncommitted-generation" }), {
          expectedVersion: initialVersion,
        }),
        CharacterAffectVersionConflictError,
      );
      assert.equal(storage.inspect({ characterId: "character-a", userId: "local-user" }).events.length, 1);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("optional fieldの省略と明示的undefinedを同じrequestとして扱い、valid JSONを保存する", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const explicitUndefined = event({
        value: {
          label: "frustration",
          valence: -0.4,
          arousal: undefined,
          dimensions: undefined,
        },
        memoryEpisode: undefined,
      });
      const first = storage.recordEvent(explicitUndefined);
      const replay = storage.recordEvent(event({
        value: { label: "frustration", valence: -0.4 },
      }));
      assert.equal(replay.created, false);
      assert.equal(replay.event.id, first.event.id);
      assert.deepEqual(replay.event.value, { label: "frustration", valence: -0.4 });
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("idempotency keyを操作横断で所有し、訂正理由も同一request判定へ含める", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const original = storage.recordEvent(event()).event;
      assert.throws(
        () => storage.reset({
          characterId: "character-a",
          userId: "local-user",
          layer: "session",
          sessionId: "session-a",
          reason: "Conflicting operation.",
          resetAt: "2026-08-09T02:00:00.000Z",
          idempotencyKey: "event-a",
        }),
        CharacterAffectIdempotencyConflictError,
      );
      const correction = {
        eventId: original.id,
        replacement: event({ idempotencyKey: "correction-key" }),
        reason: "First correction reason.",
      };
      storage.correctEvent(correction);
      assert.throws(
        () => storage.correctEvent({ ...correction, reason: "Different correction reason." }),
        CharacterAffectIdempotencyConflictError,
      );
      assert.equal(storage.getMetrics().idempotencyConflictsRejected, 2);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("schema versionと時系列比較に使えないtimestampをruntime境界で拒否する", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      assert.throws(
        () => storage.recordEvent({ ...event(), schemaVersion: "future-affect" as typeof AFFECT_SCHEMA_VERSION }),
        /schemaVersion/,
      );
      assert.throws(
        () => storage.recordEvent(event({ occurredAt: "2026-08-09T10:00:00+09:00" })),
        /canonical UTC timestamp/,
      );
      assert.throws(
        () => storage.reset({
          characterId: "character-a",
          userId: "local-user",
          layer: "session",
          sessionId: "session-a",
          reason: "Noncanonical reset.",
          resetAt: "2026-08-09T11:00:00+09:00",
          idempotencyKey: "bad-reset-time",
        }),
        /canonical UTC timestamp/,
      );
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("baselineと段階的なsession eventを同じownerで合成し、値をclampする", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      storage.recordEvent(event({
        targetType: "self",
        targetId: "character-a",
        family: "determination",
        value: { label: "resolve", valence: 0.8 },
        intensity: 0.75,
        idempotencyKey: "resolve-1",
      }));
      storage.recordEvent(event({
        targetType: "self",
        targetId: "character-a",
        family: "determination",
        value: { label: "resolve", valence: 0.8 },
        intensity: 0.75,
        occurredAt: "2026-08-09T01:01:00.000Z",
        idempotencyKey: "resolve-2",
      }));
      const state = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
        baseline: [{
          targetType: "self",
          targetId: "character-a",
          family: "determination",
          value: { label: "resolve", valence: 0.6 },
          intensity: 0.5,
          reason: "Character baseline.",
        }],
      });
      const resolve = state.components.find((item) => item.label === "resolve");
      assert.equal(resolve?.valence, 1);
      assert.equal(resolve?.intensity, 1);
      assert.deepEqual(resolve?.contributingLayers, ["baseline", "session"]);
      assert.equal(resolve?.eventIds.length, 2);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("bug targetをrelationshipへ保存できず、session resetはrelationshipを消さない", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      assert.throws(
        () => storage.recordEvent(event({ layer: "relationship" })),
        /Relationship affect may only target/,
      );
      storage.recordEvent(event());
      const relationship = storage.recordEvent(event({
        layer: "relationship",
        targetType: "user",
        targetId: "local-user",
        value: { label: "warmth", valence: 0.5 },
        idempotencyKey: "relationship",
      })).event;
      assert.equal(relationship.sessionId, null);
      assert.equal(relationship.sourceSessionId, "session-a");
      storage.reset({
        characterId: "character-a",
        userId: "local-user",
        layer: "session",
        sessionId: "session-a",
        reason: "User requested a session reset.",
        resetAt: "2026-08-09T02:00:00.000Z",
        idempotencyKey: "reset-session-a",
      });
      const state = storage.getEffectiveState({ characterId: "character-a", userId: "local-user", sessionId: "session-a" });
      assert.ok(!state.components.some((item) => item.targetId === "bug-1"));
      assert.ok(state.components.some((item) => item.label === "warmth"));
      const inspection = storage.inspect({ characterId: "character-a", userId: "local-user" });
      const relationshipMutation = inspection.mutations.find(
        (item) => item.operation === "record" && item.eventId === relationship.id,
      );
      assert.equal(relationshipMutation?.sessionId, null);
      assert.equal(relationshipMutation?.sourceSessionId, "session-a");
      assert.equal(inspection.events.length, 2);
      assert.equal(inspection.resets.length, 1);
      assert.ok(inspection.mutations.some((item) => item.operation === "reset"));
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("local-user以外のownerはMemory候補の有無にかかわらず保存しない", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      assert.throws(
        () => storage.recordEvent(event({ userId: "other-user" })),
        /owner must be local-user/,
      );
      assert.equal(storage.getMetrics().events, 0);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("訂正後の投影と元event、mutation auditを同時に確認できる", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const original = storage.recordEvent(event()).event;
      const replacement = storage.correctEvent({
        eventId: original.id,
        replacement: event({
          value: { label: "determination", valence: 0.4, arousal: 0.5 },
          intensity: 0.8,
          reason: "The bug became a solvable task.",
          evidence: "A reproduction case was isolated.",
          occurredAt: "2026-08-09T01:05:00.000Z",
          idempotencyKey: "event-a-correction",
        }),
        reason: "Corrected an overstatement.",
      }).event;
      const inspection = storage.inspect({ characterId: "character-a", userId: "local-user" });
      assert.equal(inspection.events.find((item) => item.id === original.id)?.state, "corrected");
      assert.equal(replacement.correctionOfEventId, original.id);
      assert.ok(inspection.mutations.some((item) => item.operation === "correct" && item.eventId === replacement.id));
      const state = storage.getEffectiveState({ characterId: "character-a", userId: "local-user", sessionId: "session-a" });
      assert.ok(state.components.some((item) => item.label === "determination"));
      assert.ok(!state.components.some((item) => item.label === "frustration"));
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("別sessionのinspectionでもcross-layer correction chainを一式確認できる", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const original = storage.recordEvent(event({
        layer: "relationship",
        targetType: "relationship",
        targetId: "local-user:character-a",
        value: { label: "trust", valence: 0.6 },
        idempotencyKey: "relationship-to-correct",
      })).event;
      const replacement = storage.correctEvent({
        eventId: original.id,
        replacement: event({
          layer: "session",
          targetType: "task",
          targetId: "verification-task",
          value: { label: "confidence", valence: 0.5 },
          occurredAt: "2026-08-09T01:05:00.000Z",
          idempotencyKey: "relationship-to-session-correction",
        }),
        reason: "The affect belonged to the task, not the relationship.",
      }).event;

      const inspection = storage.inspect({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-b",
      });
      assert.ok(inspection.events.some((item) => item.id === original.id && item.state === "corrected"));
      assert.ok(inspection.events.some((item) => item.id === replacement.id));
      assert.ok(inspection.mutations.some(
        (item) => item.operation === "correct" && item.eventId === replacement.id,
      ));

      const reverseOriginal = storage.recordEvent(event({
        targetType: "task",
        targetId: "relationship-review",
        value: { label: "caution", valence: -0.2 },
        occurredAt: "2026-08-09T01:10:00.000Z",
        idempotencyKey: "session-to-relationship-original",
      })).event;
      const reverseReplacement = storage.correctEvent({
        eventId: reverseOriginal.id,
        replacement: event({
          layer: "relationship",
          targetType: "relationship",
          targetId: "local-user:character-a",
          value: { label: "trust", valence: 0.4 },
          occurredAt: "2026-08-09T01:15:00.000Z",
          idempotencyKey: "session-to-relationship-correction",
        }),
        reason: "The evidence supports relationship trust.",
      }).event;
      const reverseInspection = storage.inspect({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-b",
      });
      assert.ok(reverseInspection.events.some((item) => item.id === reverseOriginal.id));
      assert.ok(reverseInspection.events.some((item) => item.id === reverseReplacement.id));
      assert.ok(reverseInspection.mutations.some(
        (item) => item.operation === "correct" && item.eventId === reverseReplacement.id,
      ));
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("source session削除後もrelationship affectと訂正auditを保持し、session affectだけを削除する", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const relationshipInput = event({
        layer: "relationship",
        targetType: "relationship",
        targetId: "local-user:character-a",
        value: { label: "trust", valence: 0.7 },
        idempotencyKey: "durable-relationship",
      });
      const relationship = storage.recordEvent(relationshipInput).event;
      const sessionOriginal = storage.recordEvent(event({
        targetType: "task",
        targetId: "shared-work",
        value: { label: "confidence", valence: 0.3 },
        occurredAt: "2026-08-09T01:05:00.000Z",
        idempotencyKey: "session-before-relationship",
      })).event;
      const correction = {
        eventId: sessionOriginal.id,
        replacement: event({
          layer: "relationship",
          targetType: "relationship",
          targetId: "local-user:character-a",
          value: { label: "confidence", valence: 0.5 },
          occurredAt: "2026-08-09T01:10:00.000Z",
          idempotencyKey: "session-to-durable-relationship",
        }),
        reason: "The confidence applies to the relationship.",
      };
      const relationshipReplacement = storage.correctEvent(correction).event;

      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.prepare("DELETE FROM sessions_v6 WHERE id = 'session-a'").run();
        const durableIdempotency = db.prepare(`
          SELECT COUNT(*) AS count
          FROM character_affect_idempotency_v6
          WHERE idempotency_key IN ('durable-relationship', 'session-to-durable-relationship')
        `).get() as { count: number };
        assert.equal(durableIdempotency.count, 2);
      } finally {
        db.close();
      }

      const state = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-b",
      });
      assert.ok(state.components.some((item) => item.eventIds.includes(relationship.id)));
      assert.ok(state.components.some((item) => item.eventIds.includes(relationshipReplacement.id)));
      const inspection = storage.inspect({ characterId: "character-a", userId: "local-user" });
      assert.ok(!inspection.events.some((item) => item.id === sessionOriginal.id));
      assert.equal(inspection.events.find((item) => item.id === relationship.id)?.sourceSessionId, null);
      assert.equal(
        inspection.events.find((item) => item.id === relationshipReplacement.id)?.correctionOfEventId,
        null,
      );
      assert.ok(inspection.mutations.some(
        (item) => item.operation === "correct"
          && item.eventId === relationshipReplacement.id
          && item.reason === "The confidence applies to the relationship.",
      ));
      assert.equal(storage.getMetrics().relationshipUpdates, 2);
      assert.equal(storage.getMetrics().sessionUpdates, 0);
      const delayedRecordReplay = storage.recordEvent(relationshipInput);
      assert.equal(delayedRecordReplay.created, false);
      assert.equal(delayedRecordReplay.event.id, relationship.id);
      const delayedReplay = storage.correctEvent(correction);
      assert.equal(delayedReplay.created, false);
      assert.equal(delayedReplay.event.id, relationshipReplacement.id);
      assert.equal(storage.getMetrics().idempotencyReplays, 2);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("同target・同familyの異labelを統合し、target/family差とstable representative順を保つ", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const first = storage.recordEvent(event({
        family: "determination",
        value: { label: "steady", valence: 0.4 },
        intensity: 0.6,
        idempotencyKey: "family-steady",
      })).event;
      const second = storage.recordEvent(event({
        family: "determination",
        value: { label: "locked-in", valence: 0.5 },
        intensity: 0.6,
        idempotencyKey: "family-locked-in",
      })).event;
      storage.recordEvent(event({
        targetId: "bug-2",
        family: "determination",
        value: { label: "other-target", valence: 0.2 },
        idempotencyKey: "family-other-target",
      }));
      storage.recordEvent(event({
        family: "concern",
        value: { label: "same-target-other-family", valence: -0.2 },
        idempotencyKey: "family-other-family",
      }));

      const state = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      const determination = state.components.filter(
        (component) => component.targetId === "bug-1" && component.family === "determination",
      );
      assert.equal(determination.length, 1);
      assert.deepEqual(new Set(determination[0]?.eventIds), new Set([first.id, second.id]));
      assert.equal(
        determination[0]?.label,
        first.id.localeCompare(second.id) < 0 ? "steady" : "locked-in",
      );
      assert.equal(state.components.some(
        (component) => component.targetId === "bug-2" && component.family === "determination",
      ), true);
      assert.equal(state.components.some(
        (component) => component.targetId === "bug-1" && component.family === "concern",
      ), true);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("sessionだけをhalf-lifeとminimum thresholdで減衰し、clock-only readでversionを変えない", () => {
    const fixture = createFixture();
    const occurredAtMs = Date.parse("2026-08-09T01:00:00.000Z");
    let nowMs = occurredAtMs + 1_000;
    const storage = new CharacterAffectStorage(fixture.dbPath, {
      now: () => new Date(nowMs),
      sessionHalfLifeMs: 1_000,
      minimumDecayWeight: 0.05,
    });
    try {
      storage.recordEvent(event({
        value: {
          label: "decaying",
          valence: -0.6,
          arousal: 0.7,
          dimensions: { focus: 0.8 },
        },
        intensity: 0.5,
        idempotencyKey: "decay-session",
      }));
      storage.recordEvent(event({
        layer: "relationship",
        targetType: "relationship",
        targetId: "character-a:local-user",
        family: "affinity",
        value: { label: "stable-affinity", valence: 0.5, arousal: 0.2, dimensions: { trust: 0.4 } },
        intensity: 0.6,
        idempotencyKey: "decay-relationship",
      }));
      const versionBefore = storage.getStateVersion({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });

      const halfLife = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      const halfLifeSession = halfLife.components.find((component) => component.family === "frustration");
      const relationship = halfLife.components.find((component) => component.family === "affinity");
      assert.equal(halfLife.evaluatedAt, new Date(nowMs).toISOString());
      assert.equal(halfLifeSession?.intensity, 0.25);
      assert.equal(halfLifeSession?.valence, -0.15);
      assert.equal(halfLifeSession?.arousal, 0.175);
      assert.equal(halfLifeSession?.dimensions.focus, 0.2);
      assert.equal(relationship?.intensity, 0.6);
      assert.equal(relationship?.valence, 0.3);

      nowMs = occurredAtMs + 2_000;
      const twoHalfLives = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(twoHalfLives.components.find((component) => component.family === "frustration")?.intensity, 0.125);

      const thresholdAgeMs = 1_000 * Math.log2(20);
      nowMs = Math.floor(occurredAtMs + thresholdAgeMs);
      const thresholdBefore = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(thresholdBefore.components.some((component) => component.family === "frustration"), true);
      nowMs = Math.ceil(occurredAtMs + thresholdAgeMs) + 1;
      const thresholdAfter = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(thresholdAfter.components.some((component) => component.family === "frustration"), false);
      assert.equal(thresholdAfter.components.find((component) => component.family === "affinity")?.intensity, 0.6);
      assert.notEqual(thresholdAfter.evaluatedAt, halfLife.evaluatedAt);
      assert.deepEqual(storage.getStateVersion({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      }), versionBefore);
      assert.equal(
        storage.inspect({ characterId: "character-a", userId: "local-user" }).events
          .find((stored) => stored.family === "frustration")?.intensity,
        0.5,
      );
      assert.equal(storage.getMetrics().projection.decayExcluded, 1);
      assert.equal(storage.getMetrics().projection.cacheHits, 0);
      assert.equal(storage.getMetrics().projection.cacheMisses, 4);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("legacy label identityを別legacy labelや新規other familyへ統合しない", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const legacyA = storage.recordEvent(event({
        value: { label: "legacy-a", valence: 0.2 },
        idempotencyKey: "legacy-a",
      })).event;
      const legacyB = storage.recordEvent(event({
        value: { label: "legacy-b", valence: 0.3 },
        idempotencyKey: "legacy-b",
      })).event;
      storage.recordEvent(event({
        family: "other",
        value: { label: "legacy-a", valence: 0.4 },
        idempotencyKey: "new-other",
      }));
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.prepare("UPDATE character_affect_events_v6 SET family = NULL WHERE id IN (?, ?)").run(legacyA.id, legacyB.id);
      } finally {
        db.close();
      }

      const state = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(state.components.filter((component) => component.targetId === "bug-1").length, 3);
      assert.equal(state.components.filter((component) => component.family === null).length, 2);
      assert.equal(state.components.filter((component) => component.family === "other").length, 1);
      assert.equal(storage.getMetrics().legacyEvents, 2);
      assert.equal(storage.getMetrics().eventsByFamily.other, 1);
      assert.equal(storage.getMetrics().otherRate, 1);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("legacy targetとlabelに区切り文字が含まれても異なるidentityを統合しない", () => {
    const fixture = createFixture();
    const storage = affectStorage(fixture.dbPath);
    try {
      const legacyA = storage.recordEvent(event({
        targetId: "a",
        value: { label: "b\u0000legacy-label:c", valence: 0.2 },
        idempotencyKey: "legacy-delimiter-a",
      })).event;
      const legacyB = storage.recordEvent(event({
        targetId: "a\u0000legacy-label:b",
        value: { label: "c", valence: 0.3 },
        idempotencyKey: "legacy-delimiter-b",
      })).event;
      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.prepare("UPDATE character_affect_events_v6 SET family = NULL WHERE id IN (?, ?)").run(legacyA.id, legacyB.id);
      } finally {
        db.close();
      }

      const state = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(state.components.length, 2);
      assert.deepEqual(
        state.components.map((component) => component.targetId).sort(),
        ["a", "a\u0000legacy-label:b"].sort(),
      );
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("correction/resetでactive setを確定してからsession decayを適用する", () => {
    const fixture = createFixture();
    const storage = new CharacterAffectStorage(fixture.dbPath, {
      now: () => new Date("2026-08-09T02:00:00.000Z"),
      sessionHalfLifeMs: 60 * 60 * 1_000,
    });
    try {
      const original = storage.recordEvent(event({ idempotencyKey: "decay-original" })).event;
      const replacement = storage.correctEvent({
        eventId: original.id,
        replacement: event({
          family: "determination",
          value: { label: "recovering", valence: 0.5 },
          intensity: 0.8,
          idempotencyKey: "decay-correction",
        }),
        reason: "The appraisal was corrected.",
      }).event;
      const corrected = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(corrected.components.some((component) => component.eventIds.includes(original.id)), false);
      assert.equal(corrected.components.find((component) => component.family === "determination")?.intensity, 0.4);
      assert.equal(corrected.components.some((component) => component.eventIds.includes(replacement.id)), true);

      storage.reset({
        characterId: "character-a",
        userId: "local-user",
        layer: "session",
        sessionId: "session-a",
        reason: "Reset corrected active state.",
        resetAt: "2026-08-09T01:00:00.001Z",
        idempotencyKey: "decay-reset",
      });
      const reset = storage.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      });
      assert.equal(reset.components.length, 0);
    } finally {
      storage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
