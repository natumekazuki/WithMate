import type { DatabaseSync } from "node:sqlite";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  normalizeHomeSessionSummary,
  normalizeSession,
  normalizeSessionSummary,
  summarizeMessageArtifact,
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
import type {
  MessageOperation,
  ChangedFile,
  RunCheck,
} from "../../src-shared/session/runtime-state.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../../src-shared/character/character-runtime-snapshot.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import {
  V3_SUMMARY_JSON_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "../storage/database-schema-v3.js";
import {
  openAppDatabase,
  openAppDatabaseReadOnly,
} from "../storage/sqlite-connection.js";
import { type BlobRef, TextBlobStore } from "../storage/text-blob-store.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../../src-shared/window/withmate-window-types.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClauseForColumns,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";

/** V3 の Session ヘッダーで保持する設定・表示・スレッドと、実行時のキャラクター定義。 */
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
  character_runtime_snapshot_json: string;
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

/** キャラクター定義の JSON を読まずに取得する V3 のヘッダー要約行。 */
type SessionSummaryHeaderRow = Omit<
  SessionHeaderRow,
  "character_runtime_snapshot_json"
>;

/** Home 一覧の表示・属性・活動順に必要な V3 の限定列。 */
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

/** ID だけを取得する SQLite クエリの結果。 */
type SessionIdRow = {
  id: string;
};

/** 本文・成果物のプレビューと、完全な内容を参照する Blob ID を持つメッセージ行。 */
type SessionMessageRow = {
  role: string;
  text_preview: string;
  text_blob_id: string | null;
  accent: number;
  is_bookmarked: number;
  artifact_available: number;
  artifact_summary_json: string | null;
  artifact_blob_id: string | null;
};

/** 本文または成果物への Blob 参照だけを問い合わせた結果。 */
type BlobIdRow = {
  blob_id: string | null;
};

/** 既存スキーマの列の有無を調べるための SQLite メタデータ。 */
type TableColumnRow = {
  name: string;
};

/** 壊れた行を一覧から除くか、個別の厳密な取得で例外にするかを指定する。 */
type SessionRowParseMode = "skip" | "throw";

/** 要約だけを読み込んだ成果物を保存し直す際に、既存の詳細 Blob を再利用するための情報。 */
type ExistingMessageArtifactRef = {
  summaryJson: string;
  blobId: string;
  originalBytes: number;
  storedBytes: number;
};

/** 詳細 Blob を新規で書いた場合と、要約が同じ既存の詳細をそのまま使う場合を区別する。 */
type StoredArtifactPayload =
  | { kind: "new"; ref: BlobRef }
  | { kind: "preserved"; ref: ExistingMessageArtifactRef };

/** 一件のメッセージの本文 Blob と、成果物がある場合の詳細保存方法。 */
type StoredMessagePayload = {
  text: BlobRef;
  artifact: StoredArtifactPayload | null;
};

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
    character_runtime_snapshot_json,
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    character_runtime_snapshot_json = excluded.character_runtime_snapshot_json,
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

const INSERT_BLOB_OBJECT_SQL = `
  INSERT OR IGNORE INTO blob_objects (
    blob_id,
    codec,
    content_type,
    original_bytes,
    stored_bytes,
    raw_sha256,
    stored_sha256,
    state,
    created_at,
    last_verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, '')
`;

const DELETE_SESSION_MESSAGES_SQL =
  "DELETE FROM session_messages WHERE session_id = ?";
const DELETE_SESSION_SQL = "DELETE FROM sessions WHERE id = ?";
const DELETE_ALL_SESSIONS_SQL = "DELETE FROM sessions";
const LIST_SESSION_IDS_SQL = "SELECT id FROM sessions";
const DELETE_BLOB_OBJECT_SQL = "DELETE FROM blob_objects WHERE blob_id = ?";
const IS_BLOB_OBJECT_PERSISTED_SQL =
  "SELECT 1 FROM blob_objects WHERE blob_id = ? LIMIT 1";

const INSERT_SESSION_MESSAGE_SQL = `
  INSERT INTO session_messages (
    session_id,
    seq,
    role,
    text_preview,
    text_blob_id,
    text_original_bytes,
    text_stored_bytes,
    accent,
    is_bookmarked,
    artifact_available,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_MESSAGE_ARTIFACT_SQL = `
  INSERT INTO session_message_artifacts (
    message_id,
    artifact_summary_json,
    artifact_blob_id,
    artifact_original_bytes,
    artifact_stored_bytes
  ) VALUES (?, ?, ?, ?, ?)
