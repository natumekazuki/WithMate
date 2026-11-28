import type { DatabaseSync } from "node:sqlite";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  normalizeHomeSessionSummary,
  normalizeSession,
  normalizeSessionSummary,
  type Message,
  type MessageArtifact,
  type HomeSessionSummary,
  type Session,
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type HomeSessionSummaryPageResult,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import { normalizeProviderId } from "../../src-shared/settings/model-catalog.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../../src-shared/window/withmate-window-types.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClauseForColumns,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";

/** V2 の Session ヘッダーで保持する表示・ワークスペース・モデル・実行状態。本文は別の行にある。 */
type SessionHeaderRow = {
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
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  run_state: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  allowed_additional_directories_json: string;
  thread_id: string;
  last_active_at: string | number;
};

/** Home の一覧に必要な V2 行。履歴と成果物を読まずに、活動順と表示情報を取得する。 */
type HomeSessionSummaryRow = {
  id: string;
  task_title: string;
  status: string;
  updated_at: string;
  workspace_label: string;
  workspace_path: string;
  session_kind: string;
  character_id: string;
  character_name: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  run_state: string;
  is_pinned: number;
  last_active_at: string | number;
};

/** ID だけを照会した結果の行。 */
type SessionIdRow = {
  id: string;
};

/** V2 のメッセージ行と、別格納の成果物が照会された場合の JSON。 */
type SessionMessageRow = {
  role: string;
  text: string;
  accent: number;
  is_bookmarked: number;
  artifact_available: number;
  artifact_json: string | null;
};

/** 不正な保存行を一覧で読み飛ばすか、個別の厳密な取得で例外にするかを選ぶ。 */
type SessionRowParseMode = "skip" | "throw";

const UPSERT_SESSION_SQL = `
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
    thread_id,
    message_count,
    last_active_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    character_id = excluded.character_id,
    character_name = excluded.character_name,
    character_icon_path = excluded.character_icon_path,
    character_theme_main = excluded.character_theme_main,
    character_theme_sub = excluded.character_theme_sub,
    run_state = excluded.run_state,
    approval_mode = excluded.approval_mode,
    codex_sandbox_mode = excluded.codex_sandbox_mode,
    model = excluded.model,
    reasoning_effort = excluded.reasoning_effort,
    custom_agent_name = excluded.custom_agent_name,
    allowed_additional_directories_json = excluded.allowed_additional_directories_json,
    thread_id = excluded.thread_id,
    message_count = excluded.message_count,
    last_active_at = excluded.last_active_at
`;

const DELETE_SESSION_MESSAGES_SQL = `
  DELETE FROM session_messages
  WHERE session_id = ?
`;

const DELETE_SESSION_SQL = `
  DELETE FROM sessions
  WHERE id = ?
`;

const DELETE_ALL_SESSIONS_SQL = `
  DELETE FROM sessions
`;

const LIST_SESSION_IDS_SQL = `
  SELECT id
  FROM sessions
`;

const INSERT_SESSION_MESSAGE_SQL = `
  INSERT INTO session_messages (
    session_id,
    seq,
    role,
    text,
    accent,
    is_bookmarked,
    artifact_available,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_MESSAGE_ARTIFACT_SQL = `
  INSERT INTO session_message_artifacts (message_id, artifact_json)
  VALUES (?, ?)
`;

const SESSION_HEADER_COLUMNS = `
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
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL = `
  SELECT
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  WHERE ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(provider) = ?
  ORDER BY last_active_at DESC, id DESC
  LIMIT 1
`;

const LIST_SESSION_IDS_LAST_ACTIVE_BEFORE_SQL = `
  SELECT id
  FROM sessions
  WHERE last_active_at < ?
  ORDER BY last_active_at ASC, id ASC
`;

const GET_SESSION_HEADER_SQL = `
  SELECT
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  WHERE id = ?
`;

const LIST_SESSION_MESSAGES_SQL = `
  SELECT
    m.role,
    m.text,
    m.accent,
    m.is_bookmarked,
    m.artifact_available,
    a.artifact_json
  FROM session_messages AS m
  LEFT JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.seq ASC
`;

