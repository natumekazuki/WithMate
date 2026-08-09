import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  assertValidAffectEvent,
  type AffectEventInput,
} from "../src/character-affect/affect-contract.js";
import { openAppDatabase } from "./sqlite-connection.js";

export type CharacterAffectTurnSettlementInput = {
  correlationId: string;
  characterId: string;
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  assistantMessageIndex: number;
  occurredAt: string;
};

export type PendingCharacterAffectTurnSettlement = CharacterAffectTurnSettlementInput & {
  createdAt: string;
  attemptCount: number;
  evaluationAttempt: number;
  evaluation: CharacterAffectTurnEvaluationSnapshot | null;
};

export type CharacterAffectTurnAppraisalEffect = "none" | "committed" | "partial" | "unknown";

export type CharacterAffectTurnEvaluationSnapshot = {
  evaluationAttempt: number;
  expectedVersion: string;
  candidates: AffectEventInput[];
  lastEffect: CharacterAffectTurnAppraisalEffect;
  observedEffects: CharacterAffectTurnAppraisalEffect[];
  savedCandidateIndices: number[];
};

export function hasCommittedAssistantMessage(
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  settlement: Pick<CharacterAffectTurnSettlementInput, "assistantMessage" | "assistantMessageIndex">,
): boolean {
  const message = messages[settlement.assistantMessageIndex];
  return message?.role === "assistant" && message.text === settlement.assistantMessage;
}

type SettlementRow = {
  correlation_id: string;
  character_id: string;
  session_id: string;
  user_message: string;
  assistant_message: string;
  assistant_message_index: number;
  occurred_at: string;
  request_fingerprint: string;
  status: "pending" | "settled";
  attempt_count: number;
  created_at: string;
  evaluation_attempt: number;
  expected_version: string | null;
  candidates_json: string | null;
  last_effect: CharacterAffectTurnAppraisalEffect;
  observed_effects_json: string;
  saved_candidate_indices_json: string;
};

