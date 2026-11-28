import type { DatabaseSync } from "node:sqlite";
import {
  sessionInstructionsByteLength,
  validateSessionInstructions,
  type SessionInstructionsTarget,
} from "../../src-shared/session/session-instructions.js";
import { assertRuntimeTurnAdmission } from "../platform/agent-runtime/runtime-turn-admission.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/**
 * Locates the exact saved owner. The Auxiliary condition includes the owning
 * Main incarnation so a recreated Main cannot inherit access to old rows.
 */
function ownerRow(target: SessionInstructionsTarget): { table: string; where: string; params: string[] } {
  // Main and Auxiliary use separate tables, even when they share a Session Window.
  if (target.kind === "main") {
    return { table: "sessions_v6", where: "id = ? AND incarnation_id = ?", params: [target.sessionId, target.incarnationId] };
  }
  return {
    table: "auxiliary_sessions",
    where: "id = ? AND created_at = ? AND parent_session_id = ? AND EXISTS (SELECT 1 FROM sessions_v6 WHERE id = auxiliary_sessions.parent_session_id AND incarnation_id = ?)",
    params: [target.sessionId, target.incarnationId, target.mainSessionId, target.mainIncarnationId],
  };
}

/** Accesses only the instruction column, independently of normal Session and history projections. */
export class SessionInstructionsStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  /** Releases the worker-owned SQLite connection. */
  close(): void {
    this.db.close();
  }

  /** Returns the saved text, or null when the exact owner is no longer present. */
  get(target: SessionInstructionsTarget): string | null {
    const owner = ownerRow(target);
    assertRuntimeTurnAdmission();
    const row = this.db.prepare(`SELECT instructions_json FROM ${owner.table} WHERE ${owner.where}`).get(...owner.params);
    return row ? validateSessionInstructions(JSON.parse(String(row.instructions_json))) : null;
  }

  /** Validates and replaces the entire body in one write; a missing owner changes nothing. */
  set(target: SessionInstructionsTarget, input: unknown): { byteLength: number } | null {
    // JSON preserves the input verbatim at the JS/SQLite boundary, including escaped code units.
    const body = validateSessionInstructions(input);
    const byteLength = sessionInstructionsByteLength(body);
    const owner = ownerRow(target);
    const encoded = JSON.stringify(body);
    // Check admission after acquiring the write lock; waiting for SQLite does not keep a grant active.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertRuntimeTurnAdmission();
      const changes = this.db.prepare(`UPDATE ${owner.table} SET instructions_json = ? WHERE ${owner.where}`)
        .run(encoded, ...owner.params).changes;
      assertRuntimeTurnAdmission();
      this.db.exec("COMMIT");
      return Number(changes) === 1 ? { byteLength } : null;
    } catch (error) {
      // Reject an unapplied or rolled-back change without replacing the previous body.
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
