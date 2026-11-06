import type { DatabaseSync } from "node:sqlite";
import type { CoordinationRecord } from "../../src-shared/coordination/coordination-contract.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";

/** Preserve accepted answer text while taking current consultation state at dispatch. */
export function coordinationDispatchJson(db: DatabaseSync, json: string): string {
  const captured = JSON.parse(json) as SessionTurnQueueCapturedInput;
  if (!captured.coordination) return json;
  const row = db.prepare("SELECT payload_json FROM coordination_records_v7 WHERE id=?").get(captured.coordination.id) as { payload_json: string } | undefined;
  if (!row) throw new Error("Coordination delivery no longer has its saved record.");
  const record = JSON.parse(row.payload_json) as CoordinationRecord;
  const accepted = JSON.parse(captured.request.userMessage) as Record<string, unknown>;
  captured.request.userMessage = JSON.stringify({ ...accepted, state: record.state, withdrawalReason: record.withdrawalReason ?? null });
  return JSON.stringify(captured);
}