function requireText(value: string, field: string): string {
  if (!value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function fingerprint(input: CharacterAffectTurnSettlementInput): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeCandidateIndices(indices: readonly number[]): number[] {
  return [...new Set(indices.map((index) => requireNonNegativeInteger(index, "candidateIndex")))].sort((a, b) => a - b);
}

function requireAppraisalEffect(value: string): CharacterAffectTurnAppraisalEffect {
  if (value !== "none" && value !== "committed" && value !== "partial" && value !== "unknown") {
    throw new Error("Stored Character affect appraisal effect is invalid.");
  }
  return value;
}

function parseObservedEffects(value: string): CharacterAffectTurnAppraisalEffect[] {
  const effects = JSON.parse(value) as unknown;
  if (!Array.isArray(effects)) {
    throw new Error("Stored Character affect appraisal effect history must be an array.");
  }
  return effects.map((effect) => requireAppraisalEffect(String(effect)));
}

function parseEvaluation(row: SettlementRow): CharacterAffectTurnEvaluationSnapshot | null {
  if (row.candidates_json === null || row.expected_version === null) {
    return null;
  }
  const candidates = JSON.parse(row.candidates_json) as unknown;
  if (!Array.isArray(candidates)) {
    throw new Error("Stored Character affect candidates must be an array.");
  }
  for (const candidate of candidates) {
    assertValidAffectEvent(candidate as AffectEventInput);
  }
  const savedCandidateIndices = JSON.parse(row.saved_candidate_indices_json) as unknown;
  if (!Array.isArray(savedCandidateIndices) || !savedCandidateIndices.every((value) => Number.isInteger(value))) {
    throw new Error("Stored Character affect candidate progress is invalid.");
  }
  return {
    evaluationAttempt: requireNonNegativeInteger(row.evaluation_attempt, "evaluationAttempt"),
    expectedVersion: requireText(row.expected_version, "expectedVersion"),
    candidates: candidates as AffectEventInput[],
    lastEffect: requireAppraisalEffect(row.last_effect),
    observedEffects: parseObservedEffects(row.observed_effects_json),
    savedCandidateIndices: normalizeCandidateIndices(savedCandidateIndices as number[]),
  };
}

function toPending(row: SettlementRow): PendingCharacterAffectTurnSettlement {
  return {
    correlationId: row.correlation_id,
    characterId: row.character_id,
    sessionId: row.session_id,
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    assistantMessageIndex: row.assistant_message_index,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    evaluationAttempt: requireNonNegativeInteger(row.evaluation_attempt, "evaluationAttempt"),
    evaluation: parseEvaluation(row),
  };
}

export class CharacterAffectTurnSettlementStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_affect_turn_settlements (
        correlation_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        assistant_message_index INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'settled')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        evaluation_attempt INTEGER NOT NULL DEFAULT 0,
        expected_version TEXT,
        candidates_json TEXT,
        last_effect TEXT NOT NULL DEFAULT 'none',
        observed_effects_json TEXT NOT NULL DEFAULT '[]',
        saved_candidate_indices_json TEXT NOT NULL DEFAULT '[]',
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_character_affect_turn_settlements_pending
      ON character_affect_turn_settlements(status, created_at, correlation_id);
    `);
    const columns = this.db.prepare("PRAGMA table_info(character_affect_turn_settlements)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "assistant_message_index")) {
      this.db.exec(`
        ALTER TABLE character_affect_turn_settlements
        ADD COLUMN assistant_message_index INTEGER NOT NULL DEFAULT -1
      `);
    }
    if (!columns.some((column) => column.name === "evaluation_attempt")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN evaluation_attempt INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "expected_version")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN expected_version TEXT");
    }
    if (!columns.some((column) => column.name === "candidates_json")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN candidates_json TEXT");
    }
    if (!columns.some((column) => column.name === "last_effect")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN last_effect TEXT NOT NULL DEFAULT 'none'");
    }
    if (!columns.some((column) => column.name === "observed_effects_json")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN observed_effects_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.some((column) => column.name === "saved_candidate_indices_json")) {
      this.db.exec("ALTER TABLE character_affect_turn_settlements ADD COLUMN saved_candidate_indices_json TEXT NOT NULL DEFAULT '[]'");
    }
    this.db.exec(`
      UPDATE character_affect_turn_settlements
      SET observed_effects_json = '["' || last_effect || '"]'
      WHERE status = 'pending'
        AND candidates_json IS NOT NULL
        AND observed_effects_json = '[]'
        AND last_effect IN ('partial', 'committed', 'unknown')
    `);
  }

  enqueue(input: CharacterAffectTurnSettlementInput): { created: boolean } {
    const normalized: CharacterAffectTurnSettlementInput = {
      correlationId: requireText(input.correlationId, "correlationId"),
      characterId: requireText(input.characterId, "characterId"),
      sessionId: requireText(input.sessionId, "sessionId"),
      userMessage: requireText(input.userMessage, "userMessage"),
      assistantMessage: requireText(input.assistantMessage, "assistantMessage"),
      assistantMessageIndex: input.assistantMessageIndex,
      occurredAt: requireText(input.occurredAt, "occurredAt"),
    };
    if (!Number.isInteger(normalized.assistantMessageIndex) || normalized.assistantMessageIndex < 0) {
      throw new Error("assistantMessageIndex must be a non-negative integer.");
    }
    const requestFingerprint = fingerprint(normalized);
    const existing = this.db.prepare(`
      SELECT * FROM character_affect_turn_settlements WHERE correlation_id = ?
    `).get(normalized.correlationId) as SettlementRow | undefined;
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new Error("Character affect turn correlation was reused with different content.");
      }
      return { created: false };
    }

    this.db.prepare(`
      INSERT INTO character_affect_turn_settlements (
        correlation_id, character_id, session_id, user_message, assistant_message,
        assistant_message_index, occurred_at, request_fingerprint, status, attempt_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(
      normalized.correlationId,
      normalized.characterId,
      normalized.sessionId,
      normalized.userMessage,
      normalized.assistantMessage,
      normalized.assistantMessageIndex,
      normalized.occurredAt,
      requestFingerprint,
      new Date().toISOString(),
    );
    return { created: true };
  }

  listPending(
    limit = 100,
    after?: Pick<PendingCharacterAffectTurnSettlement, "createdAt" | "correlationId">,
  ): PendingCharacterAffectTurnSettlement[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("limit must be an integer between 1 and 1000.");
    }
    const rows = after
      ? this.db.prepare(`
          SELECT * FROM character_affect_turn_settlements
          WHERE status = 'pending'
            AND (created_at > ? OR (created_at = ? AND correlation_id > ?))
          ORDER BY created_at ASC, correlation_id ASC
          LIMIT ?
        `).all(after.createdAt, after.createdAt, after.correlationId, limit)
      : this.db.prepare(`
      SELECT * FROM character_affect_turn_settlements
      WHERE status = 'pending'
      ORDER BY created_at ASC, correlation_id ASC
      LIMIT ?
    `).all(limit);
    return (rows as SettlementRow[]).map(toPending);
  }

  getPending(correlationId: string): PendingCharacterAffectTurnSettlement | null {
    const row = this.db.prepare(`
      SELECT * FROM character_affect_turn_settlements
      WHERE correlation_id = ? AND status = 'pending'
    `).get(requireText(correlationId, "correlationId")) as SettlementRow | undefined;
    return row ? toPending(row) : null;
  }

  saveEvaluation(input: {
    correlationId: string;
    evaluationAttempt: number;
    expectedVersion: string;
    candidates: AffectEventInput[];
  }): { created: boolean } {
    const correlationId = requireText(input.correlationId, "correlationId");
    const evaluationAttempt = requireNonNegativeInteger(input.evaluationAttempt, "evaluationAttempt");
    const expectedVersion = requireText(input.expectedVersion, "expectedVersion");
    for (const candidate of input.candidates) {
      assertValidAffectEvent(candidate);
    }
    const candidatesJson = JSON.stringify(input.candidates);
    const row = this.db.prepare(`
      SELECT * FROM character_affect_turn_settlements
      WHERE correlation_id = ? AND status = 'pending'
    `).get(correlationId) as SettlementRow | undefined;
    if (!row) {
      throw new Error("Pending Character affect turn settlement was not found.");
    }
    if (row.candidates_json !== null || row.expected_version !== null) {
      if (
        row.evaluation_attempt !== evaluationAttempt
        || row.expected_version !== expectedVersion
        || row.candidates_json !== candidatesJson
      ) {
        throw new Error("Character affect turn evaluation identity cannot be reassigned.");
      }
      return { created: false };
    }
    const result = this.db.prepare(`
      UPDATE character_affect_turn_settlements
      SET evaluation_attempt = ?, expected_version = ?, candidates_json = ?,
          last_effect = 'none', observed_effects_json = '[]', saved_candidate_indices_json = '[]'
      WHERE correlation_id = ? AND status = 'pending'
        AND expected_version IS NULL AND candidates_json IS NULL
    `).run(evaluationAttempt, expectedVersion, candidatesJson, correlationId);
    if (result.changes !== 1) {
      throw new Error("Character affect turn evaluation could not be persisted.");
    }
    return { created: true };
  }

  recordAppraisalFailure(input: {
    correlationId: string;
    evaluationAttempt: number;
    effect: CharacterAffectTurnAppraisalEffect;
    savedCandidateIndices: readonly number[];
    prepareReevaluation: boolean;
  }): { reevaluationPrepared: boolean } {
    const correlationId = requireText(input.correlationId, "correlationId");
    const evaluationAttempt = requireNonNegativeInteger(input.evaluationAttempt, "evaluationAttempt");
    const effect = requireAppraisalEffect(input.effect);
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const row = this.db.prepare(`
        SELECT * FROM character_affect_turn_settlements
        WHERE correlation_id = ? AND status = 'pending' AND candidates_json IS NOT NULL
      `).get(correlationId) as SettlementRow | undefined;
      if (!row || row.evaluation_attempt !== evaluationAttempt) {
        throw new Error("Character affect turn appraisal progress could not be persisted.");
      }
      const previousEffects = parseObservedEffects(row.observed_effects_json);
      const previousSaved = JSON.parse(row.saved_candidate_indices_json) as unknown;
      if (!Array.isArray(previousSaved) || !previousSaved.every((value) => Number.isInteger(value))) {
        throw new Error("Stored Character affect candidate progress is invalid.");
      }
      const normalizedPreviousSaved = normalizeCandidateIndices(previousSaved as number[]);
      const normalizedIncomingSaved = normalizeCandidateIndices(input.savedCandidateIndices);
      if (
        input.prepareReevaluation
        && effect === "none"
        && evaluationAttempt === 0
        && previousEffects.length === 0
        && normalizedPreviousSaved.length === 0
        && normalizedIncomingSaved.length === 0
      ) {
        const reset = this.db.prepare(`
          UPDATE character_affect_turn_settlements
          SET evaluation_attempt = 1,
              expected_version = NULL,
              candidates_json = NULL,
              last_effect = 'none',
              observed_effects_json = '[]',
              saved_candidate_indices_json = '[]'
          WHERE correlation_id = ? AND status = 'pending'
            AND evaluation_attempt = 0 AND candidates_json IS NOT NULL
        `).run(correlationId);
        if (reset.changes !== 1) {
          throw new Error("Character affect turn reevaluation could not be prepared.");
        }
        this.db.exec("COMMIT");
        transactionStarted = false;
        return { reevaluationPrepared: true };
      }
      const observedEffects = [...previousEffects, effect];
      const savedCandidateIndices = normalizeCandidateIndices([
        ...normalizedPreviousSaved,
        ...normalizedIncomingSaved,
      ]);
      const result = this.db.prepare(`
        UPDATE character_affect_turn_settlements
        SET last_effect = ?, observed_effects_json = ?, saved_candidate_indices_json = ?
        WHERE correlation_id = ? AND status = 'pending' AND candidates_json IS NOT NULL
      `).run(
        effect,
        JSON.stringify(observedEffects),
        JSON.stringify(savedCandidateIndices),
        correlationId,
      );
      if (result.changes !== 1) {
        throw new Error("Character affect turn appraisal progress could not be persisted.");
      }
      this.db.exec("COMMIT");
      transactionStarted = false;
      return { reevaluationPrepared: false };
    } catch (error) {
      if (transactionStarted) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  recordAttempt(correlationId: string): void {
    this.db.prepare(`
      UPDATE character_affect_turn_settlements
      SET attempt_count = attempt_count + 1
      WHERE correlation_id = ? AND status = 'pending'
    `).run(requireText(correlationId, "correlationId"));
  }

  markSettled(correlationId: string, settledAt = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      UPDATE character_affect_turn_settlements
      SET status = 'settled',
          user_message = '',
          assistant_message = '',
          expected_version = NULL,
          candidates_json = NULL,
          observed_effects_json = '[]',
          saved_candidate_indices_json = '[]',
          settled_at = ?
      WHERE correlation_id = ? AND status = 'pending'
    `).run(requireText(settledAt, "settledAt"), requireText(correlationId, "correlationId"));
    return result.changes === 1;
  }

  markDiscarded(correlationId: string, discardedAt = new Date().toISOString()): boolean {
    return this.markSettled(correlationId, discardedAt);
  }

  close(): void {
    this.db.close();
  }
}
