import type { DatabaseSync } from "node:sqlite";
import type { CreateSessionInput } from "../../src-shared/session/session-state.js";

export type SessionLifecycleTarget = { id: string; incarnationId?: string; rootSessionId?: string; parentSessionId?: string | null; parentIncarnationId?: string };
export type SessionLifecycleResource = { path: string; stagingPath?: string; device: string; inode: string; cleaned: boolean };
export type SessionLifecycleOperation = {
  operationId: string;
  kind: "create" | "delete";
  input: unknown;
  preparedSession?: CreateSessionInput;
  transitioned?: boolean;
  targets: SessionLifecycleTarget[];
  resources: SessionLifecycleResource[];
  phase: "preparing" | "applied" | "complete";
  createdAt: string;
  updatedAt: string;
};

export function canonicalSessionLifecycleInput(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input)
      .filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalize(child)]));
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

export function assertSessionLifecycleReady(db: DatabaseSync, sessionId: string): void {
  const pending = db.prepare(`SELECT 1 FROM session_lifecycle_operations_v6 operation, json_each(operation.targets_json) target
    WHERE operation.kind = 'create' AND operation.phase <> 'complete' AND json_extract(target.value, '$.id') = ? LIMIT 1`).get(sessionId);
  if (pending) throw new Error("The Session's required initialization is not complete.");
}

export function readSessionLifecycleOperation(db: DatabaseSync, operationId: string): SessionLifecycleOperation | null {
  const row = db.prepare("SELECT * FROM session_lifecycle_operations_v6 WHERE operation_id = ?").get(operationId) as {
    operation_id: string; kind: "create" | "delete"; input_json: string; targets_json: string; resources_json: string;
    phase: SessionLifecycleOperation["phase"]; created_at: string; updated_at: string; prepared_json: string | null;
  } | undefined;
  return row ? { operationId: row.operation_id, kind: row.kind, input: JSON.parse(row.input_json), targets: JSON.parse(row.targets_json),
    resources: JSON.parse(row.resources_json), ...(row.prepared_json ? { preparedSession: JSON.parse(row.prepared_json) } : {}), phase: row.phase, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function beginSessionLifecycleOperation(db: DatabaseSync, input: Pick<SessionLifecycleOperation, "operationId" | "kind" | "input" | "targets"> & { resources?: SessionLifecycleResource[] }): SessionLifecycleOperation {
  if (!input.operationId.trim() || input.targets.length === 0) throw new Error("A lifecycle operation requires an identity and fixed targets.");
  const current = readSessionLifecycleOperation(db, input.operationId);
  if (current) {
    if (current.kind !== input.kind || canonicalSessionLifecycleInput(current.input) !== canonicalSessionLifecycleInput(input.input)) throw new Error("The lifecycle operation key is already associated with different input.");
    return current;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO session_lifecycle_operations_v6(operation_id,kind,input_json,targets_json,resources_json,phase,created_at,updated_at)
    VALUES(?,?,?,?,?,'preparing',?,?)`).run(input.operationId, input.kind, canonicalSessionLifecycleInput(input.input), JSON.stringify(input.targets), JSON.stringify(input.resources ?? []), now, now);
  return readSessionLifecycleOperation(db, input.operationId)!;
}