`;

const SESSION_SUMMARY_HEADER_COLUMNS = `
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

const SESSION_DETAIL_HEADER_COLUMNS = `
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
  character_runtime_snapshot_json,
  run_state,
  approval_mode,
  codex_sandbox_mode,
  model,
  reasoning_effort,
  custom_agent_name,
  allowed_additional_directories_json,
  thread_id
`;

const LIST_SESSION_SUMMARIES_SQL = `
  SELECT
    ${SESSION_SUMMARY_HEADER_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
`;

const GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL = `
  SELECT
    ${SESSION_SUMMARY_HEADER_COLUMNS}
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
    ${SESSION_DETAIL_HEADER_COLUMNS}
  FROM sessions
  WHERE id = ?
`;

const LIST_SESSION_MESSAGES_SQL = `
  SELECT
    m.role,
    m.text_preview,
    m.text_blob_id,
    m.accent,
    m.is_bookmarked,
    m.artifact_available,
    a.artifact_summary_json,
    a.artifact_blob_id
  FROM session_messages AS m
  LEFT JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.seq ASC
`;

/** 選択クエリ中のオプション列を、旧スキーマに対応する既定値の式に差し替える。 */
function replaceOptionalReadColumn(
  query: string,
  column: string,
  expression: string,
): string {
  return query.replace(`${column},`, `${expression},`);
}

const GET_SESSION_MESSAGE_ARTIFACT_SQL = `
  SELECT a.artifact_blob_id AS blob_id
  FROM session_messages AS m
  INNER JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
    AND m.seq = ?
    AND a.artifact_blob_id IS NOT NULL
`;

const LIST_SESSION_MESSAGE_BLOB_IDS_SQL = `
  SELECT text_blob_id AS blob_id
  FROM session_messages
  WHERE session_id = ?
    AND text_blob_id IS NOT NULL
`;

const LIST_SESSION_ARTIFACT_BLOB_IDS_SQL = `
  SELECT a.artifact_blob_id AS blob_id
  FROM session_message_artifacts AS a
  INNER JOIN session_messages AS m
    ON m.id = a.message_id
  WHERE m.session_id = ?
    AND a.artifact_blob_id IS NOT NULL
`;

const LIST_SESSION_ARTIFACT_REFS_SQL = `
  SELECT
    m.seq,
    a.artifact_summary_json,
    a.artifact_blob_id,
    a.artifact_original_bytes,
    a.artifact_stored_bytes
  FROM session_message_artifacts AS a
  INNER JOIN session_messages AS m
    ON m.id = a.message_id
  WHERE m.session_id = ?
    AND a.artifact_blob_id IS NOT NULL
`;

const LIST_ALL_SESSION_MESSAGE_BLOB_IDS_SQL = `
  SELECT text_blob_id AS blob_id
  FROM session_messages
  WHERE text_blob_id IS NOT NULL
`;

const LIST_ALL_SESSION_ARTIFACT_BLOB_IDS_SQL = `
  SELECT artifact_blob_id AS blob_id
  FROM session_message_artifacts
  WHERE artifact_blob_id IS NOT NULL
`;

const LIVE_BLOB_REF_QUERIES = [
  "SELECT 1 FROM session_messages WHERE text_blob_id = ? LIMIT 1",
  "SELECT 1 FROM session_message_artifacts WHERE artifact_blob_id = ? LIMIT 1",
] as const;

/** 本文の完全な Blob とは別に、DB 行で保持する最大長以内の先頭部分を切り出す。 */
function preview(value: string): string {
  return value.length > V3_TEXT_PREVIEW_MAX_LENGTH
    ? value.slice(0, V3_TEXT_PREVIEW_MAX_LENGTH)
    : value;
}

