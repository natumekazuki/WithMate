import type { DatabaseSync } from "node:sqlite";

export function insertStandaloneRoleBindingsForSessions(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO session_role_bindings_v6 (
      session_id,
      session_role,
      role_contract_revision,
      root_session_id,
      parent_session_id,
      delegation_depth
    )
    SELECT id, 'standalone', 1, id, NULL, 0
    FROM sessions_v6
    WHERE session_kind = 'default'
      AND id NOT IN (SELECT session_id FROM session_role_bindings_v6)
  `);
}
