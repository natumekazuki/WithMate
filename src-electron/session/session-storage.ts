import type { DatabaseSync } from "node:sqlite";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  normalizeHomeSessionSummary,
  normalizeSession,
  normalizeSessionSummary,
  type MessageArtifact,
  type HomeSessionSummary,
  type Session,
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type HomeSessionSummaryPageResult,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import { normalizeProviderId } from "../../src-shared/settings/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../../src-shared/character/character-runtime-snapshot.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import {
  CREATE_SESSIONS_TABLE_SQL,
  LEGACY_SESSION_COLUMN_DEFINITIONS,
} from "../storage/database-schema-v1.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../../src-shared/window/withmate-window-types.js";
import { SessionIdCollisionError } from "./session-storage-errors.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClauseForColumns,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";

/** 旧形式の一行で保持する Session。表示・実行条件と JSON の履歴、ストリーム、キャラクター定義を含む。 */
type SessionRow = {
  id: string;
  task_title: string;
  status: string;
  updated_at: string;
  provider: string;
  catalog_revision: number;
  workspace_label: string;
  workspace_path: string;
  branch: string;
  session_kind: string;
  access_mode: string;
  source_schema_version: number;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  character_runtime_snapshot_json: string;
  run_state: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  allowed_additional_directories_json: string;
  thread_id: string;
  messages_json: string;
  stream_json: string;
  last_active_at: string | number;
};

/** 削除候補などの ID だけを問い合わせた結果。 */
type SessionIdRow = {
  id: string;
};

/** 履歴・ストリーム・実行時キャラクター定義を取得しない旧形式の要約行。 */
type SessionSummaryRow = Omit<
  SessionRow,
  "character_runtime_snapshot_json" | "messages_json" | "stream_json"
>;

/** Home 一覧に必要な表示情報と活動順。元スキーマと利用可否も保つ。 */
type HomeSessionSummaryRow = {
  id: string;
  task_title: string;
  status: string;
  updated_at: string;
  workspace_label: string;
  workspace_path: string;
  session_kind: string;
  access_mode: string;
  source_schema_version: number;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  run_state: string;
  is_pinned: number;
  last_active_at: string | number;
};

/** 旧テーブルで既に存在する列名を確認するための SQLite の情報行。 */
type TableColumnRow = {
  name: string;
};

const SESSION_SELECT_COLUMNS = `
  id,
  task_title,
  status,
  updated_at,
  provider,
  catalog_revision,
  workspace_label,
  workspace_path,
  branch,
  session_kind,
  access_mode,
  source_schema_version,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  character_runtime_snapshot_json,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id,
  messages_json,
  stream_json
`;

const LIST_SESSIONS_SQL = `
  SELECT
    ${SESSION_SELECT_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const SESSION_SUMMARY_SELECT_COLUMNS = `
  id,
  task_title,
  status,
  updated_at,
  provider,
  catalog_revision,
  workspace_label,
  workspace_path,
  branch,
  session_kind,
  access_mode,
  source_schema_version,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id
`;

const HOME_SESSION_SUMMARY_SELECT_COLUMNS = `
  id,
  task_title,
  status,
  updated_at,
  workspace_label,
  workspace_path,
  session_kind,
  access_mode,
  source_schema_version,
  character_id,
  character_name,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  run_state,
  0 AS is_pinned
