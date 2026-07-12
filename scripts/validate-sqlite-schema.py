from __future__ import annotations

import json
import hashlib
import sqlite3
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DDL_PATH = ROOT / "schema" / "sqlite" / "v1.sql"
MANIFEST_PATH = ROOT / "schema" / "sqlite" / "manifest-v1.json"


def expect_integrity_error(connection: sqlite3.Connection, sql: str, params: tuple[object, ...]) -> None:
    try:
        connection.execute(sql, params)
    except sqlite3.IntegrityError:
        connection.rollback()
        return
    connection.rollback()
    raise AssertionError(f"expected sqlite3.IntegrityError: {sql}")


def expect_commit_integrity_error(
    connection: sqlite3.Connection, sql: str, params: tuple[object, ...]
) -> None:
    try:
        connection.execute(sql, params)
        connection.commit()
    except sqlite3.IntegrityError:
        connection.rollback()
        return
    connection.rollback()
    raise AssertionError(f"expected sqlite3.IntegrityError at commit: {sql}")


def schema_definition_sha256(connection: sqlite3.Connection) -> str:
    rows = connection.execute(
        """
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
        ORDER BY type, name
        """
    ).fetchall()
    normalized = [
        {
            "type": kind,
            "name": name,
            "table": table,
            "sql": " ".join(sql.split()) if sql is not None else None,
        }
        for kind, name, table, sql in rows
    ]
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def insert_session(connection: sqlite3.Connection, session_id: str) -> None:
    connection.execute(
        """
        INSERT INTO sessions (
          id, provider_id, workspace_key, allowed_additional_directories_json,
          default_character_id, max_concurrent_child_runs, lifecycle_status,
          created_at, updated_at, last_activity_at
        ) VALUES (?, 'codex', 'workspace', '[]', 'character', 4, 'active', 1, 1, 1)
        """,
        (session_id,),
    )


def insert_message(connection: sqlite3.Connection, message_id: str, session_id: str, ordinal: int) -> None:
    connection.execute(
        """
        INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at)
        VALUES (?, ?, ?, 'user', '[{"type":"text","text":"test"}]', 1)
        """,
        (message_id, session_id, ordinal),
    )


def run_validation(database_path: Path) -> dict[str, object]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ddl = DDL_PATH.read_text(encoding="utf-8")
    connection = sqlite3.connect(database_path)
    try:
        return validate_connection(connection, manifest, ddl)
    finally:
        connection.close()