/** V3 の追加ディレクトリを JSON から読み、配列中の文字列だけを残す。構文エラーは指定の方針で処理する。 */
function parseAllowedAdditionalDirectories(
  row: Pick<SessionHeaderRow, "allowed_additional_directories_json" | "id">,
  mode: SessionRowParseMode,
): string[] | null {
  try {
    const parsed = JSON.parse(row.allowed_additional_directories_json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : null;
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

/** V3 ヘッダーから履歴を伴わない要約を正規化し、読み取れない行を保存方針に従って処理する。 */
function rowToSessionSummary(
  row: SessionSummaryHeaderRow,
  mode: SessionRowParseMode = "skip",
): SessionSummary | null {
  const allowedAdditionalDirectories = parseAllowedAdditionalDirectories(
    row,
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

/** V3 の一覧用選択列を、書き込み可能な Home 用の表示情報に写す。 */
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

/** ヘッダーと取得済みの本文から Session を復元し、ストリームは履歴として保存しないため空にする。 */
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
    characterRuntimeSnapshot: parseCharacterRuntimeSnapshotJson(
      row.character_runtime_snapshot_json,
    ),
    messages,
    stream: [],
  });
  if (!session && mode === "throw") {
    throw new Error(`保存済み session ${row.id} が壊れているよ。`);
  }

  return session;
}

/** 全置換などで照合するため、既存 Session の ID を集合として取得する。 */
function readSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(LIST_SESSION_IDS_SQL).all() as SessionIdRow[];
  return new Set(rows.map((row) => row.id));
}

/** 指定の活動時刻とメッセージ件数を含め、Session の設定・表示情報を V3 ヘッダーに保存する。 */
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
    stringifyCharacterRuntimeSnapshot(session.characterRuntimeSnapshot),
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

/** 本文または成果物ファイルの Blob メタデータを対応する DB 行へ登録する。 */
function insertBlobObject(
  db: DatabaseSync,
  ref: BlobRef,
  createdAt: string,
): void {
  db.prepare(INSERT_BLOB_OBJECT_SQL).run(
    ref.blobId,
    ref.codec,
    ref.contentType,
    ref.originalBytes,
    ref.storedBytes,
    ref.rawSha256,
    ref.storedSha256,
    createdAt,
  );
}

/** 準備済みの本文と、新規作成した成果物の Blob 情報だけを DB に登録する。 */
function insertBlobObjects(
  db: DatabaseSync,
  payloads: readonly StoredMessagePayload[],
  createdAt: string,
): void {
  for (const payload of payloads) {
    insertBlobObject(db, payload.text, createdAt);
    if (payload.artifact?.kind === "new") {
      insertBlobObject(db, payload.artifact.ref, createdAt);
    }
  }
}

/** 保存後に参照されなかった物理 Blob を掃除できるよう、この試行で準備した候補 ID を取り出す。 */
function payloadBlobIds(payloads: readonly StoredMessagePayload[]): string[] {
  return payloads.flatMap((payload) => [
    payload.text.blobId,
    ...(payload.artifact?.kind === "new" ? [payload.artifact.ref.blobId] : []),
  ]);
}

/** DB に保存された成果物要約だけを読み、明細は別途取得できると示す。壊れた JSON は表示しない。 */
function parseArtifactSummary(
  value: string | null,
): MessageArtifact | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<MessageArtifact>;
    if (
      !Array.isArray(parsed.activitySummary) ||
      !Array.isArray(parsed.changedFiles) ||
      !Array.isArray(parsed.runChecks)
    ) {
      return {
        title: typeof parsed.title === "string" ? parsed.title : "",
        activitySummary: [],
        changedFiles: [],
        runChecks: [],
        detailAvailable: true,
      };
    }

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      activitySummary: parsed.activitySummary.filter(
        (item): item is string => typeof item === "string",
      ),
      operationTimeline: Array.isArray(parsed.operationTimeline)
        ? parsed.operationTimeline
            .filter(
              (operation): operation is MessageOperation =>
                typeof operation === "object" &&
                operation !== null &&
                typeof operation.type === "string" &&
                typeof operation.summary === "string",
            )
            .map((operation) => ({
              type: operation.type,
              summary: operation.summary,
            }))
        : undefined,
      changedFiles: parsed.changedFiles
        .filter(
          (file): file is ChangedFile =>
            typeof file === "object" &&
            file !== null &&
            (file.kind === "add" ||
              file.kind === "edit" ||
              file.kind === "delete") &&
            typeof file.path === "string",
        )
        .map((file) => ({
          kind: file.kind,
          path: file.path,
          summary: typeof file.summary === "string" ? file.summary : "",
          diffRows: [],
        })),
      runChecks: parsed.runChecks
        .filter(
          (check): check is RunCheck =>
            typeof check === "object" &&
            check !== null &&
            typeof check.label === "string" &&
            typeof check.value === "string",
        )
        .map((check) => ({ label: check.label, value: check.value })),
      detailAvailable: true,
    };
  } catch {
    return undefined;
  }
}

