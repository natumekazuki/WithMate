import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  AFFECT_SCHEMA_VERSION,
  assertCanonicalUtcTimestamp,
  assertValidAffectBaseline,
  assertValidAffectEvent,
  type AffectBaselineComponent,
  type AffectEventInput,
  type AffectLayer,
  type AffectTargetType,
  type AffectValue,
  type EffectiveAffectComponent,
  type EffectiveAffectState,
} from "../src/character-affect/affect-contract.js";
import { openAppDatabase } from "./sqlite-connection.js";

const LOCAL_USER_ID = "local-user";

export class CharacterAffectIdempotencyConflictError extends Error {
  constructor() {
    super("Character affect idempotency key was reused with a different request.");
    this.name = "CharacterAffectIdempotencyConflictError";
  }
}

export class CharacterAffectVersionConflictError extends Error {
  constructor(
    readonly expectedVersion: string,
    readonly actualVersion: string,
  ) {
    super("Character affect version does not match the current state.");
    this.name = "CharacterAffectVersionConflictError";
  }
}

export type CharacterAffectStateVersion = {
  version: string;
  updatedAt: string | null;
};

export type StoredAffectEvent = Omit<AffectEventInput, "sessionId"> & {
  id: string;
  sessionId: string | null;
  sourceSessionId: string | null;
  state: "active" | "corrected";
  correctionOfEventId: string | null;
  memoryEntryId: string | null;
  supersedesMemoryEntryId: string | null;
  createdAt: string;
};

export type AffectResetInput = {
  characterId: string;
  userId: string;
  layer: AffectLayer;
  sessionId?: string;
  reason: string;
  resetAt: string;
  idempotencyKey: string;
};

export type AffectMutationRecord = {
  id: string;
  operation: "record" | "reject" | "correct" | "reset" | "episode_candidate" | "link_episode";
  characterId: string;
  userId: string;
  sessionId: string | null;
  sourceSessionId: string | null;
  eventId: string | null;
  resetId: string | null;
  reason: string;
  createdAt: string;
};

export type AffectResetRecord = Omit<AffectResetInput, "sessionId"> & {
  id: string;
  sessionId: string | null;
  createdAt: string;
};

type AffectIdempotencyRow = {
  operation: "record" | "correct" | "reset";
  request_fingerprint: string;
  event_id: string | null;
  reset_id: string | null;
};

type AffectEventRow = {
  id: string;
  character_id: string;
  user_id: string;
  session_id: string | null;
  source_session_id: string | null;
  layer: AffectLayer;
  target_type: AffectTargetType;
  target_id: string;
  value_json: string;
  intensity: number;
  reason: string;
  evidence: string;
  occurred_at: string;
  idempotency_key: string;
  request_fingerprint: string;
  correction_of_event_id: string | null;
  state: "active" | "corrected";
  memory_entry_id: string | null;
  supersedes_memory_entry_id: string | null;
  created_at: string;
};

