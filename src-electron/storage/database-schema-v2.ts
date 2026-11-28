import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import { openAppDatabaseReadOnly } from "./sqlite-connection.js";

/** V1と別ファイルへ移行したV2 DBのファイル名。 */
export const APP_DATABASE_V2_FILENAME = "withmate-v2.db";
/** V2の作成時と判定時に用いるSQLiteのユーザー版番号。 */
export const APP_DATABASE_V2_SCHEMA_VERSION = 2;

/** V2のスキーマ定義に付随する設計ステータス。 */
export const V2_SCHEMA_STATUS = "ready-for-implementation";

/** 版番号が未設定のDBをV2と認めるために必要な、分離済みの会話テーブル。 */
export const REQUIRED_V2_TABLES = [
  "sessions",
  "session_messages",
  "session_message_artifacts",
] as const;

/** ファイル名と版番号でV2を識別する。版番号が未設定なら会話テーブル構成で判定し、読み取りに失敗したDBは対象外とする。 */
export function isValidV2Database(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V2_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = openAppDatabaseReadOnly(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    if (row?.user_version === APP_DATABASE_V2_SCHEMA_VERSION) {
      return true;
    }
    if (row?.user_version !== 0) {
      return false;
    }

    const existingTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .all() as Array<{ name?: unknown }>
      )
        .map((table) => table.name)
        .filter((name): name is string => typeof name === "string"),
    );
    return REQUIRED_V2_TABLES.every((tableName) =>
      existingTables.has(tableName),
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** 文字列内の単一引用符を二重化し、DDLの既定値として埋め込める形にする。 */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 一覧用ヘッダーと詳細の分離、および旧MemoryGeneration・独り言の除外を示すV2の設計メモ。 */
export const V2_SCHEMA_DESIGN_NOTES = [
  "V2 は withmate-v2.db を正本にし、V1 withmate.db からの移行は別スクリプトで行う。",
  "V2 では MemoryGeneration / Monologue legacy table を正本 schema に含めない。",
  "V2 では session 一覧用 header と message/detail payload を分離する。",
  "V2 では UI 一覧・ページングに効く単位を row 化し、raw debug payload は必要最小限だけ detail blob に残す。",
  "V1 sessions.stream_json は独り言 legacy 表現のため V2 正本 schema と migration 対象から除外する。",
] as const;

/** アプリ共通設定の値と更新時刻をキー単位で保持するV2のDDL。 */
export const CREATE_V2_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** 会話本文とは別に一覧用のSession情報と件数を保持し、活動順・workspace・Characterでの検索を支えるV2のDDL。 */
export const CREATE_V2_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task_title TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL DEFAULT ${1},
    workspace_label TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    session_kind TEXT NOT NULL DEFAULT 'default',
    character_id TEXT NOT NULL,
    character_name TEXT NOT NULL,
    character_icon_path TEXT NOT NULL,
    character_theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    character_theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    run_state TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    codex_sandbox_mode TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CODEX_SANDBOX_MODE)},
    model TEXT NOT NULL DEFAULT ${sqlStringLiteral("gpt-5.4")},
    reasoning_effort TEXT NOT NULL DEFAULT ${sqlStringLiteral("high")},
    custom_agent_name TEXT NOT NULL DEFAULT '',
    allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v2_sessions_last_active
    ON sessions(last_active_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v2_sessions_workspace
    ON sessions(workspace_path, last_active_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v2_sessions_character
    ON sessions(character_id, last_active_at DESC);
`;

/** Session内順序を一意にし、本文・Bookmark・詳細有無を行単位で保持するV2のDDL。 */
export const CREATE_V2_SESSION_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL DEFAULT '',
    accent INTEGER NOT NULL DEFAULT 0,
    is_bookmarked INTEGER NOT NULL DEFAULT 0,
    artifact_available INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_seq
    ON session_messages(session_id, seq);

  CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_id_desc
    ON session_messages(session_id, id DESC);
`;

/** メッセージの詳細JSONを本文から分離し、本文の削除時に連動して削除するV2のDDL。 */
export const CREATE_V2_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_message_artifacts (
    message_id INTEGER PRIMARY KEY,
    artifact_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (message_id) REFERENCES session_messages(id) ON DELETE CASCADE
  );
`;

/** V1から継続する版付きモデル一覧と、版に従属するプロバイダー・モデルのV2のDDL。 */
export const CREATE_V2_MODEL_CATALOG_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS model_catalog_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS model_catalog_providers (
    revision INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    label TEXT NOT NULL,
    default_model_id TEXT NOT NULL,
    default_reasoning_effort TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (revision, provider_id),
    FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_catalog_models (
    revision INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    label TEXT NOT NULL,
    reasoning_efforts_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (revision, provider_id, model_id),
    FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
  );
`;

/** V2の版番号設定と作成SQLを参照先のテーブルから順に並べる。 */
export const CREATE_V2_SCHEMA_SQL = [
  `PRAGMA user_version = ${APP_DATABASE_V2_SCHEMA_VERSION};`,
  CREATE_V2_APP_SETTINGS_TABLE_SQL,
  CREATE_V2_SESSIONS_TABLE_SQL,
  CREATE_V2_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V2_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL,
  CREATE_V2_MODEL_CATALOG_TABLES_SQL,
] as const;

/** 会話本文や詳細を結合せずにSession概要を取得するための列一覧。 */
export const V2_SESSION_SUMMARY_COLUMNS = [
  "id",
  "task_title",
  "status",
  "updated_at",
  "provider",
  "catalog_revision",
  "workspace_label",
  "workspace_path",
  "branch",
  "session_kind",
  "character_id",
  "character_name",
  "character_icon_path",
  "character_theme_main",
  "character_theme_sub",
  "run_state",
  "approval_mode",
  "codex_sandbox_mode",
  "model",
  "reasoning_effort",
  "custom_agent_name",
  "allowed_additional_directories_json",
  "thread_id",
  "message_count",
] as const;