/** 成果物の全詳細から表示に必要な要約を作り、保存上限に収めて JSON 化する。 */
function buildArtifactSummary(artifact: MessageArtifact): string {
  return JSON.stringify(
    limitArtifactSummary(summarizeMessageArtifact(artifact)),
  );
}

/** 配列の末尾から優先順位に沿って落とし、容量に収める。配列を空にしても超える場合はタイトルを省く。 */
function limitArtifactSummary(summary: MessageArtifact): MessageArtifact {
  const limited: MessageArtifact = {
    ...summary,
    activitySummary: [...summary.activitySummary],
    operationTimeline: summary.operationTimeline
      ? [...summary.operationTimeline]
      : undefined,
    changedFiles: [...summary.changedFiles],
    runChecks: [...summary.runChecks],
    detailAvailable: true,
  };
  const arrayKeys = [
    "changedFiles",
    "runChecks",
    "activitySummary",
    "operationTimeline",
  ] as const;
  while (JSON.stringify(limited).length > V3_SUMMARY_JSON_MAX_LENGTH) {
    const targetKey = arrayKeys.find((key) => {
      const value = limited[key];
      return Array.isArray(value) && value.length > 0;
    });
    if (!targetKey) {
      return {
        ...limited,
        title: "",
        activitySummary: [],
        operationTimeline: undefined,
        changedFiles: [],
        runChecks: [],
        detailAvailable: true,
      };
    }
    const value = limited[targetKey];
    if (Array.isArray(value)) {
      value.pop();
    }
  }
  return limited;
}

/** 詳細を別途取得でき、差分行を含まない要約だけの成果物かを判定する。 */
function isArtifactSummaryOnly(artifact: MessageArtifact): boolean {
  return (
    artifact.detailAvailable === true &&
    artifact.changedFiles.every((file) => file.diffRows.length === 0)
  );
}

/** 新規 Blob と再利用 Blob のどちらでも、参照と保存前後のバイト数を同じ形で取り出す。 */
function artifactBlobMetadata(payload: StoredArtifactPayload): {
  blobId: string;
  originalBytes: number;
  storedBytes: number;
} {
  return payload.kind === "new"
    ? {
        blobId: payload.ref.blobId,
        originalBytes: payload.ref.originalBytes,
        storedBytes: payload.ref.storedBytes,
      }
    : {
        blobId: payload.ref.blobId,
        originalBytes: payload.ref.originalBytes,
        storedBytes: payload.ref.storedBytes,
      };
}

/** 本文プレビュー・Blob 参照をメッセージ順で書き、成果物の要約・詳細参照を採番された行に関連付ける。 */
function writeSessionMessages(
  insertMessageStatement: ReturnType<DatabaseSync["prepare"]>,
  insertArtifactStatement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
  payloads: readonly StoredMessagePayload[],
): void {
  session.messages.forEach((message, index) => {
    const payload = payloads[index];
    const result = insertMessageStatement.run(
      session.id,
      index,
      message.role,
      preview(message.text),
      payload.text.blobId,
      payload.text.originalBytes,
      payload.text.storedBytes,
      message.accent === true ? 1 : 0,
      message.isBookmarked === true ? 1 : 0,
      message.artifact ? 1 : 0,
      "",
    );

    if (message.artifact && payload.artifact) {
      const artifactBlob = artifactBlobMetadata(payload.artifact);
      insertArtifactStatement.run(
        Number(result.lastInsertRowid),
        buildArtifactSummary(message.artifact),
        artifactBlob.blobId,
        artifactBlob.originalBytes,
        artifactBlob.storedBytes,
      );
    }
  });
}

/** 削除・確認対象の Blob ID から欠落と空文字を除き、重複を取り除く。 */
function compactBlobIds(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ];
}

/** 指定 Session が参照する本文・成果物 Blob を一緒に取得する。 */
function collectSessionBlobIds(db: DatabaseSync, sessionId: string): string[] {
  const messageRows = db
    .prepare(LIST_SESSION_MESSAGE_BLOB_IDS_SQL)
    .all(sessionId) as BlobIdRow[];
  const artifactRows = db
    .prepare(LIST_SESSION_ARTIFACT_BLOB_IDS_SQL)
    .all(sessionId) as BlobIdRow[];
  return compactBlobIds(
    [...messageRows, ...artifactRows].map((row) => row.blob_id),
  );
}

