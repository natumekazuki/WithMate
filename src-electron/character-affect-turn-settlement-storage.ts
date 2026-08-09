import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
      SET status = 'settled', user_message = '', assistant_message = '', settled_at = ?
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