`;

const LIST_SESSION_SUMMARIES_SQL = `
  SELECT
    ${SESSION_SUMMARY_SELECT_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL = `
  SELECT
    ${SESSION_SUMMARY_SELECT_COLUMNS}
  FROM sessions
  WHERE ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(provider) = ?
  ORDER BY last_active_at DESC, id DESC
  LIMIT 1
`;

const GET_SESSION_SQL = `
  SELECT
    ${SESSION_SELECT_COLUMNS}
  FROM sessions
  WHERE id = ?
`;

const INSERT_SESSION_SQL = `
  INSERT INTO sessions (
    id,
    task_title,
    status,
    updated_at,
    provider,
    catalog_revision,
    workspace_label,
    workspace_path,
    branch,
    session_kind,
    access_mode,
    source_schema_version,
    character_id,
    character_name,
    character_icon_path,
    character_theme_main,
    character_theme_sub,
    character_runtime_snapshot_json,
    run_state,
    approval_mode,
    codex_sandbox_mode,
    model,
    reasoning_effort,
    custom_agent_name,
    allowed_additional_directories_json,
    thread_id,
    messages_json,
    stream_json,
    last_active_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const CREATE_SESSION_SQL = `
  ${INSERT_SESSION_SQL}
  ON CONFLICT(id) DO NOTHING
`;

const UPSERT_SESSION_SQL = `
  ${INSERT_SESSION_SQL}
  ON CONFLICT(id) DO UPDATE SET
    task_title = excluded.task_title,
    status = excluded.status,
    updated_at = excluded.updated_at,
    provider = excluded.provider,
    catalog_revision = excluded.catalog_revision,
    workspace_label = excluded.workspace_label,
    workspace_path = excluded.workspace_path,
    branch = excluded.branch,
    session_kind = excluded.session_kind,
    access_mode = excluded.access_mode,
    source_schema_version = excluded.source_schema_version,
    character_id = excluded.character_id,
    character_name = excluded.character_name,
    character_icon_path = excluded.character_icon_path,
    character_theme_main = excluded.character_theme_main,
    character_theme_sub = excluded.character_theme_sub,
    character_runtime_snapshot_json = excluded.character_runtime_snapshot_json,
    run_state = excluded.run_state,
    approval_mode = excluded.approval_mode,
    codex_sandbox_mode = excluded.codex_sandbox_mode,
    model = excluded.model,
    reasoning_effort = excluded.reasoning_effort,
    custom_agent_name = excluded.custom_agent_name,
    allowed_additional_directories_json = excluded.allowed_additional_directories_json,
    thread_id = excluded.thread_id,
    messages_json = excluded.messages_json,
    stream_json = excluded.stream_json,
    last_active_at = excluded.last_active_at
`;

const LIST_SESSION_IDS_LAST_ACTIVE_BEFORE_SQL = `
  SELECT id
  FROM sessions
  WHERE last_active_at < ?
  ORDER BY last_active_at ASC, id ASC
`;

const AUXILIARY_SESSIONS_TABLE_NAME = "auxiliary_sessions";

/** 不正な保存行を一覧から除くか、個別取得の失敗として例外にするかを指定する。 */
type SessionRowParseMode = "skip" | "throw";

/** 旧テーブルの指定 JSON 列を読み、壊れている場合は列と Session を記録して選択された方針に従う。 */
function parseSessionJson<T>(
  row: SessionRow,
  columnName: keyof Pick<
    SessionRow,
    "allowed_additional_directories_json" | "messages_json" | "stream_json"
  >,
  mode: SessionRowParseMode,
): T | null {
  try {
    return JSON.parse(row[columnName]) as T;
  } catch (error) {
    console.error("stored session JSON parse failed", {
      sessionId: row.id,
      columnName,
      error,
    });
    if (mode === "throw") {
      throw new Error(
        `保存済み session ${row.id} の ${columnName} が壊れているよ。`,
      );
    }
    return null;
  }
}

/** 保存行から履歴・ストリームを含む Session を復元する。壊れた必須データを空で補わない。 */
function rowToSession(
  row: SessionRow,
  mode: SessionRowParseMode = "skip",
): Session | null {
  const allowedAdditionalDirectories = parseSessionJson<string[]>(
    row,
    "allowed_additional_directories_json",
    mode,
  );
  const messages = parseSessionJson<Session["messages"]>(
    row,
    "messages_json",
    mode,
  );
  const stream = parseSessionJson<Session["stream"]>(row, "stream_json", mode);
  if (!allowedAdditionalDirectories || !messages || !stream) {
    return null;
  }

  const session = normalizeSession({
    id: row.id,
    taskTitle: row.task_title,
    status: row.status,
    updatedAt: row.updated_at,
    provider: row.provider,
    catalogRevision: row.catalog_revision,
    workspaceLabel: row.workspace_label,
    workspacePath: row.workspace_path,
    branch: row.branch,
    sessionKind: row.session_kind,
    accessMode: row.access_mode,
    sourceSchemaVersion: row.source_schema_version,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    characterRuntimeSnapshot: parseCharacterRuntimeSnapshotJson(
      row.character_runtime_snapshot_json,
    ),
    runState: row.run_state,
    approvalMode: row.approval_mode,
    codexSandboxMode: row.codex_sandbox_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories,
    threadId: row.thread_id,
    messages,
    stream,
  });
  if (!session) {
    console.error("stored session normalization failed", { sessionId: row.id });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} が壊れているよ。`);
    }
  }

  return session;
}