def validate_connection(
    connection: sqlite3.Connection, manifest: dict[str, object], ddl: str
) -> dict[str, object]:
    connection.executescript(ddl)

    application_id = connection.execute("PRAGMA application_id").fetchone()[0]
    user_version = connection.execute("PRAGMA user_version").fetchone()[0]
    journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    auto_vacuum = connection.execute("PRAGMA auto_vacuum").fetchone()[0]
    encoding = connection.execute("PRAGMA encoding").fetchone()[0]
    foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
    secure_delete = connection.execute("PRAGMA secure_delete").fetchone()[0]
    busy_timeout = connection.execute("PRAGMA busy_timeout").fetchone()[0]
    wal_autocheckpoint = connection.execute("PRAGMA wal_autocheckpoint").fetchone()[0]
    journal_size_limit = connection.execute("PRAGMA journal_size_limit").fetchone()[0]
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]

    schema_rows = connection.execute(
        """
        SELECT type, name
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
        ORDER BY type, name
        """
    ).fetchall()
    actual_tables = sorted(name for kind, name in schema_rows if kind == "table")
    actual_indexes = sorted(name for kind, name in schema_rows if kind == "index")
    actual_triggers = sorted(name for kind, name in schema_rows if kind == "trigger")
    actual_schema_definition_sha256 = schema_definition_sha256(connection)
    unique_constraint_autoindexes = [
        f"{table}.{row[1]}"
        for table in actual_tables
        for row in connection.execute(f'PRAGMA index_list("{table}")').fetchall()
        if row[3] == "u"
    ]

    assert application_id == manifest["applicationId"]
    assert user_version == manifest["schemaVersion"]
    assert journal_mode == "wal"
    assert auto_vacuum == 2
    assert encoding == "UTF-8"
    assert foreign_keys == 1
    assert secure_delete == 2
    assert busy_timeout == 5000
    assert wal_autocheckpoint == 256
    assert journal_size_limit == 67108864
    assert foreign_key_violations == []
    assert quick_check == "ok"
    assert set(actual_tables) == set(manifest["tables"])
    assert set(actual_indexes) == set(manifest["indexes"]), {
        "missingFromManifest": sorted(set(actual_indexes) - set(manifest["indexes"])),
        "missingFromDatabase": sorted(set(manifest["indexes"]) - set(actual_indexes)),
    }
    assert set(actual_triggers) == set(manifest["triggers"])
    assert actual_schema_definition_sha256 == manifest["schemaDefinitionSha256"]
    assert unique_constraint_autoindexes == []

    connection.execute("CREATE INDEX schema_drift_probe_idx ON sessions(created_at)")
    assert schema_definition_sha256(connection) != manifest["schemaDefinitionSha256"]
    connection.execute("DROP INDEX schema_drift_probe_idx")
    assert schema_definition_sha256(connection) == manifest["schemaDefinitionSha256"]

    insert_session(connection, "session-a")
    insert_session(connection, "session-b")
    insert_session(connection, "session-c")
    insert_message(connection, "message-a", "session-a", 1)
    insert_message(connection, "message-b", "session-b", 1)
    connection.execute(
        """
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase,
          execution_snapshot_json, external_side_effect_state,
          created_at, updated_at, version
        ) VALUES ('run-a', 'session-a', 1, 'message-a', 'queued', '{}', 'none', 1, 1, 0)
        """
    )
    connection.commit()

    expect_integrity_error(
        connection,
        """
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase,
          execution_snapshot_json, external_side_effect_state,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 'queued', '{}', 'none', 1, 1, 0)
        """,
        ("run-cross-session", "session-a", 2, "message-b"),
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase,
          execution_snapshot_json, external_side_effect_state,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 'active', '{}', 'none', 1, 1, 0)
        """,
        ("run-second-active", "session-a", 2, "message-a"),
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO run_output_items (
          id, run_id, ordinal, category, kind, summary, completion_state,
          payload_state, payload_original_byte_length, redaction_state, created_at
        ) VALUES (?, ?, 1, 'diagnostic', 'test', '', 'complete', 'stored', 1, 'unknown', 1)
        """,
        ("output-invalid-redaction", "run-a"),
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO run_dispatches (
          run_attempt_id, dispatch_state, request_fingerprint, created_at
        ) VALUES ('missing-attempt', 'pending', ?, 1)
        """,
        ("a" * 64,),
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO runs (
          id, session_id, ordinal, initiating_message_id, phase,
          execution_snapshot_json, external_side_effect_state,
          created_at, terminal_at, updated_at, version
        ) VALUES ('run-invalid-terminal', 'session-b', 1, 'message-b', 'active',
          '{}', 'none', 1, 2, 2, 0)
        """,
        (),
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO session_relations (
          id, parent_session_id, child_session_id, orchestration_root_session_id,
          created_by_parent_run_id, correlation_id, created_at
        ) VALUES ('relation-cross-session', 'session-b', 'session-c', 'session-b',
          'run-a', 'correlation-cross-session', 1)
        """,
        (),
    )

    expect_integrity_error(
        connection,
        """
        INSERT INTO idempotency_records (
          idempotency_key, scope_session_id, operation, request_fingerprint,
          record_state, created_at
        ) VALUES (?, 'session-a', 'run.start', ?, 'in_progress', 1)
        """,
        ("x" * 36, "a" * 64),
    )
    connection.execute(
        """
        INSERT INTO idempotency_records (
          idempotency_key, scope_session_id, operation, request_fingerprint,
          record_state, created_at
        ) VALUES (?, 'session-a', 'run.start', ?, 'in_progress', 1)
        """,
        ("00000000-0000-0000-0000-000000000001", "a" * 64),
    )
    connection.commit()

    expect_commit_integrity_error(
        connection,
        """
        INSERT INTO run_output_items (
          id, run_id, ordinal, category, kind, summary, completion_state,
          payload_state, payload_original_byte_length, stored_payload_id,
          redaction_state, created_at
        ) VALUES ('output-a', 'run-a', 1, 'diagnostic', 'test', '', 'complete',
          'stored', 3, 'output-a', 'not_required', 1)
        """,
        (),
    )

    connection.execute(
        """
        INSERT INTO run_output_items (
          id, run_id, ordinal, category, kind, summary, completion_state,
          payload_state, payload_original_byte_length, stored_payload_id,
          redaction_state, created_at
        ) VALUES ('output-a', 'run-a', 1, 'diagnostic', 'test', '', 'complete',
          'stored', 3, 'output-a', 'not_required', 1)
        """
    )
    expect_integrity_error(
        connection,
        """
        INSERT INTO run_output_payloads (
          output_item_id, payload_format, content, byte_length, content_sha256, created_at
        ) VALUES ('output-a', 'text', ?, 2, ?, 1)
        """,
        (b"abc", "a" * 64),
    )

    connection.execute(
        """
        INSERT INTO run_output_items (
          id, run_id, ordinal, category, kind, summary, completion_state,
          payload_state, payload_original_byte_length, stored_payload_id,
          redaction_state, created_at
        ) VALUES ('output-a', 'run-a', 1, 'diagnostic', 'test', '', 'complete',
          'stored', 3, 'output-a', 'not_required', 1)
        """
    )
    connection.execute(
        """
        INSERT INTO run_output_payloads (
          output_item_id, payload_format, content, byte_length, content_sha256, created_at
        ) VALUES ('output-a', 'text', ?, 3, ?, 1)
        """,
        (b"abc", hashlib.sha256(b"abc").hexdigest()),
    )
    connection.commit()

    connection.execute(
        """
        INSERT INTO run_attempts (
          id, run_id, ordinal, attempt_reason, attempt_state, created_at
        ) VALUES ('attempt-a', 'run-a', 1, 'initial', 'preparing', 1)
        """
    )
    connection.execute(
        """
        INSERT INTO provider_bindings (
          id, session_id, ordinal, provider_id, persistence_mode, binding_state,
          created_by_run_attempt_id, created_at
        ) VALUES ('binding-a', 'session-a', 1, 'codex', 'persistent', 'creating', 'attempt-a', 1)
        """
    )
    connection.execute(
        "UPDATE run_attempts SET provider_binding_id = 'binding-a' WHERE id = 'attempt-a'"
    )
    connection.commit()
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []

    return {
        "applicationId": application_id,
        "schemaVersion": user_version,
        "journalMode": journal_mode,
        "autoVacuum": "incremental",
        "encoding": encoding,
        "foreignKeys": "on",
        "secureDelete": "fast",
        "busyTimeout": busy_timeout,
        "walAutocheckpoint": wal_autocheckpoint,
        "journalSizeLimit": journal_size_limit,
        "tableCount": len(actual_tables),
        "indexCount": len(actual_indexes),
        "schemaDefinitionSha256": actual_schema_definition_sha256,
        "schemaDriftDetectionCheck": "ok",
        "duplicateUniqueAutoindexCheck": "ok",
        "foreignKeyCheck": "ok",
        "quickCheck": quick_check,
        "constraintRejectionChecks": 9,
        "canonicalUuidAcceptanceCheck": "ok",
        "storedPayloadAtomicityCheck": "ok",
        "deferredForeignKeyCycleCheck": "ok",
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="withmate-schema-") as directory:
        result = run_validation(Path(directory) / "withmate-v4.db")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