/** 全 Session が参照する本文・成果物 Blob を重複なしで取得する。 */
function collectAllSessionBlobIds(db: DatabaseSync): string[] {
  const messageRows = db
    .prepare(LIST_ALL_SESSION_MESSAGE_BLOB_IDS_SQL)
    .all() as BlobIdRow[];
  const artifactRows = db
    .prepare(LIST_ALL_SESSION_ARTIFACT_BLOB_IDS_SQL)
    .all() as BlobIdRow[];
  return compactBlobIds(
    [...messageRows, ...artifactRows].map((row) => row.blob_id),
  );
}

/** 指定 Blob が管理対象の参照元クエリのいずれかから使われているかを確認する。 */
function isBlobReferenced(db: DatabaseSync, blobId: string): boolean {
  return LIVE_BLOB_REF_QUERIES.some((query) => {
    const parameterCount = (query.match(/\?/g) ?? []).length;
    return (
      db
        .prepare(query)
        .get(...Array.from({ length: parameterCount }, () => blobId)) !==
      undefined
    );
  });
}

/** どこからも参照されない候補だけを Blob 管理テーブルから外し、ファイル削除に渡す ID を返す。 */
function deleteUnreferencedBlobObjectRows(
  db: DatabaseSync,
  blobIds: readonly string[],
): string[] {
  const deletedBlobIds: string[] = [];
  const deleteBlobObjectStatement = db.prepare(DELETE_BLOB_OBJECT_SQL);
  for (const blobId of compactBlobIds(blobIds)) {
    if (isBlobReferenced(db, blobId)) {
      continue;
    }
    deleteBlobObjectStatement.run(blobId);
    deletedBlobIds.push(blobId);
  }
  return deletedBlobIds;
}