const GET_SESSION_MESSAGE_ARTIFACT_SQL = `
  SELECT a.artifact_json
  FROM session_messages AS m
  INNER JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
    AND m.seq = ?
`;

/** 追加ディレクトリを JSON の文字列配列として検証する。不正な値は空に置き換えず方針に従って扱う。 */
function parseAllowedAdditionalDirectories(
  row: SessionHeaderRow,
  mode: SessionRowParseMode,
): string[] | null {
  try {
    const parsed = JSON.parse(row.allowed_additional_directories_json);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        "allowed_additional_directories_json is not a string array",
      );
    }
    return parsed;
  } catch (error) {
    console.error("stored session JSON parse failed", {
      sessionId: row.id,
      columnName: "allowed_additional_directories_json",
      error,
    });
    if (mode === "throw") {
      throw new Error(
        `保存済み session ${row.id} の allowed_additional_directories_json が壊れているよ。`,
      );
    }
    return null;
  }
}

/** V2 ヘッダーから履歴を含まない要約を復元し、不正な保存値は指定の読み取り方針で処理する。 */
function rowToSessionSummary(
  row: SessionHeaderRow,
  mode: SessionRowParseMode = "skip",
): SessionSummary | null {
  const allowedAdditionalDirectories = parseAllowedAdditionalDirectories(
    row,
    mode,
  );
  if (!allowedAdditionalDirectories) {
    if (mode === "throw") {
      throw new Error(
        `保存済み session ${row.id} の allowed_additional_directories_json が壊れているよ。`,
      );
    }
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

  if (!summary && mode === "throw") {
    throw new Error(`保存済み session ${row.id} の summary が壊れているよ。`);
  }

  return summary;
}

/** V2 の限定列を、書き込み可能な Home 一覧用の要約へ正規化する。 */
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
    accessMode: "active",
    sourceSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION - 1,
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

/** 利用者とアシスタントの行だけを履歴へ写し、壊れた成果物だけは本文を残して省く。 */
function rowToMessage(row: SessionMessageRow): Message | null {
  if (row.role !== "user" && row.role !== "assistant") {
    return null;
  }

  let artifact: MessageArtifact | undefined;
  if (row.artifact_available === 1 && row.artifact_json) {
    try {
      artifact = JSON.parse(row.artifact_json) as MessageArtifact;
    } catch {
      artifact = undefined;
    }
  }

  return {
    role: row.role,
    text: row.text,
    accent: row.accent === 1 ? true : undefined,
    ...(row.is_bookmarked === 1 ? { isBookmarked: true } : {}),
    artifact,
  };
}

/** ヘッダーと取得済みメッセージから Session を復元する。保存していないライブストリームは空とする。 */
function rowToSession(
  row: SessionHeaderRow,
  messages: Message[],
  mode: SessionRowParseMode = "skip",
): Session | null {
  const summary = rowToSessionSummary(row, mode);
  if (!summary) {
    return null;
  }

  const session = normalizeSession({
    ...summary,
    messages,
    stream: [],
  });
  if (!session && mode === "throw") {
    throw new Error(`保存済み session ${row.id} が壊れているよ。`);
  }

  return session;
}

/** 全 Session ID を集合として取得し、全置換時に保存済みの対象を照合できるようにする。 */
function readSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(LIST_SESSION_IDS_SQL).all() as SessionIdRow[];
  return new Set(rows.map((row) => row.id));
}

/** Session の表示・実行情報とメッセージ件数を、指定の活動時刻とともにヘッダーへ書く。 */
function writeSessionHeader(
  statement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
  lastActiveAt: number,
): void {
  statement.run(
    session.id,
    session.taskTitle,
    session.status,
    session.updatedAt,
    session.provider,
    session.catalogRevision,
    session.workspaceLabel,
    session.workspacePath,
    session.branch,
    session.sessionKind,
    session.characterId,
    session.character,
    session.characterIconPath,
    session.characterThemeColors.main,
    session.characterThemeColors.sub,
    session.runState,
    session.approvalMode,
    session.codexSandboxMode,
    session.model,
    session.reasoningEffort,
    session.customAgentName,
    JSON.stringify(session.allowedAdditionalDirectories ?? []),
    session.threadId,
    session.messages.length,
    lastActiveAt,
  );
}