/** 履歴を読まずに旧形式からモデル・表示・実行条件を含む要約を正規化する。 */
function rowToSessionSummary(
  row: SessionSummaryRow,
  mode: SessionRowParseMode = "skip",
): SessionSummary | null {
  const allowedAdditionalDirectories = parseSessionJson<string[]>(
    row as SessionRow,
    "allowed_additional_directories_json",
    mode,
  );
  if (!allowedAdditionalDirectories) {
    return null;
  }

  const summary = normalizeSessionSummary({
    id: row.id,
    taskTitle: row.task_title,
    status: row.status,
    updatedAt: row.updated_at,
    provider: row.provider,
    catalogRevision: row.catalog_revision,
    workspaceLabel: row.workspace_label,
    workspacePath: row.workspace_path,
    branch: row.branch,
    sessionKind: row.session_kind,
    accessMode: row.access_mode,
    sourceSchemaVersion: row.source_schema_version,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    runState: row.run_state,
    approvalMode: row.approval_mode,
    codexSandboxMode: row.codex_sandbox_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    customAgentName: row.custom_agent_name,
    allowedAdditionalDirectories,
    threadId: row.thread_id,
  });
  if (!summary) {
    console.error("stored session summary normalization failed", {
      sessionId: row.id,
    });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} の summary が壊れているよ。`);
    }
  }

  return summary;
}

/** 旧形式の表示列だけを Home 用の要約に変換し、読み取り可否とデータの由来を保つ。 */
function rowToHomeSessionSummary(
  row: HomeSessionSummaryRow,
): HomeSessionSummary | null {
  return normalizeHomeSessionSummary({
    id: row.id,
    taskTitle: row.task_title,
    status: row.status,
    updatedAt: row.updated_at,
    isPinned: row.is_pinned === 1,
    workspaceLabel: row.workspace_label,
    workspacePath: row.workspace_path,
    sessionKind: row.session_kind,
    accessMode: row.access_mode,
    sourceSchemaVersion: row.source_schema_version,
    characterId: row.character_id,
    character: row.character_name,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    runState: row.run_state,
  });
}

/** 旧形式の SQLite Session を取り扱う。本文・ストリームと成果物は Session 行の JSON に格納する。 */
export class SessionStorage {
  private readonly db: DatabaseSync;

  /** 接続を開き、旧 Session テーブルと不足している互換列を使用できるよう整える。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    registerSessionProviderIdNormalizer(this.db);

    this.db.exec(CREATE_SESSIONS_TABLE_SQL);
    this.ensureSchema();
  }

  /** 正規化済みの Session を JSON 列とともに保存する。新規作成で同じ ID がある場合は衝突として拒否する。 */
  private writeSession(
    normalized: Session,
    lastActiveAt: number,
    operation: "create" | "upsert",
  ): void {
    const result = this.db
      .prepare(operation === "create" ? CREATE_SESSION_SQL : UPSERT_SESSION_SQL)
      .run(
        normalized.id,
        normalized.taskTitle,
        normalized.status,
        normalized.updatedAt,
        normalized.provider,
        normalized.catalogRevision,
        normalized.workspaceLabel,
        normalized.workspacePath,
        normalized.branch,
        normalized.sessionKind,
        normalized.accessMode,
        normalized.sourceSchemaVersion,
        normalized.characterId,
        normalized.character,
        normalized.characterIconPath,
        normalized.characterThemeColors.main,
        normalized.characterThemeColors.sub,
        stringifyCharacterRuntimeSnapshot(normalized.characterRuntimeSnapshot),
        normalized.runState,
        normalized.approvalMode,
        normalized.codexSandboxMode,
        normalized.model,
        normalized.reasoningEffort,
        normalized.customAgentName,
        JSON.stringify(normalized.allowedAdditionalDirectories),
        normalized.threadId,
        JSON.stringify(normalized.messages),
        JSON.stringify(normalized.stream),
        lastActiveAt,
      );
    if (operation === "create" && Number(result.changes) === 0) {
      throw new SessionIdCollisionError(normalized.id);
    }
  }

  /** 既存行を保持しながら、旧テーブルに不足する列だけを所定の既定値とともに追加する。 */
  private ensureSchema(): void {
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(sessions)").all() as TableColumnRow[]
      ).map((column) => column.name),
    );

    if (!columns.has("model")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN model ${LEGACY_SESSION_COLUMN_DEFINITIONS.model};`,
      );
    }

    if (!columns.has("reasoning_effort")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN reasoning_effort ${LEGACY_SESSION_COLUMN_DEFINITIONS.reasoning_effort};`,
      );
    }

    if (!columns.has("codex_sandbox_mode")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN codex_sandbox_mode ${LEGACY_SESSION_COLUMN_DEFINITIONS.codex_sandbox_mode};`,
      );
    }

    if (!columns.has("catalog_revision")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN catalog_revision ${LEGACY_SESSION_COLUMN_DEFINITIONS.catalog_revision};`,
      );
    }

    if (!columns.has("custom_agent_name")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN custom_agent_name ${LEGACY_SESSION_COLUMN_DEFINITIONS.custom_agent_name};`,
      );
    }

    if (!columns.has("allowed_additional_directories_json")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN allowed_additional_directories_json ${LEGACY_SESSION_COLUMN_DEFINITIONS.allowed_additional_directories_json};`,
      );
    }

    if (!columns.has("character_theme_main")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN character_theme_main ${LEGACY_SESSION_COLUMN_DEFINITIONS.character_theme_main};`,
      );
    }

    if (!columns.has("character_theme_sub")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN character_theme_sub ${LEGACY_SESSION_COLUMN_DEFINITIONS.character_theme_sub};`,
      );
    }

    if (!columns.has("character_runtime_snapshot_json")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN character_runtime_snapshot_json ${LEGACY_SESSION_COLUMN_DEFINITIONS.character_runtime_snapshot_json};`,
      );
    }

    if (!columns.has("access_mode")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN access_mode ${LEGACY_SESSION_COLUMN_DEFINITIONS.access_mode};`,
      );
    }

    if (!columns.has("source_schema_version")) {
      this.db.exec(
        `ALTER TABLE sessions ADD COLUMN source_schema_version ${LEGACY_SESSION_COLUMN_DEFINITIONS.source_schema_version};`,
      );
    }
  }

  /** 旧形式の全行を本文込みで読み、不正な保存行は除いて Session を返す。 */
  listSessions(): Session[] {
    const rows = this.db.prepare(LIST_SESSIONS_SQL).all() as SessionRow[];
    return cloneSessions(
      rows
        .map((row) => rowToSession(row))
        .filter((session): session is Session => session !== null),
    );
  }

  /** 履歴を読み込まず、利用可能な旧形式の要約を一覧にする。 */
  listSessionSummaries(): SessionSummary[] {
    const rows = this.db
      .prepare(LIST_SESSION_SUMMARIES_SQL)
      .all() as SessionSummaryRow[];
    return cloneSessionSummaries(
      rows
        .map((row) => rowToSessionSummary(row))
        .filter((session): session is SessionSummary => session !== null),
    );
  }

  /** 旧形式の Home 一覧を ID または最近の活動順で取得する。ピン留めは対応しないため空を返す。 */
  listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): HomeSessionSummaryPageResult {
    const parsed = parseSessionSummaryPageRequest(request);
    const cursor =
      parsed.scope === "open"
        ? null
        : decodeSessionSummaryCursor(
            parsed.cursor,
            parsed.scope,
            parsed.searchText,
          );
    if (parsed.scope === "pinned") {
      return { entries: [], nextCursor: null, hasMore: false };
    }
    const search = buildSessionSummarySearchClauseForColumns(
      "s",
      parsed.searchText,
      {
        title: "s.task_title",
        workspacePath: "s.workspace_path",
        workspaceLabel: "s.workspace_label",
        sessionKind: "s.session_kind",
      },
    );
    const keyset = buildSessionSummaryKeysetClause("s", cursor);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (parsed.scope === "open") {
      const sessionIds = parsed.sessionIds ?? [];
      if (sessionIds.length === 0) {
        return { entries: [], nextCursor: null, hasMore: false };
      }
      where.push(`s.id IN (${sessionIds.map(() => "?").join(", ")})`);
      params.push(...sessionIds);
    } else if (keyset.sql) {
      where.push(keyset.sql);
      params.push(...keyset.params);
    }
    if (parsed.scope !== "open" && search.sql) {
      where.push(search.sql);
      params.push(...search.params);
    }
    const rows = this.db
      .prepare(
        `
      SELECT ${HOME_SESSION_SUMMARY_SELECT_COLUMNS}, last_active_at
      FROM sessions AS s
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.last_active_at DESC, s.id DESC
      LIMIT ?
    `,
      )
      .all(...params, parsed.limit + 1) as HomeSessionSummaryRow[];
    const visibleRows = rows.slice(0, parsed.limit);
    const entries = cloneHomeSessionSummaries(
      visibleRows
        .map((row) => rowToHomeSessionSummary(row))
        .filter((summary): summary is HomeSessionSummary => summary !== null),
    );
    const hasMore = parsed.scope !== "open" && rows.length > parsed.limit;
    const lastRow = visibleRows.at(-1);
    return {
      entries,
      hasMore,
      nextCursor:
        hasMore && lastRow && parsed.scope !== "open"
          ? encodeSessionSummaryCursor(
              parsed.scope,
              String(lastRow.last_active_at),
              lastRow.id,
              parsed.searchText,
            )
          : null,
    };
  }

  /** 通常 Session に使用されたキャラクターの ID を、最後に使われた順で返す。 */
  listSessionCharacterUsage(): SessionCharacterUsage[] {
    const rows = this.db
      .prepare(
        `
      SELECT s.character_id
      FROM sessions AS s
      WHERE s.session_kind = 'default'
        AND s.character_id IS NOT NULL
        AND s.character_id <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM sessions AS newer
          WHERE newer.session_kind = 'default'
            AND newer.character_id = s.character_id
            AND (
              newer.last_active_at > s.last_active_at
              OR (newer.last_active_at = s.last_active_at AND newer.id > s.id)
            )
        )
      ORDER BY s.last_active_at DESC, s.id DESC
    `,
      )
      .all() as Array<{ character_id: string }>;
    return rows
      .map((row) => row.character_id.trim())
      .filter(Boolean)
      .map((characterId) => ({ characterId, sessionKind: "default" as const }));
  }

  /** 指定プロバイダーの最新の要約を取得し、対象がなければ null、読み取れない場合は例外とする。 */
  getLatestSessionSummaryForProvider(
    providerId: string,
  ): SessionSummary | null {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return null;
    }
    const row = this.db
      .prepare(GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL)
      .get(normalizeProviderId(normalizedProviderId)) as
      SessionSummaryRow | undefined;
    if (!row) {
      return null;
    }
    const summary = rowToSessionSummary(row, "throw");
    return summary ? cloneSessionSummaries([summary])[0] : null;
  }

  /** 指定 ID の旧形式 Session を履歴ごと復元する。未保存は null、不正な保存値は例外とする。 */
  getSession(sessionId: string): Session | null {
    const row = this.db.prepare(GET_SESSION_SQL).get(sessionId) as
      SessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = rowToSession(row, "throw");
    return session ? cloneSessions([session])[0] : null;
  }

  /** 旧形式では保存済み Session 本体を読み、指定位置のメッセージから成果物を取り出す。 */
  getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): MessageArtifact | null {
    const session = this.getSession(sessionId);
    return session?.messages[messageIndex]?.artifact ?? null;
  }

  /** 基準時刻より前に最後の活動があった、空でない Session ID を列挙する。 */
  listSessionIdsLastActiveBefore(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): string[] {
    const rows = this.db
      .prepare(LIST_SESSION_IDS_LAST_ACTIVE_BEFORE_SQL)
      .all(cutoff.cutoffTimestampMs) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  /** Session 全体を正規化し、現在時刻を活動時刻として旧形式に挿入または更新する。 */
  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    this.writeSession(normalized, Date.now(), "upsert");
    return cloneSessions([normalized])[0];
  }

  /** 正規化後の Session を新規作成する。既存の同一 ID は上書きしない。 */
  insertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    this.writeSession(normalized, Date.now(), "create");
    return cloneSessions([normalized])[0];
  }

  /** 入力順で全 Session を置き換え、新しい一覧に親がない Auxiliary を同じトランザクションで削除する。 */
  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });

    const baseLastActiveAt = Date.now() + normalizedSessions.length;
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM sessions");
      normalizedSessions.forEach((session, index) => {
        this.writeSession(session, baseLastActiveAt - index, "upsert");
      });
      this.deleteAuxiliarySessionsWithoutValidParents(
        normalizedSessions.map((session) => session.id),
      );
      this.db.exec("COMMIT");
      return cloneSessions(normalizedSessions);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 一件の ID を複数削除と同じ処理へ渡す。 */
  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  /** 指定された ID の重複と空白を除き、対応する Session と Auxiliary をまとめて削除する。 */
  deleteSessions(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    );
    if (uniqueSessionIds.length === 0) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const placeholders = uniqueSessionIds.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`)
        .run(...uniqueSessionIds);
      this.deleteAuxiliarySessionsForParentsIfTableExists(uniqueSessionIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 旧 Session 全件と、同じデータベースに対応テーブルがある場合は Auxiliary も一括で削除する。 */
  clearSessions(): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.exec("DELETE FROM sessions;");
      this.deleteAllAuxiliarySessionsIfTableExists();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 旧形式の読み書きに使った SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }

  /** 旧データベースに Auxiliary 本体のテーブルがあるかを、削除前に確認する。 */
  private auxiliarySessionsTableExists(): boolean {
    return Boolean(
      this.db
        .prepare(
          `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `,
        )
        .get(AUXILIARY_SESSIONS_TABLE_NAME),
    );
  }

  /** Auxiliary が保存されるデータベースに限り、指定の親に属する本体と既存のドラフトを削除する。 */
  private deleteAuxiliarySessionsForParentsIfTableExists(
    parentSessionIds: readonly string[],
  ): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    const uniqueParentIds = Array.from(
      new Set(
        parentSessionIds
          .map((parentSessionId) => parentSessionId.trim())
          .filter(Boolean),
      ),
    );
    if (uniqueParentIds.length === 0) {
      return;
    }

    const placeholders = uniqueParentIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM auxiliary_sessions WHERE parent_session_id IN (${placeholders})`,
      )
      .run(...uniqueParentIds);
    if (this.auxiliaryDraftsTableExists()) {
      this.db
        .prepare(
          `DELETE FROM auxiliary_session_drafts WHERE parent_session_id IN (${placeholders})`,
        )
        .run(...uniqueParentIds);
    }
  }

  /** 対応テーブルがある場合だけ Auxiliary とドラフトを全件削除する。 */
  private deleteAllAuxiliarySessionsIfTableExists(): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    this.db.prepare("DELETE FROM auxiliary_sessions").run();
    if (this.auxiliaryDraftsTableExists())
      this.db.prepare("DELETE FROM auxiliary_session_drafts").run();
  }

  /** 旧データベースに Auxiliary のドラフトテーブルが存在するかを確認する。 */
  private auxiliaryDraftsTableExists(): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auxiliary_session_drafts'`,
        )
        .get(),
    );
  }

  /** 全置換後も残る親に所属する Auxiliary とドラフトを保持し、それ以外を削除する。 */
  private deleteAuxiliarySessionsWithoutValidParents(
    retainedParentSessionIds: Iterable<string>,
  ): void {
    if (!this.auxiliarySessionsTableExists()) {
      return;
    }

    const validParentSessionIds = Array.from(
      new Set([...retainedParentSessionIds]),
    );
    if (validParentSessionIds.length === 0) {
      this.db.prepare("DELETE FROM auxiliary_sessions").run();
      if (this.auxiliaryDraftsTableExists())
        this.db.prepare("DELETE FROM auxiliary_session_drafts").run();
      return;
    }

    const placeholders = validParentSessionIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`,
      )
      .run(...validParentSessionIds);
    if (this.auxiliaryDraftsTableExists()) {
      this.db
        .prepare(
          `DELETE FROM auxiliary_session_drafts WHERE parent_session_id NOT IN (${placeholders})`,
        )
        .run(...validParentSessionIds);
    }
  }
}
