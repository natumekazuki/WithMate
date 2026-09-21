import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  AFFECT_SCHEMA_VERSION,
  type AffectEventInput,
  type AffectEvaluator,
} from "../../src-shared/character-affect/affect-contract.js";
import {
  MemoryV6CharacterAffectEpisodeWriter,
  createCharacterAffectServiceWithMemory,
} from "../../src-electron/character-affect-memory-adapter.js";
import {
  CharacterAffectService,
  type CharacterAffectEpisodeWriter,
} from "../../src-electron/character-affect-service.js";
import { CharacterAffectStorage } from "../../src-electron/character-affect-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import type { MemoryV6ResolvedTarget } from "../../src-electron/memory-v6-schema.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

const TARGET: MemoryV6ResolvedTarget = {
  owner: { type: "character", id: "character-a" },
  scope: { type: "character", id: "character-a" },
};

function createFixture(): { directory: string; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "withmate-affect-service-"));
  const dbPath = join(directory, "withmate-v6.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    ensureV6Schema(db);
    db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES ('character-a', 'A', ?, ?)")
      .run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        character_id, character_snapshot_json, created_at, updated_at, last_active_at
      ) VALUES ('session-a', 'A', 'active', 'codex', 1, 'gpt-5', 'on-request', 'character-a', '{}', ?, ?, ?)
    `).run("2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z");
  } finally {
    db.close();
  }
  return { directory, dbPath };
}

function episodeEvent(overrides: Partial<AffectEventInput> = {}): AffectEventInput {
  return {
    schemaVersion: AFFECT_SCHEMA_VERSION,
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "task",
    targetId: "release",
    family: "joy",
    value: { label: "joy", valence: 0.8 },
    intensity: 0.7,
    reason: "A release milestone passed.",
    evidence: "The release passed.",
    occurredAt: "2026-08-09T01:00:00.000Z",
    idempotencyKey: "event-day-1",
    memoryEpisode: {
      title: "Release milestone",
      body: "We celebrated another release milestone.",
      preview: "Release milestone celebration.",
      motif: "release-celebration",
      salience: 0.8,
    },
    ...overrides,
  };
}

function evaluatorFor(getEvent: () => AffectEventInput): AffectEvaluator {
  return {
    async evaluate(): Promise<readonly AffectEventInput[]> {
      return [getEvent()];
    },
  };
}

function serviceInput(summary = "The release passed.") {
  return {
    characterId: "character-a",
    userId: "local-user",
    characterDefinition: "Cheerful knight.",
    baseline: [],
    event: {
      sessionId: "session-a",
      summary,
      occurredAt: "2026-08-09T01:00:00.000Z",
    },
  } as const;
}

class FailOnceLinkStorage extends CharacterAffectStorage {
  private shouldFail = true;

  override linkMemoryEpisode(eventId: string, memoryEntryId: string): void {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("Injected failure after Memory append.");
    }
    super.linkMemoryEpisode(eventId, memoryEntryId);
  }
}

class FailSecondLinkStorage extends CharacterAffectStorage {
  private linkCount = 0;

  override linkMemoryEpisode(eventId: string, memoryEntryId: string): void {
    this.linkCount += 1;
    if (this.linkCount === 2) {
      throw new Error("Injected failure after correction Memory append.");
    }
    super.linkMemoryEpisode(eventId, memoryEntryId);
  }
}

class FailOnceCorrectionEpisodeWriter implements CharacterAffectEpisodeWriter {
  private shouldFail = true;

  constructor(private readonly delegate: CharacterAffectEpisodeWriter) {}

  validateEpisode(input: Parameters<CharacterAffectEpisodeWriter["validateEpisode"]>[0]): void {
    this.delegate.validateEpisode(input);
  }

  async writeEpisode(
    input: Parameters<CharacterAffectEpisodeWriter["writeEpisode"]>[0],
  ): Promise<{ memoryEntryId: string }> {
    if (input.supersedesMemoryEntryId && this.shouldFail) {
      this.shouldFail = false;
      throw new Error("Injected failure before correction Memory append.");
    }
    return this.delegate.writeEpisode(input);
  }
}

describe("CharacterAffectService Memory episode lifecycle", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Memory episodeの別event、retry、訂正supersedeをidempotentに処理する"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "retryでMemoryを重複作成するかpredecessorを失う"
  // observable = "episode state, links, and service metrics"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-service-memory-episode"
  // lifecycle = "permanent"
  // impact = "AffectとMemoryのcross-store retry continuity"
  // distinction = "実DBのservice lifecycleを検証する"
  // @end-test-value
  it("実Memoryへ同motifの別episodeを保存し、retryと訂正をidempotentにsupersedeする", async () => {
    const fixture = createFixture();
    const affectStorage = new CharacterAffectStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    let current = episodeEvent();
    const service = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage,
      evaluator: evaluatorFor(() => current),
    });
    try {
      const first = await service.evaluateAndRecord(serviceInput());
      const replay = await service.evaluateAndRecord(serviceInput());
      assert.equal(replay.events[0]?.id, first.events[0]?.id);

      current = episodeEvent({
        occurredAt: "2026-08-10T01:00:00.000Z",
        idempotencyKey: "event-day-2",
        evidence: "Another release passed.",
      });
      await service.evaluateAndRecord({
        ...serviceInput("Another release passed."),
        event: { ...serviceInput().event, occurredAt: "2026-08-10T01:00:00.000Z" },
      });

      const beforeCorrection = memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items;
      assert.equal(beforeCorrection.length, 2);
      assert.notEqual(beforeCorrection[0]?.id, beforeCorrection[1]?.id);
      assert.ok(beforeCorrection.every((entry) => entry.tags.some(
        (tag) => tag.type === "motif" && tag.value === "release-celebration",
      )));
      assert.ok(beforeCorrection.every((entry) => entry.source.sessionId === "session-a"));
      assert.ok(beforeCorrection.every(
        (entry) => entry.owner.type === "character"
          && entry.owner.id === "character-a"
          && entry.scope.type === "character"
          && entry.scope.id === "character-a",
      ));

      const originalMemoryId = first.events[0]?.memoryEntryId;
      assert.ok(originalMemoryId);
      const correction = {
        eventId: first.events[0]!.id,
        replacement: episodeEvent({
          value: { label: "pride", valence: 0.9 },
          intensity: 0.9,
          reason: "The milestone mattered more than first recorded.",
          evidence: "The user confirmed the release impact.",
          occurredAt: "2026-08-09T01:05:00.000Z",
          idempotencyKey: "event-day-1-correction",
          memoryEpisode: {
            title: "Release milestone correction",
            body: "We corrected how important the release milestone felt.",
            preview: "Corrected release milestone episode.",
            motif: "release-celebration",
            salience: 0.9,
          },
        }),
        reason: "Corrected the episode salience.",
      };
      const corrected = await service.correctEvent(correction);
      const correctionReplay = await service.correctEvent(correction);
      assert.equal(correctionReplay.event.id, corrected.event.id);
      assert.equal(correctionReplay.event.memoryEntryId, corrected.event.memoryEntryId);

      const oldMemory = memoryStorage.getEntry(originalMemoryId);
      const newMemory = memoryStorage.getEntry(corrected.event.memoryEntryId!);
      assert.equal(oldMemory?.state, "superseded");
      assert.equal(oldMemory?.supersededBy, newMemory?.id);
      assert.equal(newMemory?.state, "active");
      assert.deepEqual(newMemory?.supersedes, [originalMemoryId]);
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 3);
      assert.equal((await service.getMetrics()).linkedEpisodes, 3);
      assert.equal((await service.getMetrics()).episodeCandidates, 3);
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Memory成功後のAffect link失敗をretryで重複なく収束する"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "partial failureを再実行してMemoryやauditを重複する"
  // observable = "retry result and inspection mutations"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-service-memory-episode"
  // lifecycle = "permanent"
  // impact = "partial failure retry safety"
  // distinction = "link fault injection付きservice実動作"
  // @end-test-value
  it("Memory成功後・Affect link前の失敗を同一request retryで重複なく収束する", async () => {
    const fixture = createFixture();
    const affectStorage = new FailOnceLinkStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const service = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage,
      evaluator: evaluatorFor(() => episodeEvent()),
    });
    try {
      await assert.rejects(
        () => service.evaluateAndRecord(serviceInput()),
        /Injected failure after Memory append/,
      );
      const afterFailure = await service.inspect({ characterId: "character-a", userId: "local-user" });
      assert.equal(afterFailure.events.length, 1);
      assert.equal(afterFailure.events[0]?.memoryEntryId, null);
      assert.equal(memoryStorage.listEntries({ target: TARGET, states: ["active"], limit: 50 }).items.length, 1);

      const retry = await service.evaluateAndRecord(serviceInput());
      assert.ok(retry.events[0]?.memoryEntryId);
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 1);
      const inspection = await service.inspect({ characterId: "character-a", userId: "local-user" });
      assert.equal(inspection.mutations.filter((item) => item.operation === "episode_candidate").length, 1);
      assert.equal(inspection.mutations.filter((item) => item.operation === "link_episode").length, 1);
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Affect訂正後のMemory commit失敗でもpredecessorを保持してretry収束する"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "訂正途中でpredecessorまたはsupersedes関係を失う"
  // observable = "partial inspection and replayed Memory state"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-service-memory-episode"
  // lifecycle = "permanent"
  // impact = "correction retry continuity"
  // distinction = "Memory commit fault injection付きservice実動作"
  // @end-test-value
  it("Affect訂正成功後・Memory commit前の失敗でもpredecessorを保持してretry収束する", async () => {
    const fixture = createFixture();
    const affectStorage = new CharacterAffectStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const writer = new FailOnceCorrectionEpisodeWriter(
      new MemoryV6CharacterAffectEpisodeWriter(memoryStorage),
    );
    const service = new CharacterAffectService(
      affectStorage,
      evaluatorFor(() => episodeEvent()),
      writer,
    );
    try {
      const original = (await service.evaluateAndRecord(serviceInput())).events[0]!;
      const correction = {
        eventId: original.id,
        replacement: episodeEvent({
          idempotencyKey: "correction-memory-precommit-failure",
          occurredAt: "2026-08-09T01:05:00.000Z",
          memoryEpisode: {
            title: "Corrected release episode",
            body: "The correction must supersede the original after retry.",
            preview: "Correction retry episode.",
            motif: "release-celebration",
            salience: 0.9,
          },
        }),
        reason: "Corrected after a transient Memory failure.",
      };
      await assert.rejects(
        () => service.correctEvent(correction),
        /Injected failure before correction Memory append/,
      );
      const partial = await service.inspect({ characterId: "character-a", userId: "local-user" });
      const unlinkedReplacement = partial.events.find((item) => item.correctionOfEventId === original.id);
      assert.equal(unlinkedReplacement?.memoryEntryId, null);
      assert.equal(unlinkedReplacement?.supersedesMemoryEntryId, original.memoryEntryId);

      const replay = await service.correctEvent(correction);
      assert.equal(replay.created, false);
      assert.ok(replay.event.memoryEntryId);
      assert.equal(memoryStorage.getEntry(original.memoryEntryId!)?.state, "superseded");
      assert.deepEqual(memoryStorage.getEntry(replay.event.memoryEntryId!)?.supersedes, [original.memoryEntryId]);
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 2);
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("訂正Memory成功後・Affect link前の失敗をidempotent replayで収束する", async () => {
    const fixture = createFixture();
    const affectStorage = new FailSecondLinkStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const service = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage,
      evaluator: evaluatorFor(() => episodeEvent()),
    });
    try {
      const original = (await service.evaluateAndRecord(serviceInput())).events[0]!;
      const correction = {
        eventId: original.id,
        replacement: episodeEvent({
          idempotencyKey: "correction-link-failure",
          occurredAt: "2026-08-09T01:05:00.000Z",
          memoryEpisode: {
            title: "Correction after link failure",
            body: "The same Memory append must replay before Affect relinks.",
            preview: "Correction link retry.",
            motif: "release-celebration",
            salience: 0.9,
          },
        }),
        reason: "Corrected with an injected link failure.",
      };
      await assert.rejects(
        () => service.correctEvent(correction),
        /Injected failure after correction Memory append/,
      );
      assert.equal(memoryStorage.getEntry(original.memoryEntryId!)?.state, "superseded");
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 2);

      const replay = await service.correctEvent(correction);
      assert.equal(replay.created, false);
      assert.ok(replay.event.memoryEntryId);
      assert.deepEqual(memoryStorage.getEntry(replay.event.memoryEntryId!)?.supersedes, [original.memoryEntryId]);
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 2);
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "session resetとMemory forget後もrelationship affectのlinkと監査を保持する"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "session操作がrelationship stateやlink auditを削除する"
  // observable = "effective state, forgotten Memory, and correction result"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-service-memory-episode"
  // lifecycle = "permanent"
  // impact = "relationship continuity across session lifecycle"
  // distinction = "reset/forget後の実DB read-back"
  // @end-test-value
  it("session resetとMemory forget後もrelationship affectのlink、監査、現在状態を保持する", async () => {
    const fixture = createFixture();
    const affectStorage = new CharacterAffectStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const relationshipEvent = episodeEvent({
      layer: "relationship",
      targetType: "relationship",
      targetId: "local-user:character-a",
      value: { label: "trust", valence: 0.7 },
      idempotencyKey: "relationship-episode",
    });
    const service = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage,
      evaluator: evaluatorFor(() => relationshipEvent),
    });
    try {
      const recorded = await service.evaluateAndRecord(serviceInput());
      const memoryEntryId = recorded.events[0]?.memoryEntryId;
      assert.ok(memoryEntryId);

      await service.reset({
        characterId: "character-a",
        userId: "local-user",
        layer: "session",
        sessionId: "session-a",
        reason: "Reset session mood only.",
        resetAt: "2026-08-09T02:00:00.000Z",
        idempotencyKey: "reset-session-a",
      });
      assert.equal(memoryStorage.getEntry(memoryEntryId)?.state, "active");
      assert.ok((await service.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      })).components.some((item) => item.label === "trust"));

      const forget = memoryStorage.forgetEntries({
        target: TARGET,
        entryIds: [memoryEntryId],
        reason: "user_request",
        idempotencyKey: "forget-affect-episode",
        bindingIdHash: "local-user",
        sessionId: "session-a",
      });
      assert.deepEqual(forget, [{ entryId: memoryEntryId, status: "forgotten" }]);
      assert.equal(memoryStorage.getEntry(memoryEntryId)?.state, "forgotten");

      await assert.rejects(
        () => service.correctEvent({
          eventId: recorded.events[0]!.id,
          replacement: episodeEvent({
            layer: "relationship",
            targetType: "relationship",
            targetId: "local-user:character-a",
            idempotencyKey: "forgotten-episode-correction",
            occurredAt: "2026-08-09T02:05:00.000Z",
          }),
          reason: "Attempted correction after forget.",
        }),
        /to supersede must be active/,
      );
      const afterRejectedCorrection = await service.inspect({ characterId: "character-a", userId: "local-user" });
      assert.equal(afterRejectedCorrection.events.length, 1);
      assert.equal(afterRejectedCorrection.events[0]?.state, "active");
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 1);

      const inspection = await service.inspect({ characterId: "character-a", userId: "local-user" });
      assert.equal(inspection.events[0]?.memoryEntryId, memoryEntryId);
      assert.ok(inspection.mutations.some((item) => item.operation === "link_episode"));
      assert.ok(inspection.mutations.some((item) => item.operation === "reset"));
      assert.ok((await service.getEffectiveState({
        characterId: "character-a",
        userId: "local-user",
        sessionId: "session-a",
      })).components.some((item) => item.label === "trust"));
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("source session削除後もMemory付きrelationship訂正のretryを再生する", async () => {
    const fixture = createFixture();
    const affectStorage = new CharacterAffectStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const service = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage,
      evaluator: evaluatorFor(() => episodeEvent()),
    });
    try {
      const original = (await service.evaluateAndRecord(serviceInput())).events[0]!;
      const correction = {
        eventId: original.id,
        replacement: episodeEvent({
          layer: "relationship" as const,
          targetType: "relationship" as const,
          targetId: "local-user:character-a",
          idempotencyKey: "durable-memory-correction",
          occurredAt: "2026-08-09T01:05:00.000Z",
          memoryEpisode: {
            title: "Durable relationship episode",
            body: "The corrected affect belongs to the relationship.",
            preview: "Relationship correction.",
            motif: "release-celebration",
            salience: 0.8,
          },
        }),
        reason: "Corrected to relationship scope.",
      };
      const corrected = await service.correctEvent(correction);

      const db = new DatabaseSync(fixture.dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        db.prepare("DELETE FROM sessions_v6 WHERE id = 'session-a'").run();
      } finally {
        db.close();
      }

      const replay = await service.correctEvent(correction);
      assert.equal(replay.created, false);
      assert.equal(replay.event.id, corrected.event.id);
      assert.equal(replay.event.memoryEntryId, corrected.event.memoryEntryId);
      assert.equal(memoryStorage.listEntries({
        target: TARGET,
        states: ["active", "superseded", "forgotten"],
        limit: 50,
      }).items.length, 2);
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Memory episodeのwriter未設定、owner不一致、body長超過、episodeなし訂正を明示的に拒否する"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "writer、owner、body、episode validation違反を成功扱いしeventを破損する"
  // observable = "writer/owner/body/episode rejection errors and unchanged inspection"
  // observation_boundary = "public-boundary"
  // scope = "character-affect-service-memory-episode"
  // lifecycle = "permanent"
  // impact = "domain validation and data integrity"
  // distinction = "service境界のowner/body/episode validationを実動作で確認する"
  // @end-test-value
  it("episode writer未設定とMemoryを持つeventのepisodeなし訂正を明示的に拒否する", async () => {
    const fixture = createFixture();
    const affectStorage = new CharacterAffectStorage(fixture.dbPath);
    const memoryStorage = new MemoryV6Storage(fixture.dbPath);
    const evaluator = evaluatorFor(() => episodeEvent());
    try {
      assert.throws(
        () => new CharacterAffectService(affectStorage, evaluator, undefined as never),
        /Memory episode writer is required/,
      );
      const writer = new MemoryV6CharacterAffectEpisodeWriter(memoryStorage);
      await assert.rejects(
        () => writer.writeEpisode({
          characterId: "character-a",
          userId: "other-user",
          sourceSessionId: "session-a",
          sourceEventId: "event-other-user",
          idempotencyKey: "event-other-user:memory-episode",
          candidate: episodeEvent().memoryEpisode!,
        }),
        /owner must be local-user/,
      );

      const invalidService = createCharacterAffectServiceWithMemory({
        affectStorage,
        memoryStorage,
        evaluator: evaluatorFor(() => episodeEvent({
          memoryEpisode: {
            ...episodeEvent().memoryEpisode!,
            body: "x".repeat(8_001),
          },
        })),
      });
      await assert.rejects(
        () => invalidService.evaluateAndRecord(serviceInput()),
        /Memory episode is invalid/,
      );
      assert.equal((await invalidService.inspect({
        characterId: "character-a",
        userId: "local-user",
      })).events.length, 0);

      const service = createCharacterAffectServiceWithMemory({ affectStorage, memoryStorage, evaluator });
      const noMemoryService = createCharacterAffectServiceWithMemory({
        affectStorage,
        memoryStorage,
        evaluator: evaluatorFor(() => episodeEvent({
          userId: "other-user",
          memoryEpisode: undefined,
          idempotencyKey: "other-user-without-memory",
        })),
      });
      await assert.rejects(
        () => noMemoryService.evaluateAndRecord({ ...serviceInput(), userId: "other-user" }),
        /owner must be local-user/,
      );
      const recorded = await service.evaluateAndRecord(serviceInput());
      await assert.rejects(
        () => service.correctEvent({
          eventId: recorded.events[0]!.id,
          replacement: episodeEvent({
            idempotencyKey: "correction-without-episode",
            occurredAt: "2026-08-09T01:05:00.000Z",
            memoryEpisode: undefined,
          }),
          reason: "Correction omitted an episode.",
        }),
        /must provide a replacement Memory episode/,
      );
      assert.equal((await service.inspect({
        characterId: "character-a",
        userId: "local-user",
      })).events[0]?.state, "active");
    } finally {
      affectStorage.close();
      memoryStorage.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