/** 履歴の並びをシーケンスとして書き、成果物がある場合は採番された行に別テーブルで関連付ける。 */
function writeSessionMessages(
  insertMessageStatement: ReturnType<DatabaseSync["prepare"]>,
  insertArtifactStatement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
): void {
  session.messages.forEach((message, index) => {
    const result = insertMessageStatement.run(
      session.id,
      index,
      message.role,
      message.text,
      message.accent === true ? 1 : 0,
      message.isBookmarked === true ? 1 : 0,
      message.artifact ? 1 : 0,
      "",
    );
    if (message.artifact) {
      insertArtifactStatement.run(
        Number(result.lastInsertRowid),
        JSON.stringify(message.artifact),
      );
    }
  });
}

/** V2 のヘッダー・メッセージ・成果物を別レコードで保持する SQLite ストア。 */
export class SessionStorageV2 {
  private db: DatabaseSync | null;

  /** 接続を開いてプロバイダー ID の関数を登録し、旧保存データから読めるスキーマに整える。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    registerSessionProviderIdNormalizer(this.db);
    this.ensureSchema();
  }

  /** 既存のメッセージテーブルにブックマーク列がなければ、既定値付きで追加する。 */
  private ensureSchema(): void {
    this.withDb((db) => {
      const columns = new Set(
        (
          db.prepare("PRAGMA table_info(session_messages)").all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      if (!columns.has("is_bookmarked")) {
        db.exec(
          "ALTER TABLE session_messages ADD COLUMN is_bookmarked INTEGER NOT NULL DEFAULT 0;",
        );
      }
    });
  }

  /** ストアが開いている場合だけ SQLite の操作を実行する。 */
  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("SessionStorageV2 は close 済みだよ。");
    }

    return runner(this.db);
  }

