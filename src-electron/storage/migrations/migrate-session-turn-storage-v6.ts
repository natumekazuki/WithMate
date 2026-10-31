import type { DatabaseSync } from "node:sqlite";

type LegacyTurn = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  provider_id: string;
  metadata_json: string;
  metadata_type: string;
  created_at: string;
};

export function migrateLegacySessionTurnsV6(db: DatabaseSync): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'audit_events_v6'",
      )
      .get()
  )
    return;
  const columns = db
    .prepare("PRAGMA table_info(audit_events_v6)")
    .all() as Array<{ name: string }>;
  const auxiliaryColumn = columns.some(
    ({ name }) => name === "auxiliary_session_id",
  )
    ? "auxiliary_session_id"
    : "NULL AS auxiliary_session_id";
  const rows = db
    .prepare(
      `
    SELECT id, session_id, ${auxiliaryColumn}, provider_id, created_at,
      json_type(metadata_json) AS metadata_type,
      json_object(
        'phase', json_extract(metadata_json, '$.phase'),
        'provider', json_extract(metadata_json, '$.provider'),
        'model', json_extract(metadata_json, '$.model'),
        'reasoningEffort', json_extract(metadata_json, '$.reasoningEffort'),
        'approvalMode', json_extract(metadata_json, '$.approvalMode'),
        'sandboxMode', json_extract(metadata_json, '$.sandboxMode'),
        'userMessageSeq', json_extract(metadata_json, '$.userMessageSeq'),
        'assistantMessageSeq', json_extract(metadata_json, '$.assistantMessageSeq'),
        'assistantText', json_extract(metadata_json, '$.assistantText'),
        'threadId', json_extract(metadata_json, '$.threadId'),
        'errorMessage', json_extract(metadata_json, '$.errorMessage')
      ) AS metadata_json
    FROM audit_events_v6 WHERE event_type = 'session_turn'
      AND NOT EXISTS (SELECT 1 FROM session_turns_v6 WHERE session_turns_v6.id = audit_events_v6.id)
    ORDER BY id
  `,
    )
    .iterate() as IterableIterator<LegacyTurn>;
  const insert = db.prepare(`
    INSERT INTO session_turns_v6 (
      id, session_id, auxiliary_session_id, phase, provider_id, model_id, reasoning_effort,
      approval_mode, sandbox_mode, user_message_seq, assistant_message_seq, thread_id,
      error_summary, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    if (!row.session_id && !row.auxiliary_session_id) continue;
    if (row.session_id && row.auxiliary_session_id)
      throw new Error(`Session turn has conflicting owners: ${row.id}`);
    const ownerTable = row.session_id ? "sessions_v6" : "auxiliary_sessions";
    if (
      !db
        .prepare(`SELECT 1 FROM ${ownerTable} WHERE id = ?`)
        .get(row.session_id ?? row.auxiliary_session_id)
    )
      continue;
    if (row.metadata_type !== "object") throw new Error(`Invalid session turn metadata: ${row.id}`);
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error(`Invalid session turn metadata: ${row.id}`);
    const value = metadata as Record<string, unknown>;
    const text = (key: string): string =>
      typeof value[key] === "string" ? (value[key] as string) : "";
    const phaseValue = text("phase").replace(/^background-/, "");
    const phase = ["running", "completed", "failed", "canceled"].includes(
      phaseValue,
    )
      ? phaseValue
      : "running";
    const seq = (key: string): number | null =>
      typeof value[key] === "number" &&
      Number.isInteger(value[key]) &&
      (value[key] as number) >= 0
        ? (value[key] as number)
        : null;
    let assistantSeq = seq("assistantMessageSeq");
    if (
      assistantSeq === null &&
      phase === "completed" &&
      text("assistantText").trim()
    ) {
      const table = row.session_id
        ? "session_messages_v6"
        : "auxiliary_session_messages";
      const ownerColumn = row.session_id
        ? "session_id"
        : "auxiliary_session_id";
      const matches = db
        .prepare(
          `SELECT seq FROM ${table} WHERE ${ownerColumn} = ? AND role = 'assistant' AND body = ?`,
        )
        .all(
          row.session_id ?? row.auxiliary_session_id,
          text("assistantText"),
        ) as Array<{ seq: number }>;
      if (matches.length === 1) assistantSeq = matches[0]!.seq;
    }
    insert.run(
      row.id,
      row.session_id,
      row.auxiliary_session_id,
      phase,
      text("provider") || row.provider_id,
      text("model"),
      text("reasoningEffort"),
      text("approvalMode"),
      text("sandboxMode"),
      seq("userMessageSeq"),
      assistantSeq,
      text("threadId"),
      text("errorMessage"),
      row.created_at,
      phase === "running" ? null : row.created_at,
      row.created_at,
    );
  }
}