/** 既存の成果物の要約・詳細参照をメッセージ位置ごとに取得し、本文更新時の詳細の再利用に備える。 */
function readSessionArtifactRefs(
  db: DatabaseSync,
  sessionId: string,
): Map<number, ExistingMessageArtifactRef> {
  const rows = db
    .prepare(LIST_SESSION_ARTIFACT_REFS_SQL)
    .all(sessionId) as Array<{
    seq: number;
    artifact_summary_json: string;
    artifact_blob_id: string | null;
    artifact_original_bytes: number;
    artifact_stored_bytes: number;
  }>;
  return new Map(
    rows.flatMap((row) =>
      row.artifact_blob_id
        ? [
            [
              row.seq,
              {
                summaryJson: row.artifact_summary_json,
                blobId: row.artifact_blob_id,
                originalBytes: row.artifact_original_bytes,
                storedBytes: row.artifact_stored_bytes,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/** 本文 Blob を準備し、送られた成果物が同じ位置の既存要約と一致する場合は既存の詳細を残す。 */
async function storeMessagePayloads(
  blobStore: TextBlobStore,
  session: Session,
  existingArtifactRefs: ReadonlyMap<
    number,
    ExistingMessageArtifactRef
  > = new Map(),
): Promise<StoredMessagePayload[]> {
  return Promise.all(
    session.messages.map(async (message, index) => ({
      text: await blobStore.putText({
        contentType: "text/plain",
        text: message.text,
      }),
      artifact: message.artifact
        ? ((() => {
            const existing = existingArtifactRefs.get(index);
            if (
              existing &&
              isArtifactSummaryOnly(message.artifact) &&
              buildArtifactSummary(message.artifact) === existing.summaryJson
            ) {
              return {
                kind: "preserved",
                ref: existing,
              } satisfies StoredArtifactPayload;
            }
            return null;
          })() ?? {
            kind: "new",
            ref: await blobStore.putJson({ value: message.artifact }),
          })
        : null,
    })),
  );
}

/** メッセージ本文と成果物詳細を Blob に分け、V3 SQLite 上ではプレビューと参照を管理するストア。 */
export class SessionStorageV3 {
  private db: DatabaseSync | null;
  private readonly blobStore: TextBlobStore;
  private readonly getSessionHeaderSql: string;
  private readonly listSessionMessagesSql: string;

  /** 読み取り専用ならスキーマを変更せず開き、旧列が欠ける場合でも参照できる既定値の読み取りを組む。 */
  constructor(
    dbPath: string,
    blobRootPath: string,
    options: { readOnly?: boolean } = {},
  ) {
    const readOnly = options.readOnly === true;
    this.db = readOnly
      ? openAppDatabaseReadOnly(dbPath)
      : openAppDatabase(dbPath);
    registerSessionProviderIdNormalizer(this.db);
    this.blobStore = new TextBlobStore(blobRootPath);
    if (!readOnly) {
      this.ensureSchema();
    }

    const sessionColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(sessions)").all() as TableColumnRow[]
      ).map((column) => column.name),
    );
    const messageColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(session_messages)")
          .all() as TableColumnRow[]
      ).map((column) => column.name),
    );
    this.getSessionHeaderSql = replaceOptionalReadColumn(
      GET_SESSION_HEADER_SQL,
      "character_runtime_snapshot_json",
      sessionColumns.has("character_runtime_snapshot_json")
        ? "character_runtime_snapshot_json"
        : "'' AS character_runtime_snapshot_json",
    );
    this.listSessionMessagesSql = replaceOptionalReadColumn(
      LIST_SESSION_MESSAGES_SQL,
      "m.is_bookmarked",
      messageColumns.has("is_bookmarked")
        ? "m.is_bookmarked"
        : "0 AS is_bookmarked",
    );
  }

  /** 接続が開いている場合だけ SQLite 操作を実行する。 */
  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("SessionStorageV3 は close 済みだよ。");
    }

    return runner(this.db);
  }

  /** 書き込み可能な V3 DB に不足しているキャラクター定義・ブックマーク列を補う。 */
  private ensureSchema(): void {
    this.withDb((db) => {
      const columns = new Set(
        (
          db.prepare("PRAGMA table_info(sessions)").all() as TableColumnRow[]
        ).map((column) => column.name),
      );
      if (!columns.has("character_runtime_snapshot_json")) {
        db.exec(
          "ALTER TABLE sessions ADD COLUMN character_runtime_snapshot_json TEXT NOT NULL DEFAULT '';",
        );
      }
      const messageColumns = new Set(
        (
          db
            .prepare("PRAGMA table_info(session_messages)")
            .all() as TableColumnRow[]
        ).map((column) => column.name),
      );
      if (!messageColumns.has("is_bookmarked")) {
        db.exec(
          "ALTER TABLE session_messages ADD COLUMN is_bookmarked INTEGER NOT NULL DEFAULT 0;",
        );
      }
    });
  }

  /** 利用者・アシスタントの本文を Blob から取得し、参照がなければプレビューを使う。成果物は要約だけを表示する。 */
  private async rowToMessage(row: SessionMessageRow): Promise<Message | null> {
    if (row.role !== "user" && row.role !== "assistant") {
      return null;
    }

    return {
      role: row.role,
      text: row.text_blob_id
        ? await this.blobStore.getText(row.text_blob_id)
        : row.text_preview,
      accent: row.accent === 1 ? true : undefined,
      ...(row.is_bookmarked === 1 ? { isBookmarked: true } : {}),
      artifact:
        row.artifact_available === 1
          ? parseArtifactSummary(row.artifact_summary_json)
          : undefined,
    };
  }

  /** 要約を起点に各 Session の本文まで取得し、存在するものを返す。 */
  async listSessions(): Promise<Session[]> {
    const summaries = await this.listSessionSummaries();
    const sessions = await Promise.all(
      summaries.map((summary) => this.getSession(summary.id)),
    );
    return cloneSessions(
      sessions.filter((session): session is Session => session !== null),
    );
  }

  /** 本文・成果物 Blob を開かず、正規化できるヘッダーの要約だけを列挙する。 */
  async listSessionSummaries(): Promise<SessionSummary[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(LIST_SESSION_SUMMARIES_SQL)
        .all() as SessionSummaryHeaderRow[];
      return cloneSessionSummaries(
        rows
          .map((row) => rowToSessionSummary(row))
          .filter((session): session is SessionSummary => session !== null),
      );
    });
  }

  /** V3 の Home 一覧を検索・活動順または指定 ID で読み、非対応のピン留めは空とする。 */
  async listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): Promise<HomeSessionSummaryPageResult> {
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

  /** 通常 Session に使用されたキャラクターを、最も新しい利用の順に ID で列挙する。 */
  async listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
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

  /** 指定プロバイダーの最新要約を取得する。存在しない場合と壊れた保存行を区別する。 */
  async getLatestSessionSummaryForProvider(
    providerId: string,
  ): Promise<SessionSummary | null> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return null;
    }
    return this.withDb((db) => {
      const row = db
        .prepare(GET_LATEST_SESSION_SUMMARY_FOR_PROVIDER_SQL)
        .get(normalizeProviderId(normalizedProviderId)) as
        SessionSummaryHeaderRow | undefined;
      if (!row) {
        return null;
      }
      const summary = rowToSessionSummary(row, "throw");
      return summary ? cloneSessionSummaries([summary])[0] : null;
    });
  }

  /** 指定 ID の V3 ヘッダーとメッセージ行を取得し、本文 Blob を読み込んで Session を復元する。 */
  async getSession(sessionId: string): Promise<Session | null> {
    const result = this.withDb((db) => {
      const row = db.prepare(this.getSessionHeaderSql).get(sessionId) as
        SessionHeaderRow | undefined;
      if (!row) {
        return null;
      }

      const messageRows = db
        .prepare(this.listSessionMessagesSql)
        .all(sessionId) as SessionMessageRow[];
      return { row, messageRows };
    });
    if (!result) {
      return null;
    }

    const messages = (
      await Promise.all(
        result.messageRows.map((messageRow) => this.rowToMessage(messageRow)),
      )
    ).filter((message): message is Message => message !== null);
    const session = rowToSession(result.row, messages, "throw");
    return session ? cloneSessions([session])[0] : null;
  }

  /** 指定のメッセージだけ、保存された参照先から完全な成果物を取得する。未保存・読み取り失敗は null。 */
  async getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): Promise<MessageArtifact | null> {
    const blobId = this.withDb((db) => {
      const row = db
        .prepare(GET_SESSION_MESSAGE_ARTIFACT_SQL)
        .get(sessionId, messageIndex) as BlobIdRow | undefined;
      return row?.blob_id ?? null;
    });
    if (!blobId) {
      return null;
    }

    try {
      return await this.blobStore.getJson<MessageArtifact>(blobId);
    } catch {
      return null;
    }
  }

  /** 指定の時刻より以前に活動した Session の空でない ID を取得する。 */
  async listSessionIdsLastActiveBefore(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): Promise<string[]> {
    return this.withDb((db) => {
      const rows = db
        .prepare(LIST_SESSION_IDS_LAST_ACTIVE_BEFORE_SQL)
        .all(cutoff.cutoffTimestampMs) as SessionIdRow[];
      return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
    });
  }

  /** 現在時刻を活動時刻にして V3 の Session とメッセージを挿入または更新する。 */
  async upsertSession(session: Session): Promise<Session> {
    return this.upsertSessionWithLastActiveAt(session, Date.now());
  }

  /** 指定活動時刻でヘッダーと履歴をまとめて更新する。失敗時は未登録 Blob、成功後は以前の未参照 Blob を片付ける。 */
  async upsertSessionWithLastActiveAt(
    session: Session,
    lastActiveAt: number,
  ): Promise<Session> {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    const existingArtifactRefs = this.withDb((db) =>
      readSessionArtifactRefs(db, normalized.id),
    );
    const payloads = await storeMessagePayloads(
      this.blobStore,
      normalized,
      existingArtifactRefs,
    );

    let blobIdsToDelete: string[];
    try {
      blobIdsToDelete = this.withDb((db) => {
        const upsertSessionStatement = db.prepare(UPSERT_SESSION_SQL);
        const deleteMessagesStatement = db.prepare(DELETE_SESSION_MESSAGES_SQL);
        const insertMessageStatement = db.prepare(INSERT_SESSION_MESSAGE_SQL);
        const insertArtifactStatement = db.prepare(INSERT_MESSAGE_ARTIFACT_SQL);
        const createdAt = new Date().toISOString();
        let blobIdsToDelete: string[] = [];

        db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const previousBlobIds = collectSessionBlobIds(db, normalized.id);
          insertBlobObjects(db, payloads, createdAt);
          writeSessionHeader(upsertSessionStatement, normalized, lastActiveAt);
          deleteMessagesStatement.run(normalized.id);
          writeSessionMessages(
            insertMessageStatement,
            insertArtifactStatement,
            normalized,
            payloads,
          );
          blobIdsToDelete = deleteUnreferencedBlobObjectRows(
            db,
            previousBlobIds,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }

        return blobIdsToDelete;
      });
    } catch (error) {
      await this.deleteUnpersistedBlobs(payloadBlobIds(payloads));
      throw error;
    }
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
    return cloneSessions([normalized])[0];
  }

  /** 準備した Blob を参照して入力集合へ一括置換し、参照がなくなったファイルはコミット後に削除する。 */
  async replaceSessions(nextSessions: Session[]): Promise<Session[]> {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });
    const existingArtifactRefsBySessionId = this.withDb(
      (db) =>
        new Map(
          normalizedSessions.map(
            (session) =>
              [session.id, readSessionArtifactRefs(db, session.id)] as const,
          ),
        ),
    );
    const payloadsBySessionId = new Map(
      await Promise.all(
        normalizedSessions.map(
          async (session) =>
            [
              session.id,
              await storeMessagePayloads(
                this.blobStore,
                session,
                existingArtifactRefsBySessionId.get(session.id),
              ),
            ] as const,
        ),
      ),
    );

    const stagedBlobIds = [...payloadsBySessionId.values()].flatMap(
      (payloads) => payloadBlobIds(payloads),
    );
    let blobIdsToDelete: string[];
    try {
      blobIdsToDelete = this.withDb((db) => {
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
        const createdAt = new Date().toISOString();
        let blobIdsToDelete: string[] = [];

        db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const previousBlobIds: string[] = [];
          for (const existingSessionId of existingSessionIds) {
            if (!nextSessionIds.has(existingSessionId)) {
              previousBlobIds.push(
                ...collectSessionBlobIds(db, existingSessionId),
              );
              deleteSessionStatement.run(existingSessionId);
            }
          }
          normalizedSessions.forEach((session, index) => {
            previousBlobIds.push(...collectSessionBlobIds(db, session.id));
            const payloads = payloadsBySessionId.get(session.id) ?? [];
            insertBlobObjects(db, payloads, createdAt);
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
              payloads,
            );
          });
          blobIdsToDelete = deleteUnreferencedBlobObjectRows(
            db,
            previousBlobIds,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }

        return blobIdsToDelete;
      });
    } catch (error) {
      await this.deleteUnpersistedBlobs(stagedBlobIds);
      throw error;
    }
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
    return cloneSessions(normalizedSessions);
  }

  /** ID 一件を複数削除と同じトランザクション・Blob 回収に渡す。 */
  async deleteSession(sessionId: string): Promise<void> {
    await this.deleteSessions([sessionId]);
  }

  /** 指定した Session を削除し、他から参照されなくなった Blob のみをコミット後に取り除く。 */
  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    const uniqueSessionIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    );
    if (uniqueSessionIds.length === 0) {
      return;
    }

    const blobIdsToDelete = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const previousBlobIds = uniqueSessionIds.flatMap((sessionId) =>
          collectSessionBlobIds(db, sessionId),
        );
        const placeholders = uniqueSessionIds.map(() => "?").join(", ");
        db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(
          ...uniqueSessionIds,
        );
        const blobIdsToDelete = deleteUnreferencedBlobObjectRows(
          db,
          previousBlobIds,
        );
        db.exec("COMMIT");
        return blobIdsToDelete;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  /** V3 の全 Session を削除し、別の参照元がない Blob を片付ける。 */
  async clearSessions(): Promise<void> {
    const blobIdsToDelete = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const previousBlobIds = collectAllSessionBlobIds(db);
        db.prepare(DELETE_ALL_SESSIONS_SQL).run();
        const blobIdsToDelete = deleteUnreferencedBlobObjectRows(
          db,
          previousBlobIds,
        );
        db.exec("COMMIT");
        return blobIdsToDelete;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  /** 書き込みが確定しなかった場合に、DB に未登録の準備済み Blob だけを掃除する。 */
  private async deleteUnpersistedBlobs(
    blobIds: readonly string[],
  ): Promise<void> {
    const unpersistedBlobIds = this.withDb((db) => {
      const statement = db.prepare(IS_BLOB_OBJECT_PERSISTED_SQL);
      return [...new Set(blobIds)].filter((blobId) => !statement.get(blobId));
    });
    await this.blobStore.deleteUnreferenced(unpersistedBlobIds);
  }

  /** 開いている V3 の SQLite 接続を閉じ、以後は読み書きしない。 */
  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }
}