  /** 一覧表示向けに、本文を取得せずヘッダーだけで構成できる Session を返す。 */
  listSessions(): Session[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(LIST_SESSION_SUMMARIES_SQL)
        .all() as SessionHeaderRow[];
      return cloneSessions(
        rows
          .map((row) => rowToSession(row, []))
          .filter((session): session is Session => session !== null),
      );
    });
  }

  /** 不正な行を除いた V2 の要約一覧を返す。メッセージと成果物は読み込まない。 */
  listSessionSummaries(): SessionSummary[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(LIST_SESSION_SUMMARIES_SQL)
        .all() as SessionHeaderRow[];
      return cloneSessionSummaries(
        rows
          .map((row) => rowToSessionSummary(row))
          .filter((session): session is SessionSummary => session !== null),
      );
    });
  }

  /** Home の最近および開いている Session をページ化する。V2 はピン留めを保存していないため空を返す。 */
  listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): HomeSessionSummaryPageResult {
    return this.withDb((db) => {
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
      const rows = db
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
    });
  }

  /** 通常 Session に使われたキャラクターを、最後に使われた順に ID で列挙する。 */
  listSessionCharacterUsage(): SessionCharacterUsage[] {
    return this.withDb((db) => {
      const rows = db
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
        .map((characterId) => ({
          characterId,
          sessionKind: "default" as const,
        }));
    });
  }

  /** 指定プロバイダーの最新要約を取得する。空の指定や対象なしは null、壊れた行はエラーとする。 */
  getLatestSessionSummaryForProvider(
    providerId: string,
  ): SessionSummary | null {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return null;
    }
    return this.withDb((db) => {
      const row = db
        .prepare(GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL)
        .get(normalizeProviderId(normalizedProviderId)) as
        SessionHeaderRow | undefined;
      if (!row) {
        return null;
      }
      const summary = rowToSessionSummary(row, "throw");
      return summary ? cloneSessionSummaries([summary])[0] : null;
    });
  }

  /** 指定 Session のヘッダーと保存済み履歴を読み、本文付きの正規化された Session を返す。 */
  getSession(sessionId: string): Session | null {
    return this.withDb((db) => {
      const row = db.prepare(GET_SESSION_HEADER_SQL).get(sessionId) as
        SessionHeaderRow | undefined;
      if (!row) {
        return null;
      }

      const messageRows = db
        .prepare(LIST_SESSION_MESSAGES_SQL)
        .all(sessionId) as SessionMessageRow[];
      const messages = messageRows
        .map((messageRow) => rowToMessage(messageRow))
        .filter((message): message is Message => message !== null);
      const session = rowToSession(row, messages, "throw");
      return session ? cloneSessions([session])[0] : null;
    });
  }

  /** 指定メッセージの成果物だけを取得する。未保存または復元できない場合は null。 */
  getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): MessageArtifact | null {
    return this.withDb((db) => {
      const row = db
        .prepare(GET_SESSION_MESSAGE_ARTIFACT_SQL)
        .get(sessionId, messageIndex) as
        { artifact_json: string | null } | undefined;
      if (!row?.artifact_json) {
        return null;
      }
      try {
        return JSON.parse(row.artifact_json) as MessageArtifact;
      } catch {
        return null;
      }
    });
  }

  /** 指定の活動時刻より古い Session の、空でない ID を列挙する。 */
  listSessionIdsLastActiveBefore(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): string[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(LIST_SESSION_IDS_LAST_ACTIVE_BEFORE_SQL)
        .all(cutoff.cutoffTimestampMs) as SessionIdRow[];
      return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
    });
  }

  /** 正規化後のヘッダーと置換した全メッセージを一つのトランザクションで保存する。 */
  upsertSession(session: Session): Session {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    return this.withDb((db) => {
      const upsertSessionStatement = db.prepare(UPSERT_SESSION_SQL);
      const deleteMessagesStatement = db.prepare(DELETE_SESSION_MESSAGES_SQL);
      const insertMessageStatement = db.prepare(INSERT_SESSION_MESSAGE_SQL);
      const insertArtifactStatement = db.prepare(INSERT_MESSAGE_ARTIFACT_SQL);

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        writeSessionHeader(upsertSessionStatement, normalized, Date.now());
        deleteMessagesStatement.run(normalized.id);
        writeSessionMessages(
          insertMessageStatement,
          insertArtifactStatement,
          normalized,
        );
        db.exec("COMMIT");
        return cloneSessions([normalized])[0];
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 指定集合だけを入力順で残す。削除・ヘッダー更新・履歴置換はすべて成功した場合に確定する。 */
  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });

    return this.withDb((db) => {
      const existingSessionIds = readSessionIds(db);
      const nextSessionIds = new Set(
        normalizedSessions.map((session) => session.id),
      );
      const upsertSessionStatement = db.prepare(UPSERT_SESSION_SQL);
      const deleteSessionStatement = db.prepare(DELETE_SESSION_SQL);
      const deleteMessagesStatement = db.prepare(DELETE_SESSION_MESSAGES_SQL);
      const insertMessageStatement = db.prepare(INSERT_SESSION_MESSAGE_SQL);
      const insertArtifactStatement = db.prepare(INSERT_MESSAGE_ARTIFACT_SQL);
      const baseLastActiveAt = Date.now() + normalizedSessions.length;

      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        for (const existingSessionId of existingSessionIds) {
          if (!nextSessionIds.has(existingSessionId)) {
            deleteSessionStatement.run(existingSessionId);
          }
        }
        normalizedSessions.forEach((session, index) => {
          writeSessionHeader(
            upsertSessionStatement,
            session,
            baseLastActiveAt - index,
          );
          deleteMessagesStatement.run(session.id);
          writeSessionMessages(
            insertMessageStatement,
            insertArtifactStatement,
            session,
          );
        });
        db.exec("COMMIT");
        return cloneSessions(normalizedSessions);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** ID 一件を複数削除と同じ正規化・削除経路に渡す。 */
  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  /** 空白と重複を除いた明示 ID に該当する V2 Session だけを削除する。 */
  deleteSessions(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    );
    if (uniqueSessionIds.length === 0) {
      return;
    }

    this.withDb((db) => {
      const placeholders = uniqueSessionIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(
        ...uniqueSessionIds,
      );
    });
  }

  /** V2 の Session を全件削除する。 */
  clearSessions(): void {
    this.withDb((db) => {
      db.prepare(DELETE_ALL_SESSIONS_SQL).run();
    });
  }

  /** 開いている SQLite 接続を一度だけ閉じ、その後の操作を拒否する。 */
  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }
}
