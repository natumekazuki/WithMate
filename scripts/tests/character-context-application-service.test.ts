import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AFFECT_SCHEMA_VERSION, type AffectEventInput } from "../../src/character-affect/affect-contract.js";
import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  isCharacterContextError,
} from "../../src/character-context/character-context-contract.js";
import {
  CharacterContextApplicationService,
  type CharacterContextUnexpectedErrorDiagnostic,
} from "../../src-electron/character-context-application-service.js";
import { CharacterAffectService } from "../../src-electron/character-affect-service.js";
import { createCharacterAffectServiceWithMemory } from "../../src-electron/character-affect-memory-adapter.js";
import { CharacterAffectStorage } from "../../src-electron/character-affect-storage.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { MemoryV6Service } from "../../src-electron/memory-v6-service.js";
import { MemoryV6Storage } from "../../src-electron/memory-v6-storage.js";

function createFixture(options: {
  failEpisodeWrite?: boolean;
  failMemorySearch?: boolean;
  failAffectState?: boolean;
  onUnexpectedError?(diagnostic: CharacterContextUnexpectedErrorDiagnostic): void;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "withmate-character-context-"));
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
  const memoryStorage = new MemoryV6Storage(dbPath);
  const affectStorage = new CharacterAffectStorage(dbPath);
  const memoryService = new MemoryV6Service({
    storage: memoryStorage,
    resolveCharacterById: (id) => id === "character-a" ? { id, name: "A" } : null,
  });
  if (options.failMemorySearch) {
    memoryService.search = async () => {
      throw new Error("injected Memory search failure");
    };
  }
  const affectService = options.failEpisodeWrite
    ? new CharacterAffectService(
        affectStorage,
        { async evaluate() { return []; } },
        {
          validateEpisode() {},
          async writeEpisode() {
            throw new Error("injected episode write failure");
          },
        },
      )
    : createCharacterAffectServiceWithMemory({
        affectStorage,
        memoryStorage,
        evaluator: { async evaluate() { return []; } },
      });
  if (options.failAffectState) {
    affectService.getEffectiveState = () => {
      throw new Error("C:/private/workspace secret-token must not be logged");
    };
  }
  const service = new CharacterContextApplicationService({
    memoryService,
    affectService,
    resolveCharacterRuntimeSnapshot: (characterId) => characterId === "character-a"
      ? {
          characterId,
          name: "A",
          description: "Test Character",
          iconFilePath: "",
          theme: { main: "#000000", sub: "#ffffff" },
          definitionMarkdown: "Cheerful Character.",
          definitionSha256: "definition-hash",
          definitionByteSize: 18,
          snapshotAt: "2026-08-09T00:00:00.000Z",
        }
      : null,
    onUnexpectedError: options.onUnexpectedError,
  });
  return {
    directory,
    dbPath,
    service,
    close() {
      affectStorage.close();
      memoryStorage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function affectCandidate(overrides: Partial<AffectEventInput> = {}): AffectEventInput {
  return {
    schemaVersion: AFFECT_SCHEMA_VERSION,
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "bug",
    targetId: "bug-1",
    value: { label: "interest", valence: 0.4, arousal: 0.3 },
    intensity: 0.6,
    reason: "The bug became tractable.",
    evidence: "A direct reproduction was found.",
    occurredAt: "2026-08-09T01:00:00.000Z",
    idempotencyKey: "affect-event-1",
    ...overrides,
  };
}

describe("CharacterContextApplicationService", () => {
  it("read-only Memory searchの予期しないfailureをeffect noneで返す", async () => {
    const fixture = createFixture({ failMemorySearch: true });
    try {
      const result = await fixture.service.searchMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        query: "failure",
        scope: { scope: "character" },
        limit: 3,
      });
      assert.equal(isCharacterContextError(result), true);
      if (isCharacterContextError(result)) {
        assert.equal(result.error.code, "storage_unavailable");
        assert.equal(result.error.effect, "none");
        assert.equal(result.error.retryable, true);
      }
    } finally {
      fixture.close();
    }
  });

  it("Context内のMemory検索failureを検索量付きのstage diagnosticへ写像する", async () => {
    const diagnostics: CharacterContextUnexpectedErrorDiagnostic[] = [];
    const fixture = createFixture({
      failMemorySearch: true,
      onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const result = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        query: "failure terms",
        memoryLimit: 3,
      }, "lifecycle");
      assert.equal(isCharacterContextError(result), true);
      if (!isCharacterContextError(result)) return;
      assert.equal(result.error.code, "storage_unavailable");
      assert.equal(result.error.details?.failureStage, "memory_search");
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.stage, "memory_search");
      assert.equal(diagnostics[0]?.errorName, "Error");
      assert.equal(diagnostics[0]?.queryLength, "failure terms".length);
      assert.ok((diagnostics[0]?.searchTermCount ?? 0) > 0);
    } finally {
      fixture.close();
    }
  });

  it("Context stage failureを内容なしの安全な診断へ分離する", async () => {
    const diagnostics: CharacterContextUnexpectedErrorDiagnostic[] = [];
    const fixture = createFixture({
      failAffectState: true,
      onUnexpectedError: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const result = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        query: "長い query terms",
        memoryLimit: 3,
      }, "lifecycle");
      assert.equal(isCharacterContextError(result), true);
      if (!isCharacterContextError(result)) return;
      assert.equal(result.error.code, "storage_unavailable");
      assert.equal(result.error.effect, "none");
      assert.equal(result.error.details?.failureStage, "affect_state");
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(
        {
          operation: diagnostics[0]?.operation,
          transport: diagnostics[0]?.transport,
          stage: diagnostics[0]?.stage,
          errorName: diagnostics[0]?.errorName,
        },
        {
          operation: "character_context.get",
          transport: "lifecycle",
          stage: "affect_state",
          errorName: "Error",
        },
      );
      assert.doesNotMatch(JSON.stringify(diagnostics), /private|workspace|secret-token/);
      assert.match(diagnostics[0]?.safeMessage ?? "", /affect_state failed/);
      assert.ok((diagnostics[0]?.durationMs ?? -1) >= 0);
    } finally {
      fixture.close();
    }
  });

  it("context、appraise、Memory episodeを同じ正本からversion付きでread-backする", async () => {
    const fixture = createFixture();
    try {
      const initial = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        query: "bug",
        memoryLimit: 3,
      });
      assert.equal(isCharacterContextError(initial), false);
      if (isCharacterContextError(initial)) return;

      const appraisal = await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        expectedVersion: initial.affect.version,
        authority: { kind: "conversation" },
        candidates: [affectCandidate({
          memoryEpisode: {
            title: "Bug reproduction",
            body: "We found a direct reproduction for the bug.",
            preview: "A direct bug reproduction was found.",
            motif: "bug-breakthrough",
            salience: 0.8,
          },
        })],
      });
      assert.equal(isCharacterContextError(appraisal), false);
      if (isCharacterContextError(appraisal)) return;
      assert.equal(appraisal.saved.length, 1);
      assert.notEqual(appraisal.version, initial.affect.version);

      const context = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        query: "bug reproduction",
        memoryLimit: 3,
      });
      assert.equal(isCharacterContextError(context), false);
      if (isCharacterContextError(context)) return;
      assert.equal(context.affect.version, appraisal.version);
      assert.equal(context.affect.effective[0]?.targetId, "bug-1");
      assert.equal(context.memory.items.length, 1);
      assert.equal(context.memory.items[0]?.title, "Bug reproduction");
      assert.equal("body" in (context.memory.items[0] ?? {}), false);
      assert.equal("events" in context, false);
    } finally {
      fixture.close();
    }
  });

  it("同じidempotency keyのretryだけを再生し、同motifの別eventを保存する", async () => {
    const fixture = createFixture();
    try {
      const request = {
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" as const },
        candidates: [affectCandidate()],
      };
      const first = await fixture.service.appraise(request);
      const replay = await fixture.service.appraise(request);
      assert.equal(isCharacterContextError(first), false);
      assert.equal(isCharacterContextError(replay), false);
      if (isCharacterContextError(first) || isCharacterContextError(replay)) return;
      assert.equal(replay.saved[0]?.eventId, first.saved[0]?.eventId);
      assert.equal(replay.saved[0]?.replayed, true);

      const second = await fixture.service.appraise({
        ...request,
        candidates: [affectCandidate({
          occurredAt: "2026-08-09T02:00:00.000Z",
          idempotencyKey: "affect-event-2",
        })],
      });
      assert.equal(isCharacterContextError(second), false);
      if (isCharacterContextError(second)) return;
      assert.notEqual(second.saved[0]?.eventId, first.saved[0]?.eventId);
    } finally {
      fixture.close();
    }
  });

  it("relationshipとsessionの同型componentをeffectiveへ合成する", async () => {
    const fixture = createFixture();
    try {
      await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" },
        candidates: [
          affectCandidate({
            layer: "relationship",
            targetType: "relationship",
            targetId: "relationship-a",
            value: { label: "trust", valence: 0.4 },
            intensity: 0.5,
            idempotencyKey: "aggregate-relationship",
          }),
          affectCandidate({
            layer: "session",
            targetType: "relationship",
            targetId: "relationship-a",
            value: { label: "trust", valence: 0.2 },
            intensity: 0.5,
            idempotencyKey: "aggregate-session",
          }),
        ],
      });
      const result = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
      });
      assert.equal(isCharacterContextError(result), false);
      if (isCharacterContextError(result)) return;
      const trust = result.affect.effective.filter((component) => component.label === "trust");
      assert.equal(trust.length, 1);
      assert.deepEqual(trust[0]?.contributingLayers, ["relationship", "session"]);
      assert.ok(Math.abs((trust[0]?.valence ?? 0) - 0.3) < Number.EPSILON);
      assert.equal(trust[0]?.intensity, 1);
    } finally {
      fixture.close();
    }
  });

  it("stale version、relationship scopeの不正target、別scopeを拒否する", async () => {
    const fixture = createFixture();
    try {
      const stale = await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        expectedVersion: "affect-v1-stale",
        authority: { kind: "conversation" },
        candidates: [affectCandidate()],
      });
      assert.equal(isCharacterContextError(stale), true);
      if (isCharacterContextError(stale)) {
        assert.equal(stale.error.code, "version_conflict");
        assert.equal(stale.error.effect, "none");
      }

      const relationship = await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" },
        candidates: [affectCandidate({
          layer: "relationship",
          targetType: "bug",
          targetId: "bug-123",
          idempotencyKey: "relationship-denied",
        })],
      });
      assert.equal(isCharacterContextError(relationship), false);
      if (!isCharacterContextError(relationship)) {
        assert.equal(relationship.saved.length, 0);
        assert.equal(relationship.rejected[0]?.code, "invalid_input");
      }

      const unknown = await fixture.service.getContext({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "other-session",
      });
      assert.equal(isCharacterContextError(unknown), true);
      if (isCharacterContextError(unknown)) {
        assert.equal(unknown.error.code, "unknown_scope");
      }
    } finally {
      fixture.close();
    }
  });

  it("episodeの訂正とforgetをexplicit authority、idempotency、read-back付きで行う", async () => {
    const fixture = createFixture();
    try {
      const appended = await fixture.service.appendEpisode({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" },
        idempotencyKey: "episode-1",
        episode: {
          title: "First episode",
          body: "The user stated the first episode happened.",
          preview: "First shared episode.",
          motif: "shared-step",
          observedFact: "The user stated that it happened.",
        },
      });
      assert.equal(isCharacterContextError(appended), false);
      if (isCharacterContextError(appended) || !appended.entry) return;

      const denied = await fixture.service.correctMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        entryId: appended.entry.id,
        authority: { kind: "conversation" },
        reason: "Correction requested.",
        idempotencyKey: "episode-correct",
        replacement: {
          title: "Corrected episode",
          body: "The corrected shared episode.",
          preview: "Corrected episode.",
          observedFact: "The user corrected the event.",
        },
      });
      assert.equal(isCharacterContextError(denied), true);
      if (isCharacterContextError(denied)) assert.equal(denied.error.code, "authority_denied");

      const corrected = await fixture.service.correctMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        entryId: appended.entry.id,
        authority: { kind: "explicit_user_instruction", reason: "The user requested correction." },
        reason: "Correction requested.",
        idempotencyKey: "episode-correct",
        replacement: {
          title: "Corrected episode",
          body: "The corrected shared episode.",
          preview: "Corrected episode.",
          observedFact: "The user corrected the event.",
        },
      });
      assert.equal(isCharacterContextError(corrected), false);
      if (isCharacterContextError(corrected) || !corrected.entry) return;
      assert.equal(corrected.previousEntryId, appended.entry.id);
      assert.equal(corrected.readBack, "active");

      const conflictingReason = await fixture.service.correctMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        entryId: appended.entry.id,
        authority: { kind: "explicit_user_instruction", reason: "The user changed the correction reason." },
        reason: "A different correction reason.",
        idempotencyKey: "episode-correct",
        replacement: {
          title: "Corrected episode",
          body: "The corrected shared episode.",
          preview: "Corrected episode.",
          observedFact: "The user corrected the event.",
        },
      });
      assert.equal(isCharacterContextError(conflictingReason), true);
      if (isCharacterContextError(conflictingReason)) {
        assert.equal(conflictingReason.error.code, "invalid_input");
      }

      const forgotten = await fixture.service.forgetMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        entryId: corrected.entry.id,
        authority: { kind: "explicit_user_instruction", reason: "The user requested forget." },
        reason: "incorrect",
        idempotencyKey: "episode-forget",
      });
      assert.equal(isCharacterContextError(forgotten), false);
      if (!isCharacterContextError(forgotten)) assert.equal(forgotten.readBack, "forgotten");

      const conflictingForgetReason = await fixture.service.forgetMemory({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        entryId: corrected.entry.id,
        authority: { kind: "explicit_user_instruction", reason: "The user changed the forget reason." },
        reason: "privacy",
        idempotencyKey: "episode-forget",
      });
      assert.equal(isCharacterContextError(conflictingForgetReason), true);
      if (isCharacterContextError(conflictingForgetReason)) {
        assert.equal(conflictingForgetReason.error.code, "invalid_input");
      }

      const auditDb = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const correctionAudit = auditDb.prepare(`
          SELECT reason FROM memory_mutation_events_v6
          WHERE operation = 'append' AND entry_id = ?
        `).get(corrected.entry.id) as { reason: string };
        const forgetAudit = auditDb.prepare(`
          SELECT reason FROM memory_mutation_events_v6
          WHERE operation = 'forget' AND entry_id = ?
        `).get(corrected.entry.id) as { reason: string };
        assert.equal(correctionAudit.reason, "Correction requested.");
        assert.equal(forgetAudit.reason, "incorrect");
      } finally {
        auditDb.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("transport別結果、拒否理由、replay、fallbackを内容なしで集計する", async () => {
    const fixture = createFixture();
    try {
      await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" },
        candidates: [affectCandidate({
          layer: "relationship",
          targetType: "bug",
          targetId: "bug-123",
          idempotencyKey: "invalid-relationship-target",
        })],
      }, "mcp");
      fixture.service.recordFallback("mcp", "cli");

      const metrics = fixture.service.getMetrics();
      assert.equal(metrics.operations["mcp:character_affect.appraise"]?.calls, 1);
      assert.equal(metrics.operations["mcp:character_affect.appraise"]?.rejectionsByCode.invalid_input, 1);
      assert.equal(metrics.fallbacks["mcp->cli"], 1);
      assert.doesNotMatch(JSON.stringify(metrics), /bug-123|invalid-relationship-target/);
    } finally {
      fixture.close();
    }
  });

  it("Affect保存後のepisode失敗をpartial failureとして返し、成功に見せない", async () => {
    const fixture = createFixture({ failEpisodeWrite: true });
    try {
      const result = await fixture.service.appraise({
        schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
        characterId: "character-a",
        sessionId: "session-a",
        authority: { kind: "conversation" },
        candidates: [affectCandidate({
          idempotencyKey: "partial-episode",
          memoryEpisode: {
            title: "Partial episode",
            body: "Episode body",
            preview: "Episode preview",
            salience: 0.8,
          },
        })],
      });

      assert.equal(isCharacterContextError(result), true);
      if (!isCharacterContextError(result)) return;
      assert.equal(result.error.code, "partial_failure");
      assert.equal(result.error.effect, "committed");
      assert.equal(result.error.retryable, true);
      assert.equal(typeof result.error.details?.eventId, "string");
    } finally {
      fixture.close();
    }
  });
});
