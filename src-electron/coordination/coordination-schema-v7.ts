import type { DatabaseSync } from "node:sqlite";

/** Crew に所属する相談のテーブルと、Crew や回答担当ごとの状態照会に使う索引を定義する。 */
export const CREATE_V7_COORDINATION_RECORDS_SQL = `CREATE TABLE IF NOT EXISTS coordination_records_v7 (
    id TEXT PRIMARY KEY, crew_root_session_id TEXT NOT NULL REFERENCES sessions_v6(id) ON DELETE CASCADE,
    initiator_session_id TEXT NOT NULL, initiator_kind TEXT NOT NULL, initiator_incarnation_id TEXT NOT NULL,
    respondent_session_id TEXT, respondent_kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','resolved','withdrawn','corrected')), payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
  );
  CREATE INDEX IF NOT EXISTS idx_coordination_v7_crew ON coordination_records_v7(crew_root_session_id,state);
  CREATE INDEX IF NOT EXISTS idx_coordination_v7_respondent ON coordination_records_v7(respondent_session_id,state);`;
/** 既存の相談行を変更せず、不足するテーブルと索引だけを作成する。 */
export function ensureCoordinationSchemaV7(db: DatabaseSync): void {
  db.exec(CREATE_V7_COORDINATION_RECORDS_SQL);
}

/** 指定 Session が起票者または回答担当である未解決の相談を、操作の阻害理由として返す。 */
export function listCrewCoordinationBlockers(
  db: DatabaseSync,
  targets: Array<{ id: string; kind: "main" | "auxiliary" }>,
): Array<{ id: string; reason: string }> {
  if (!targets.length) return [];
  const predicates = targets
    .map(
      () =>
        "(initiator_session_id=? AND initiator_kind=? OR respondent_session_id=? AND respondent_kind=?)",
    )
    .join(" OR ");
  return (
    db
      .prepare(
        `SELECT id FROM coordination_records_v7 WHERE state='open' AND
    (${predicates})`,
      )
      .all(
        ...targets.flatMap((target) => [
          target.id,
          target.kind,
          target.id,
          target.kind,
        ]),
      ) as Array<{ id: string }>
  ).map(({ id }) => ({ id, reason: "未対応のCoordinationがあります。" }));
}