export class CharacterAffectStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  recordEvent(
    input: AffectEventInput,
    options: { expectedVersion?: string } = {},
  ): { event: StoredAffectEvent; created: boolean } {
    assertValidAffectEvent(input);
    assertLocalUser(input.userId);
    const requestFingerprint = fingerprint({ operation: "record", input });

    const outcome = this.transaction(() => {
      const replay = this.findIdempotency(input.characterId, input.userId, input.idempotencyKey);
      if (replay) {
        if (replay.operation !== "record" || replay.request_fingerprint !== requestFingerprint || !replay.event_id) {
          this.insertObservation("idempotency", "rejected", input, replay.event_id, replay.reset_id, "Conflicting affect request.");
          return { conflict: true } as const;
        }
        this.insertObservation("idempotency", "replayed", input, replay.event_id, null, "Identical affect event replayed.");
        return { conflict: false, result: { event: toStoredEvent(this.requireEvent(replay.event_id)), created: false } } as const;
      }

      this.assertSessionOwner(input.sessionId, input.characterId);
      if (options.expectedVersion) {
        const actualVersion = this.getStateVersion({
          characterId: input.characterId,
          userId: input.userId,
          sessionId: input.sessionId,
        }).version;
        if (actualVersion !== options.expectedVersion) {
          throw new CharacterAffectVersionConflictError(options.expectedVersion, actualVersion);
        }
      }
      const eventId = randomUUID();
      const createdAt = new Date().toISOString();
      this.insertEvent(eventId, input, requestFingerprint, null, null, createdAt);
      this.insertIdempotency(input, "record", requestFingerprint, eventId, null, createdAt);
      this.insertMutation(
        "record",
        input.characterId,
        input.userId,
        input.layer === "session" ? input.sessionId : null,
        input.sessionId,
        eventId,
        null,
        input.reason,
        createdAt,
      );
      return { conflict: false, result: { event: toStoredEvent(this.requireEvent(eventId)), created: true } } as const;
    });
    if (outcome.conflict) {
      throw new CharacterAffectIdempotencyConflictError();
    }
    return outcome.result;
  }

  correctEvent(input: {
    eventId: string;
    replacement: AffectEventInput;
    reason: string;
  }, options: { expectedVersion?: string } = {}): { event: StoredAffectEvent; created: boolean } {
    assertValidAffectEvent(input.replacement);
    assertLocalUser(input.replacement.userId);
    requireText(input.reason, "reason");
    const requestFingerprint = fingerprint({
      operation: "correct",
      eventId: input.eventId,
      replacement: input.replacement,
      reason: input.reason,
    });

    const outcome = this.transaction(() => {
      const replay = this.findIdempotency(
        input.replacement.characterId,
        input.replacement.userId,
        input.replacement.idempotencyKey,
      );
      if (replay) {
        if (replay.operation !== "correct" || replay.request_fingerprint !== requestFingerprint || !replay.event_id) {
          this.insertObservation("idempotency", "rejected", input.replacement, replay.event_id, replay.reset_id, "Conflicting affect correction.");
          return { conflict: true } as const;
        }
        this.insertObservation("idempotency", "replayed", input.replacement, replay.event_id, null, "Identical affect correction replayed.");
        return { conflict: false, result: { event: toStoredEvent(this.requireEvent(replay.event_id)), created: false } } as const;
      }
      this.assertSessionOwner(input.replacement.sessionId, input.replacement.characterId);
      if (options.expectedVersion) {
        const actualVersion = this.getStateVersion({
          characterId: input.replacement.characterId,
          userId: input.replacement.userId,
          sessionId: input.replacement.sessionId,
        }).version;
        if (actualVersion !== options.expectedVersion) {
          throw new CharacterAffectVersionConflictError(options.expectedVersion, actualVersion);
        }
      }
      const original = this.requireEvent(input.eventId);
      if (
        original.character_id !== input.replacement.characterId
        || original.user_id !== input.replacement.userId
      ) {
        throw new Error("Correction must remain within the original character and user scope.");
      }
      if (original.layer === "session" && original.session_id !== input.replacement.sessionId) {
        throw new Error("A session affect correction must remain within its original session scope.");
      }
      if (original.state !== "active") {
        throw new Error("Only an active affect event can be corrected.");
      }

      const eventId = randomUUID();
      const createdAt = new Date().toISOString();
      this.insertEvent(
        eventId,
        input.replacement,
        requestFingerprint,
        original.id,
        original.memory_entry_id,
        createdAt,
      );
      this.insertIdempotency(input.replacement, "correct", requestFingerprint, eventId, null, createdAt);
      this.db.prepare("UPDATE character_affect_events_v6 SET state = 'corrected' WHERE id = ?").run(original.id);
      this.insertMutation(
        "correct",
        input.replacement.characterId,
        input.replacement.userId,
        input.replacement.layer === "session" ? input.replacement.sessionId : null,
        input.replacement.sessionId,
        eventId,
        null,
        input.reason,
        createdAt,
      );
      return { conflict: false, result: { event: toStoredEvent(this.requireEvent(eventId)), created: true } } as const;
    });
    if (outcome.conflict) {
      throw new CharacterAffectIdempotencyConflictError();
    }
    return outcome.result;
  }

  reset(
    input: AffectResetInput,
    options: { expectedVersion?: string; versionSessionId?: string } = {},
  ): { resetId: string; created: boolean } {
    requireText(input.characterId, "characterId");
    requireText(input.userId, "userId");
    assertLocalUser(input.userId);
    requireText(input.reason, "reason");
    requireText(input.idempotencyKey, "idempotencyKey");
    assertCanonicalUtcTimestamp(input.resetAt, "resetAt");
    if (input.layer === "session") {
      requireText(input.sessionId ?? "", "sessionId");
      this.assertSessionOwner(input.sessionId!, input.characterId);
    } else if (input.sessionId !== undefined) {
      throw new Error("Relationship reset must not specify sessionId.");
    }
    const requestFingerprint = fingerprint({ operation: "reset", input });

    const outcome = this.transaction(() => {
      const replay = this.findIdempotency(input.characterId, input.userId, input.idempotencyKey);
      if (replay) {
        if (replay.operation !== "reset" || replay.request_fingerprint !== requestFingerprint || !replay.reset_id) {
          this.insertObservation("idempotency", "rejected", input, replay.event_id, replay.reset_id, "Conflicting affect reset.");
          return { conflict: true } as const;
        }
        this.insertObservation("idempotency", "replayed", input, null, replay.reset_id, "Identical affect reset replayed.");
        return { conflict: false, result: { resetId: replay.reset_id, created: false } } as const;
      }

      if (options.expectedVersion) {
        const versionSessionId = input.layer === "session" ? input.sessionId! : options.versionSessionId;
        if (!versionSessionId) {
          throw new Error("Relationship reset version validation requires versionSessionId.");
        }
        const actualVersion = this.getStateVersion({
          characterId: input.characterId,
          userId: input.userId,
          sessionId: versionSessionId,
        }).version;
        if (actualVersion !== options.expectedVersion) {
          throw new CharacterAffectVersionConflictError(options.expectedVersion, actualVersion);
        }
      }

      const resetId = randomUUID();
      const createdAt = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO character_affect_resets_v6 (
          id, character_id, user_id, session_id, layer, reason, reset_at,
          idempotency_key, request_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resetId,
        input.characterId,
        input.userId,
        input.sessionId ?? null,
        input.layer,
        input.reason,
        input.resetAt,
        input.idempotencyKey,
        requestFingerprint,
        createdAt,
      );
      this.insertIdempotency(input, "reset", requestFingerprint, null, resetId, createdAt);
      this.insertMutation(
        "reset",
        input.characterId,
        input.userId,
        input.sessionId ?? null,
        input.sessionId ?? null,
        null,
        resetId,
        input.reason,
        createdAt,
      );
      return { conflict: false, result: { resetId, created: true } } as const;
    });
    if (outcome.conflict) {
      throw new CharacterAffectIdempotencyConflictError();
    }
    return outcome.result;
  }

  linkMemoryEpisode(eventId: string, memoryEntryId: string): void {
    requireText(memoryEntryId, "memoryEntryId");
    this.transaction(() => {
      const event = this.requireEvent(eventId);
      if (event.memory_entry_id && event.memory_entry_id !== memoryEntryId) {
        throw new Error("Affect event is already linked to another Memory episode.");
      }
      if (!event.memory_entry_id) {
        const changed = this.db.prepare(`
          UPDATE character_affect_events_v6
          SET memory_entry_id = ?
          WHERE id = ?
        `).run(memoryEntryId, eventId);
        if (changed.changes !== 1) {
          throw new Error("Affect event was not found.");
        }
        this.insertMutation(
          "link_episode",
          event.character_id,
          event.user_id,
          event.session_id,
          event.source_session_id,
          event.id,
          null,
          "Linked Character Memory episode.",
          new Date().toISOString(),
        );
      }
    });
  }

  recordEpisodeCandidate(eventId: string): void {
    this.transaction(() => {
      const event = this.requireEvent(eventId);
      const existing = this.db.prepare(`
        SELECT id FROM character_affect_mutations_v6
        WHERE operation = 'episode_candidate' AND event_id = ?
      `).get(eventId);
      if (!existing) {
        this.insertMutation(
          "episode_candidate",
          event.character_id,
          event.user_id,
          event.session_id,
          event.source_session_id,
          event.id,
          null,
          "Character Memory episode candidate generated.",
          new Date().toISOString(),
        );
      }
    });
  }

  recordRejection(input: { characterId: string; userId: string; sessionId: string; reason: string }): void {
    assertLocalUser(input.userId);
    this.assertSessionOwner(input.sessionId, input.characterId);
    this.transaction(() => {
      this.insertMutation(
        "reject",
        input.characterId,
        input.userId,
        input.sessionId,
        input.sessionId,
        null,
        null,
        input.reason,
        new Date().toISOString(),
      );
    });
  }

  getEvent(input: { eventId: string; characterId: string; userId: string }): StoredAffectEvent | null {
    assertLocalUser(input.userId);
    const row = this.db.prepare(`
      SELECT *
      FROM character_affect_events_v6
      WHERE id = ? AND character_id = ? AND user_id = ?
    `).get(input.eventId, input.characterId, input.userId) as AffectEventRow | undefined;
    return row ? toStoredEvent(row) : null;
  }

  getEffectiveState(input: {
    characterId: string;
    userId: string;
    sessionId: string;
    baseline?: readonly AffectBaselineComponent[];
  }): EffectiveAffectState {
    assertLocalUser(input.userId);
    this.assertSessionOwner(input.sessionId, input.characterId);
    for (const component of input.baseline ?? []) {
      assertValidAffectBaseline(component);
    }
    const relationshipResetAt = this.latestResetAt(input.characterId, input.userId, "relationship", null);
    const sessionResetAt = this.latestResetAt(input.characterId, input.userId, "session", input.sessionId);
    const rows = this.db.prepare(`
      SELECT *
      FROM character_affect_events_v6
      WHERE character_id = ?
        AND user_id = ?
        AND state = 'active'
        AND (
          (layer = 'relationship' AND occurred_at > ?)
          OR (layer = 'session' AND session_id = ? AND occurred_at > ?)
        )
      ORDER BY occurred_at ASC, id ASC
    `).all(
      input.characterId,
      input.userId,
      relationshipResetAt,
      input.sessionId,
      sessionResetAt,
    ) as AffectEventRow[];

    const layers = [
      ...(input.baseline ?? []).map((component) => ({
        layer: "baseline" as const,
        targetType: component.targetType,
        targetId: component.targetId,
        value: component.value,
        intensity: component.intensity,
        reason: component.reason,
        eventId: null,
      })),
      ...rows.map((row) => ({
        layer: row.layer,
        targetType: row.target_type,
        targetId: row.target_id,
        value: parseValue(row.value_json),
        intensity: row.intensity,
        reason: row.reason,
        eventId: row.id,
      })),
    ];

    return {
      schemaVersion: AFFECT_SCHEMA_VERSION,
      characterId: input.characterId,
      userId: input.userId,
      sessionId: input.sessionId,
      layers: aggregateComponents(layers, true),
      components: aggregateComponents(layers, false),
    };
  }

  getStateVersion(input: {
    characterId: string;
    userId: string;
    sessionId: string;
  }): CharacterAffectStateVersion {
    assertLocalUser(input.userId);
    this.assertSessionOwner(input.sessionId, input.characterId);
    const events = this.db.prepare(`
      SELECT id, state, occurred_at AS occurredAt, created_at AS createdAt
      FROM character_affect_events_v6
      WHERE character_id = ?
        AND user_id = ?
        AND (layer = 'relationship' OR session_id = ?)
      ORDER BY occurred_at ASC, id ASC
    `).all(input.characterId, input.userId, input.sessionId) as Array<{
      id: string;
      state: "active" | "corrected";
      occurredAt: string;
      createdAt: string;
    }>;
    const resets = this.db.prepare(`
      SELECT id, layer, reset_at AS resetAt, created_at AS createdAt
      FROM character_affect_resets_v6
      WHERE character_id = ?
        AND user_id = ?
        AND (layer = 'relationship' OR session_id = ?)
      ORDER BY reset_at ASC, id ASC
    `).all(input.characterId, input.userId, input.sessionId) as Array<{
      id: string;
      layer: AffectLayer;
      resetAt: string;
      createdAt: string;
    }>;
    const updatedAt = [...events.map((event) => event.createdAt), ...resets.map((reset) => reset.createdAt)]
      .sort()
      .at(-1) ?? null;
    return {
      version: `affect-v1-${fingerprint({ events, resets })}`,
      updatedAt,
    };
  }

  inspect(input: { characterId: string; userId: string; sessionId?: string }): {
    events: StoredAffectEvent[];
    resets: AffectResetRecord[];
    mutations: AffectMutationRecord[];
  } {
    assertLocalUser(input.userId);
    if (input.sessionId) {
      this.assertSessionOwner(input.sessionId, input.characterId);
    }
    const allEvents = this.db.prepare(`
      SELECT * FROM character_affect_events_v6
      WHERE character_id = ? AND user_id = ?
      ORDER BY occurred_at ASC, id ASC
    `).all(input.characterId, input.userId) as AffectEventRow[];
    const relevantEventIds = new Set(
      allEvents
        .filter((event) => !input.sessionId || event.layer === "relationship" || event.session_id === input.sessionId)
        .map((event) => event.id),
    );
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const event of allEvents) {
        const correctionIsRelevant = event.correction_of_event_id
          ? relevantEventIds.has(event.correction_of_event_id)
          : false;
        const originalIsRelevant = event.correction_of_event_id
          ? relevantEventIds.has(event.id)
          : false;
        if (correctionIsRelevant && !relevantEventIds.has(event.id)) {
          relevantEventIds.add(event.id);
          expanded = true;
        }
        if (originalIsRelevant && !relevantEventIds.has(event.correction_of_event_id!)) {
          relevantEventIds.add(event.correction_of_event_id!);
          expanded = true;
        }
      }
    }
    const events = allEvents.filter((event) => relevantEventIds.has(event.id));

    const allResets = this.db.prepare(`
      SELECT
        id,
        character_id AS characterId,
        user_id AS userId,
        session_id AS sessionId,
        layer,
        reason,
        reset_at AS resetAt,
        idempotency_key AS idempotencyKey,
        created_at AS createdAt
      FROM character_affect_resets_v6
      WHERE character_id = ? AND user_id = ?
      ORDER BY reset_at ASC, id ASC
    `).all(input.characterId, input.userId) as AffectResetRecord[];
    const resets = allResets.filter(
      (reset) => !input.sessionId || reset.layer === "relationship" || reset.sessionId === input.sessionId,
    );
    const relevantResetIds = new Set(resets.map((reset) => reset.id));

    const allMutations = this.db.prepare(`
      SELECT
        id,
        operation,
        character_id AS characterId,
        user_id AS userId,
        session_id AS sessionId,
        source_session_id AS sourceSessionId,
        event_id AS eventId,
        reset_id AS resetId,
        reason,
        created_at AS createdAt
      FROM character_affect_mutations_v6
      WHERE character_id = ? AND user_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(input.characterId, input.userId) as AffectMutationRecord[];
    const mutations = allMutations.filter(
      (mutation) => !input.sessionId
        || mutation.sessionId === input.sessionId
        || (mutation.eventId ? relevantEventIds.has(mutation.eventId) : false)
        || (mutation.resetId ? relevantResetIds.has(mutation.resetId) : false),
    );
    return { events: events.map(toStoredEvent), resets, mutations };
  }

  getMetrics(): {
    events: number;
    relationshipUpdates: number;
    sessionUpdates: number;
    corrections: number;
    resets: number;
    linkedEpisodes: number;
    rejectedEvents: number;
    episodeCandidates: number;
    idempotencyReplays: number;
    idempotencyConflictsRejected: number;
  } {
    const eventCounts = this.db.prepare(`
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN layer = 'relationship' THEN 1 ELSE 0 END) AS relationshipUpdates,
        SUM(CASE WHEN layer = 'session' THEN 1 ELSE 0 END) AS sessionUpdates
      FROM character_affect_events_v6
    `).get() as { events: number; relationshipUpdates: number | null; sessionUpdates: number | null };
    const mutationCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN operation = 'correct' THEN 1 ELSE 0 END) AS corrections,
        SUM(CASE WHEN operation = 'reset' THEN 1 ELSE 0 END) AS resets,
        SUM(CASE WHEN operation = 'reject' THEN 1 ELSE 0 END) AS rejectedEvents,
        SUM(CASE WHEN operation = 'episode_candidate' THEN 1 ELSE 0 END) AS episodeCandidates,
        SUM(CASE WHEN operation = 'link_episode' THEN 1 ELSE 0 END) AS linkedEpisodes
      FROM character_affect_mutations_v6
    `).get() as {
      corrections: number | null;
      resets: number | null;
      rejectedEvents: number | null;
      episodeCandidates: number | null;
      linkedEpisodes: number | null;
    };
    const observationCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'idempotency' AND outcome = 'replayed' THEN 1 ELSE 0 END) AS replays,
        SUM(CASE WHEN kind = 'idempotency' AND outcome = 'rejected' THEN 1 ELSE 0 END) AS conflicts
      FROM character_affect_observations_v6
    `).get() as { replays: number | null; conflicts: number | null };
    return {
      events: eventCounts.events,
      relationshipUpdates: eventCounts.relationshipUpdates ?? 0,
      sessionUpdates: eventCounts.sessionUpdates ?? 0,
      corrections: mutationCounts.corrections ?? 0,
      resets: mutationCounts.resets ?? 0,
      rejectedEvents: mutationCounts.rejectedEvents ?? 0,
      episodeCandidates: mutationCounts.episodeCandidates ?? 0,
      linkedEpisodes: mutationCounts.linkedEpisodes ?? 0,
      idempotencyReplays: observationCounts.replays ?? 0,
      idempotencyConflictsRejected: observationCounts.conflicts ?? 0,
    };
  }

  private insertEvent(
    eventId: string,
    input: AffectEventInput,
    requestFingerprint: string,
    correctionOfEventId: string | null,
    supersedesMemoryEntryId: string | null,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO character_affect_events_v6 (
        id, character_id, user_id, session_id, source_session_id, layer, target_type, target_id,
        value_json, intensity, reason, evidence, occurred_at, idempotency_key,
        request_fingerprint, correction_of_event_id, state, memory_entry_id,
        supersedes_memory_entry_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
    `).run(
      eventId,
      input.characterId,
      input.userId,
      input.layer === "session" ? input.sessionId : null,
      input.sessionId,
      input.layer,
      input.targetType,
      input.targetId,
      stableJson(input.value),
      input.intensity,
      input.reason,
      input.evidence,
      input.occurredAt,
      input.idempotencyKey,
      requestFingerprint,
      correctionOfEventId,
      supersedesMemoryEntryId,
      createdAt,
    );
  }

  private insertMutation(
    operation: AffectMutationRecord["operation"],
    characterId: string,
    userId: string,
    sessionId: string | null,
    sourceSessionId: string | null,
    eventId: string | null,
    resetId: string | null,
    reason: string,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO character_affect_mutations_v6 (
        id, operation, character_id, user_id, session_id, source_session_id,
        event_id, reset_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      operation,
      characterId,
      userId,
      sessionId,
      sourceSessionId,
      eventId,
      resetId,
      reason,
      createdAt,
    );
  }

  private findIdempotency(characterId: string, userId: string, idempotencyKey: string): AffectIdempotencyRow | undefined {
    return this.db.prepare(`
      SELECT operation, request_fingerprint, event_id, reset_id
      FROM character_affect_idempotency_v6
      WHERE character_id = ? AND user_id = ? AND idempotency_key = ?
    `).get(characterId, userId, idempotencyKey) as AffectIdempotencyRow | undefined;
  }

  private insertIdempotency(
    input: { characterId: string; userId: string; idempotencyKey: string },
    operation: AffectIdempotencyRow["operation"],
    requestFingerprint: string,
    eventId: string | null,
    resetId: string | null,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO character_affect_idempotency_v6 (
        character_id, user_id, idempotency_key, operation, request_fingerprint,
        event_id, reset_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.characterId,
      input.userId,
      input.idempotencyKey,
      operation,
      requestFingerprint,
      eventId,
      resetId,
      createdAt,
    );
  }

  private insertObservation(
    kind: "idempotency" | "concurrency",
    outcome: "replayed" | "rejected" | "resolved",
    input: { characterId: string; userId: string; sessionId?: string },
    eventId: string | null,
    resetId: string | null,
    reason: string,
  ): void {
    const sessionId = input.sessionId && this.sessionExists(input.sessionId)
      ? input.sessionId
      : null;
    this.db.prepare(`
      INSERT INTO character_affect_observations_v6 (
        id, kind, outcome, character_id, user_id, session_id,
        event_id, reset_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      kind,
      outcome,
      input.characterId,
      input.userId,
      sessionId,
      eventId,
      resetId,
      reason,
      new Date().toISOString(),
    );
  }

  private requireEvent(eventId: string): AffectEventRow {
    const row = this.db.prepare("SELECT * FROM character_affect_events_v6 WHERE id = ?").get(eventId) as
      | AffectEventRow
      | undefined;
    if (!row) {
      throw new Error("Affect event was not found.");
    }
    return row;
  }

  private latestResetAt(characterId: string, userId: string, layer: AffectLayer, sessionId: string | null): string {
    const row = this.db.prepare(`
      SELECT reset_at
      FROM character_affect_resets_v6
      WHERE character_id = ? AND user_id = ? AND layer = ? AND session_id IS ?
      ORDER BY reset_at DESC, id DESC
      LIMIT 1
    `).get(characterId, userId, layer, sessionId) as { reset_at: string } | undefined;
    return row?.reset_at ?? "";
  }

  private assertSessionOwner(sessionId: string, characterId: string): void {
    const row = this.db.prepare("SELECT character_id FROM sessions_v6 WHERE id = ?").get(sessionId) as
      | { character_id: string | null }
      | undefined;
    if (!row || row.character_id !== characterId) {
      throw new Error("Session does not belong to the Character affect owner.");
    }
  }

  private sessionExists(sessionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id = ?").get(sessionId));
  }


  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      const result = run();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original storage failure.
      }
      throw error;
    }
  }
}

function toStoredEvent(row: AffectEventRow): StoredAffectEvent {
  return {
    schemaVersion: AFFECT_SCHEMA_VERSION,
    id: row.id,
    characterId: row.character_id,
    userId: row.user_id,
    sessionId: row.session_id,
    sourceSessionId: row.source_session_id,
    layer: row.layer,
    targetType: row.target_type,
    targetId: row.target_id,
    value: parseValue(row.value_json),
    intensity: row.intensity,
    reason: row.reason,
    evidence: row.evidence,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    correctionOfEventId: row.correction_of_event_id,
    memoryEntryId: row.memory_entry_id,
    supersedesMemoryEntryId: row.supersedes_memory_entry_id,
    createdAt: row.created_at,
  };
}

function parseValue(valueJson: string): AffectValue {
  return JSON.parse(valueJson) as AffectValue;
}

function aggregateComponents(
  inputs: Array<{
    layer: "baseline" | AffectLayer;
    targetType: AffectTargetType;
    targetId: string;
    value: AffectValue;
    intensity: number;
    reason: string;
    eventId: string | null;
  }>,
  separateLayers: boolean,
): EffectiveAffectComponent[] {
  const groups = new Map<string, EffectiveAffectComponent>();
  for (const input of inputs) {
    const key = [separateLayers ? input.layer : "effective", input.targetType, input.targetId, input.value.label].join("\u0000");
    const current = groups.get(key) ?? {
      targetType: input.targetType,
      targetId: input.targetId,
      label: input.value.label,
      valence: 0,
      dimensions: {},
      intensity: 0,
      reasons: [],
      eventIds: [],
      contributingLayers: [],
    };
    current.valence = clamp(current.valence + input.value.valence * input.intensity);
    if (input.value.arousal !== undefined) {
      current.arousal = clamp((current.arousal ?? 0) + input.value.arousal * input.intensity);
    }
    for (const [dimension, value] of Object.entries(input.value.dimensions ?? {})) {
      current.dimensions[dimension] = clamp((current.dimensions[dimension] ?? 0) + value * input.intensity);
    }
    current.intensity = clamp(current.intensity + input.intensity, 0, 1);
    current.reasons.push(input.reason);
    if (input.eventId) {
      current.eventIds.push(input.eventId);
    }
    if (!current.contributingLayers.includes(input.layer)) {
      current.contributingLayers.push(input.layer);
    }
    groups.set(key, current);
  }
  return [...groups.values()];
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => child === undefined ? null : canonicalJsonValue(child));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireText(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must not be empty.`);
  }
}

function assertLocalUser(userId: string): void {
  if (userId !== LOCAL_USER_ID) {
    throw new Error("Character affect owner must be local-user.");
  }
}
