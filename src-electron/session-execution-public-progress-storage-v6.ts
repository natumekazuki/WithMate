import type { DatabaseSync } from "node:sqlite";

import { CREATE_V6_SESSION_EXECUTION_PUBLIC_PROGRESS_TABLE_SQL, ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

export const SESSION_EXECUTION_PUBLIC_PROGRESS_MAX_BYTES = 1024 * 1024;

export type SessionExecutionPublicProgress = {
  executionId: string;
  assistantText: string;
  truncated: boolean;
  updatedAt: string;
};

export type UpsertSessionExecutionPublicProgressInput = {
  executionId: string;
  assistantText: string;
  updatedAt: string;
};

type SessionExecutionPublicProgressRow = {
  execution_id: string;
  assistant_text: string;
  truncated: number;
  updated_at: string;
};

/** Provider-neutral, user-visible partial assistant output for one execution. */
export class SessionExecutionPublicProgressStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
    this.db.exec(CREATE_V6_SESSION_EXECUTION_PUBLIC_PROGRESS_TABLE_SQL);
  }

  upsert(input: UpsertSessionExecutionPublicProgressInput): SessionExecutionPublicProgress {
    if (typeof input.executionId !== "string" || input.executionId.length === 0) {
      throw new TypeError("executionId must be a non-empty string.");
    }
    if (typeof input.assistantText !== "string") {
      throw new TypeError("assistantText must be a string.");
    }
    if (typeof input.updatedAt !== "string" || input.updatedAt.length === 0) {
      throw new TypeError("updatedAt must be a non-empty string.");
    }

    const bounded = truncateUtf8(input.assistantText, SESSION_EXECUTION_PUBLIC_PROGRESS_MAX_BYTES);
    this.db.prepare(`
      INSERT INTO session_execution_public_progress_v6 (
        execution_id, assistant_text, truncated, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        assistant_text = excluded.assistant_text,
        truncated = excluded.truncated,
        updated_at = excluded.updated_at
    `).run(input.executionId, bounded.text, bounded.truncated ? 1 : 0, input.updatedAt);

    return {
      executionId: input.executionId,
      assistantText: bounded.text,
      truncated: bounded.truncated,
      updatedAt: input.updatedAt,
    };
  }

  get(executionId: string): SessionExecutionPublicProgress | null {
    const row = this.db.prepare(`
      SELECT execution_id, assistant_text, truncated, updated_at
      FROM session_execution_public_progress_v6
      WHERE execution_id = ?
    `).get(executionId) as SessionExecutionPublicProgressRow | undefined;
    return row ? parseRow(row) : null;
  }

  read(executionId: string): SessionExecutionPublicProgress | null {
    return this.get(executionId);
  }

  delete(executionId: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM session_execution_public_progress_v6 WHERE execution_id = ?",
    ).run(executionId);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}

function parseRow(row: SessionExecutionPublicProgressRow): SessionExecutionPublicProgress {
  return {
    executionId: row.execution_id,
    assistantText: row.assistant_text,
    truncated: row.truncated === 1,
    updatedAt: row.updated_at,
  };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return { text: text.slice(0, end), truncated: true };
}
