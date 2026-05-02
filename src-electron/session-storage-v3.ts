import type { DatabaseSync } from "node:sqlite";

import {
  cloneSessionSummaries,
  cloneSessions,
  normalizeSession,
  normalizeSessionSummary,
  summarizeMessageArtifact,
  type Message,
  type MessageArtifact,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import type { AuditLogOperation, ChangedFile, RunCheck } from "../src/runtime-state.js";
import { V3_SUMMARY_JSON_MAX_LENGTH, V3_TEXT_PREVIEW_MAX_LENGTH } from "./database-schema-v3.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { type BlobRef, TextBlobStore } from "./text-blob-store.js";

type SessionHeaderRow = {
  id: string;
  task_title: string;
  task_summary: string;
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
};

type SessionAuditLogCountRow = {
  id: string;
  audit_log_count: number;
};

type SessionAuditLogCountValueRow = {
  audit_log_count: number;
};

type SessionIdRow = {
  id: string;
};

type SessionMessageRow = {
  role: string;
  text_preview: string;
  text_blob_id: string | null;
  accent: number;
  artifact_available: number;
  artifact_summary_json: string | null;
  artifact_blob_id: string | null;
};

type BlobIdRow = {
  blob_id: string | null;
};

type SessionRowParseMode = "skip" | "throw";

type ExistingMessageArtifactRef = {
  summaryJson: string;
  blobId: string;
  originalBytes: number;
  storedBytes: number;
};

type StoredArtifactPayload =
  | { kind: "new"; ref: BlobRef }
  | { kind: "preserved"; ref: ExistingMessageArtifactRef };

type StoredMessagePayload = {
  text: BlobRef;
  artifact: StoredArtifactPayload | null;
};

const UPSERT_SESSION_SQL = `
  INSERT INTO sessions (
    id,
    task_title,
    task_summary,
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
    audit_log_count,
    last_active_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_title = excluded.task_title,
    task_summary = excluded.task_summary,
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
    audit_log_count = excluded.audit_log_count,
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

const DELETE_SESSION_MESSAGES_SQL = "DELETE FROM session_messages WHERE session_id = ?";
const DELETE_SESSION_SQL = "DELETE FROM sessions WHERE id = ?";
const DELETE_ALL_SESSIONS_SQL = "DELETE FROM sessions";
const LIST_SESSION_IDS_SQL = "SELECT id FROM sessions";
const DELETE_BLOB_OBJECT_SQL = "DELETE FROM blob_objects WHERE blob_id = ?";
const IS_BLOB_OBJECT_PERSISTED_SQL = "SELECT 1 FROM blob_objects WHERE blob_id = ? LIMIT 1";

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
    artifact_available,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const GET_SESSION_AUDIT_LOG_COUNT_SQL = "SELECT audit_log_count FROM sessions WHERE id = ?";
const LIST_SESSION_AUDIT_LOG_COUNTS_SQL = "SELECT id, audit_log_count FROM sessions";

const SESSION_HEADER_COLUMNS = `
  id,
  task_title,
  task_summary,
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

const LIST_SESSION_SUMMARIES_SQL = `
  SELECT
    ${SESSION_HEADER_COLUMNS}
  FROM sessions
  ORDER BY last_active_at DESC, id DESC
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
    m.text_preview,
    m.text_blob_id,
    m.accent,
    m.artifact_available,
    a.artifact_summary_json,
    a.artifact_blob_id
  FROM session_messages AS m
  LEFT JOIN session_message_artifacts AS a
    ON a.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.seq ASC
`;

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

const LIST_SESSION_AUDIT_DETAIL_BLOB_IDS_SQL = `
  SELECT logical_prompt_blob_id AS blob_id
  FROM audit_log_details AS d
  INNER JOIN audit_logs AS a
    ON a.id = d.audit_log_id
  WHERE a.session_id = ?
    AND logical_prompt_blob_id IS NOT NULL
  UNION
  SELECT transport_payload_blob_id AS blob_id
  FROM audit_log_details AS d
  INNER JOIN audit_logs AS a
    ON a.id = d.audit_log_id
  WHERE a.session_id = ?
    AND transport_payload_blob_id IS NOT NULL
  UNION
  SELECT assistant_text_blob_id AS blob_id
  FROM audit_log_details AS d
  INNER JOIN audit_logs AS a
    ON a.id = d.audit_log_id
  WHERE a.session_id = ?
    AND assistant_text_blob_id IS NOT NULL
  UNION
  SELECT raw_items_blob_id AS blob_id
  FROM audit_log_details AS d
  INNER JOIN audit_logs AS a
    ON a.id = d.audit_log_id
  WHERE a.session_id = ?
    AND raw_items_blob_id IS NOT NULL
  UNION
  SELECT usage_blob_id AS blob_id
  FROM audit_log_details AS d
  INNER JOIN audit_logs AS a
    ON a.id = d.audit_log_id
  WHERE a.session_id = ?
    AND usage_blob_id IS NOT NULL
`;

const LIST_SESSION_AUDIT_OPERATION_BLOB_IDS_SQL = `
  SELECT o.details_blob_id AS blob_id
  FROM audit_log_operations AS o
  INNER JOIN audit_logs AS a
    ON a.id = o.audit_log_id
  WHERE a.session_id = ?
    AND o.details_blob_id IS NOT NULL
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

const LIST_ALL_SESSION_AUDIT_DETAIL_BLOB_IDS_SQL = `
  SELECT logical_prompt_blob_id AS blob_id
  FROM audit_log_details
  WHERE logical_prompt_blob_id IS NOT NULL
  UNION
  SELECT transport_payload_blob_id AS blob_id
  FROM audit_log_details
  WHERE transport_payload_blob_id IS NOT NULL
  UNION
  SELECT assistant_text_blob_id AS blob_id
  FROM audit_log_details
  WHERE assistant_text_blob_id IS NOT NULL
  UNION
  SELECT raw_items_blob_id AS blob_id
  FROM audit_log_details
  WHERE raw_items_blob_id IS NOT NULL
  UNION
  SELECT usage_blob_id AS blob_id
  FROM audit_log_details
  WHERE usage_blob_id IS NOT NULL
`;

const LIST_ALL_SESSION_AUDIT_OPERATION_BLOB_IDS_SQL = `
  SELECT details_blob_id AS blob_id
  FROM audit_log_operations
  WHERE details_blob_id IS NOT NULL
`;

const LIVE_BLOB_REF_QUERIES = [
  "SELECT 1 FROM session_messages WHERE text_blob_id = ? LIMIT 1",
  "SELECT 1 FROM session_message_artifacts WHERE artifact_blob_id = ? LIMIT 1",
  "SELECT 1 FROM audit_log_details WHERE logical_prompt_blob_id = ? OR transport_payload_blob_id = ? OR assistant_text_blob_id = ? OR raw_items_blob_id = ? OR usage_blob_id = ? LIMIT 1",
  "SELECT 1 FROM audit_log_operations WHERE details_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_sessions WHERE character_role_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_messages WHERE text_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_message_artifacts WHERE artifact_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_merge_runs WHERE diff_snapshot_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_audit_log_details WHERE logical_prompt_blob_id = ? OR transport_payload_blob_id = ? OR assistant_text_blob_id = ? OR raw_items_blob_id = ? OR usage_blob_id = ? LIMIT 1",
  "SELECT 1 FROM companion_audit_log_operations WHERE details_blob_id = ? LIMIT 1",
] as const;

function preview(value: string): string {
  return value.length > V3_TEXT_PREVIEW_MAX_LENGTH ? value.slice(0, V3_TEXT_PREVIEW_MAX_LENGTH) : value;
}

function parseAllowedAdditionalDirectories(row: SessionHeaderRow, mode: SessionRowParseMode): string[] | null {
  try {
    const parsed = JSON.parse(row.allowed_additional_directories_json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : null;
  } catch (error) {
    console.error("stored session JSON parse failed", {
      sessionId: row.id,
      columnName: "allowed_additional_directories_json",
      error,
    });
    if (mode === "throw") {
      throw new Error(`保存済み session ${row.id} の allowed_additional_directories_json が壊れているよ。`);
    }
    return null;
  }
}

function rowToSessionSummary(row: SessionHeaderRow, mode: SessionRowParseMode = "skip"): SessionSummary | null {
  const allowedAdditionalDirectories = parseAllowedAdditionalDirectories(row, mode);
  if (!allowedAdditionalDirectories) {
    return null;
  }

  const summary = normalizeSessionSummary({
    id: row.id,
    taskTitle: row.task_title,
    taskSummary: row.task_summary,
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

function rowToSession(row: SessionHeaderRow, messages: Message[], mode: SessionRowParseMode = "skip"): Session | null {
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

function readAuditLogCountRows(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(LIST_SESSION_AUDIT_LOG_COUNTS_SQL).all() as SessionAuditLogCountRow[];
  return new Map(rows.map((row) => [row.id, row.audit_log_count]));
}

function readSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(LIST_SESSION_IDS_SQL).all() as SessionIdRow[];
  return new Set(rows.map((row) => row.id));
}

function getAuditLogCountFromDb(db: DatabaseSync, sessionId: string): number {
  const row = db.prepare(GET_SESSION_AUDIT_LOG_COUNT_SQL).get(sessionId) as SessionAuditLogCountValueRow | undefined;
  return row?.audit_log_count ?? 0;
}

function writeSessionHeader(
  statement: ReturnType<DatabaseSync["prepare"]>,
  session: Session,
  lastActiveAt: number,
  auditLogCount: number,
): void {
  statement.run(
    session.id,
    session.taskTitle,
    session.taskSummary,
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
    auditLogCount,
    lastActiveAt,
  );
}

function insertBlobObject(db: DatabaseSync, ref: BlobRef, createdAt: string): void {
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

function insertBlobObjects(db: DatabaseSync, payloads: readonly StoredMessagePayload[], createdAt: string): void {
  for (const payload of payloads) {
    insertBlobObject(db, payload.text, createdAt);
    if (payload.artifact?.kind === "new") {
      insertBlobObject(db, payload.artifact.ref, createdAt);
    }
  }
}

function payloadBlobIds(payloads: readonly StoredMessagePayload[]): string[] {
  return payloads.flatMap((payload) => [
    payload.text.blobId,
    ...(payload.artifact?.kind === "new" ? [payload.artifact.ref.blobId] : []),
  ]);
}

function parseArtifactSummary(value: string | null): MessageArtifact | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<MessageArtifact>;
    if (!Array.isArray(parsed.activitySummary) || !Array.isArray(parsed.changedFiles) || !Array.isArray(parsed.runChecks)) {
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
      activitySummary: parsed.activitySummary.filter((item): item is string => typeof item === "string"),
      operationTimeline: Array.isArray(parsed.operationTimeline)
        ? parsed.operationTimeline
            .filter((operation): operation is AuditLogOperation =>
              typeof operation === "object" &&
              operation !== null &&
              typeof operation.type === "string" &&
              typeof operation.summary === "string",
            )
            .map((operation) => ({ type: operation.type, summary: operation.summary }))
        : undefined,
      changedFiles: parsed.changedFiles
        .filter((file): file is ChangedFile =>
          typeof file === "object" &&
          file !== null &&
          (file.kind === "add" || file.kind === "edit" || file.kind === "delete") &&
          typeof file.path === "string",
        )
        .map((file) => ({
          kind: file.kind,
          path: file.path,
          summary: typeof file.summary === "string" ? file.summary : "",
          diffRows: [],
        })),
      runChecks: parsed.runChecks
        .filter((check): check is RunCheck =>
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

function buildArtifactSummary(artifact: MessageArtifact): string {
  return JSON.stringify(limitArtifactSummary(summarizeMessageArtifact(artifact)));
}

function limitArtifactSummary(summary: MessageArtifact): MessageArtifact {
  const limited: MessageArtifact = {
    ...summary,
    activitySummary: [...summary.activitySummary],
    operationTimeline: summary.operationTimeline ? [...summary.operationTimeline] : undefined,
    changedFiles: [...summary.changedFiles],
    runChecks: [...summary.runChecks],
    detailAvailable: true,
  };
  const arrayKeys = ["changedFiles", "runChecks", "activitySummary", "operationTimeline"] as const;
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

function isArtifactSummaryOnly(artifact: MessageArtifact): boolean {
  return artifact.detailAvailable === true && artifact.changedFiles.every((file) => file.diffRows.length === 0);
}

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

function compactBlobIds(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function collectSessionBlobIds(db: DatabaseSync, sessionId: string): string[] {
  const messageRows = db.prepare(LIST_SESSION_MESSAGE_BLOB_IDS_SQL).all(sessionId) as BlobIdRow[];
  const artifactRows = db.prepare(LIST_SESSION_ARTIFACT_BLOB_IDS_SQL).all(sessionId) as BlobIdRow[];
  const auditDetailRows = db.prepare(LIST_SESSION_AUDIT_DETAIL_BLOB_IDS_SQL).all(
    sessionId,
    sessionId,
    sessionId,
    sessionId,
    sessionId,
  ) as BlobIdRow[];
  const auditOperationRows = db.prepare(LIST_SESSION_AUDIT_OPERATION_BLOB_IDS_SQL).all(sessionId) as BlobIdRow[];
  return compactBlobIds([...messageRows, ...artifactRows, ...auditDetailRows, ...auditOperationRows].map((row) => row.blob_id));
}

function collectAllSessionBlobIds(db: DatabaseSync): string[] {
  const messageRows = db.prepare(LIST_ALL_SESSION_MESSAGE_BLOB_IDS_SQL).all() as BlobIdRow[];
  const artifactRows = db.prepare(LIST_ALL_SESSION_ARTIFACT_BLOB_IDS_SQL).all() as BlobIdRow[];
  const auditDetailRows = db.prepare(LIST_ALL_SESSION_AUDIT_DETAIL_BLOB_IDS_SQL).all() as BlobIdRow[];
  const auditOperationRows = db.prepare(LIST_ALL_SESSION_AUDIT_OPERATION_BLOB_IDS_SQL).all() as BlobIdRow[];
  return compactBlobIds([...messageRows, ...artifactRows, ...auditDetailRows, ...auditOperationRows].map((row) => row.blob_id));
}

function isBlobReferenced(db: DatabaseSync, blobId: string): boolean {
  return LIVE_BLOB_REF_QUERIES.some((query) => {
    const parameterCount = (query.match(/\?/g) ?? []).length;
    return db.prepare(query).get(...Array.from({ length: parameterCount }, () => blobId)) !== undefined;
  });
}

function deleteUnreferencedBlobObjectRows(db: DatabaseSync, blobIds: readonly string[]): string[] {
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

function readSessionArtifactRefs(db: DatabaseSync, sessionId: string): Map<number, ExistingMessageArtifactRef> {
  const rows = db.prepare(LIST_SESSION_ARTIFACT_REFS_SQL).all(sessionId) as Array<{
    seq: number;
    artifact_summary_json: string;
    artifact_blob_id: string | null;
    artifact_original_bytes: number;
    artifact_stored_bytes: number;
  }>;
  return new Map(rows.flatMap((row) => row.artifact_blob_id
    ? [[row.seq, {
      summaryJson: row.artifact_summary_json,
      blobId: row.artifact_blob_id,
      originalBytes: row.artifact_original_bytes,
      storedBytes: row.artifact_stored_bytes,
    }] as const]
    : []));
}

async function storeMessagePayloads(
  blobStore: TextBlobStore,
  session: Session,
  existingArtifactRefs: ReadonlyMap<number, ExistingMessageArtifactRef> = new Map(),
): Promise<StoredMessagePayload[]> {
  return Promise.all(session.messages.map(async (message, index) => ({
    text: await blobStore.putText({ contentType: "text/plain", text: message.text }),
    artifact: message.artifact
      ? (() => {
        const existing = existingArtifactRefs.get(index);
        if (
          existing &&
          isArtifactSummaryOnly(message.artifact) &&
          buildArtifactSummary(message.artifact) === existing.summaryJson
        ) {
          return { kind: "preserved", ref: existing } satisfies StoredArtifactPayload;
        }
        return null;
      })() ?? { kind: "new", ref: await blobStore.putJson({ value: message.artifact }) }
      : null,
  })));
}

export class SessionStorageV3 {
  private db: DatabaseSync | null;
  private readonly blobStore: TextBlobStore;

  constructor(dbPath: string, blobRootPath: string) {
    this.db = openAppDatabase(dbPath);
    this.blobStore = new TextBlobStore(blobRootPath);
  }

  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("SessionStorageV3 は close 済みだよ。");
    }

    return runner(this.db);
  }

  private async rowToMessage(row: SessionMessageRow): Promise<Message | null> {
    if (row.role !== "user" && row.role !== "assistant") {
      return null;
    }

    return {
      role: row.role,
      text: row.text_blob_id ? await this.blobStore.getText(row.text_blob_id) : row.text_preview,
      accent: row.accent === 1 ? true : undefined,
      artifact: row.artifact_available === 1 ? parseArtifactSummary(row.artifact_summary_json) : undefined,
    };
  }

  async listSessions(): Promise<Session[]> {
    const summaries = await this.listSessionSummaries();
    const sessions = await Promise.all(summaries.map((summary) => this.getSession(summary.id)));
    return cloneSessions(sessions.filter((session): session is Session => session !== null));
  }

  async listSessionSummaries(): Promise<SessionSummary[]> {
    return this.withDb((db) => {
      const rows = db.prepare(LIST_SESSION_SUMMARIES_SQL).all() as SessionHeaderRow[];
      return cloneSessionSummaries(
        rows.map((row) => rowToSessionSummary(row)).filter((session): session is SessionSummary => session !== null),
      );
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const result = this.withDb((db) => {
      const row = db.prepare(GET_SESSION_HEADER_SQL).get(sessionId) as SessionHeaderRow | undefined;
      if (!row) {
        return null;
      }

      const messageRows = db.prepare(LIST_SESSION_MESSAGES_SQL).all(sessionId) as SessionMessageRow[];
      return { row, messageRows };
    });
    if (!result) {
      return null;
    }

    const messages = (await Promise.all(result.messageRows.map((messageRow) => this.rowToMessage(messageRow))))
      .filter((message): message is Message => message !== null);
    const session = rowToSession(result.row, messages, "throw");
    return session ? cloneSessions([session])[0] : null;
  }

  async getSessionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null> {
    const blobId = this.withDb((db) => {
      const row = db.prepare(GET_SESSION_MESSAGE_ARTIFACT_SQL).get(sessionId, messageIndex) as BlobIdRow | undefined;
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

  async upsertSession(session: Session): Promise<Session> {
    return this.upsertSessionWithLastActiveAt(session, Date.now());
  }

  async upsertSessionWithLastActiveAt(session: Session, lastActiveAt: number): Promise<Session> {
    const normalized = normalizeSession(session);
    if (!normalized) {
      throw new Error("保存するセッション形式が不正だよ。");
    }

    const existingArtifactRefs = this.withDb((db) => readSessionArtifactRefs(db, normalized.id));
    const payloads = await storeMessagePayloads(this.blobStore, normalized, existingArtifactRefs);

    let blobIdsToDelete: string[];
    try {
      blobIdsToDelete = this.withDb((db) => {
        const auditLogCount = getAuditLogCountFromDb(db, normalized.id);
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
          writeSessionHeader(upsertSessionStatement, normalized, lastActiveAt, auditLogCount);
          deleteMessagesStatement.run(normalized.id);
          writeSessionMessages(insertMessageStatement, insertArtifactStatement, normalized, payloads);
          blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
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

  async replaceSessions(nextSessions: Session[]): Promise<Session[]> {
    const normalizedSessions = nextSessions.map((session) => {
      const normalized = normalizeSession(session);
      if (!normalized) {
        throw new Error("保存するセッション形式が不正だよ。");
      }

      return normalized;
    });
    const existingArtifactRefsBySessionId = this.withDb((db) => new Map(
      normalizedSessions.map((session) => [session.id, readSessionArtifactRefs(db, session.id)] as const),
    ));
    const payloadsBySessionId = new Map(await Promise.all(
      normalizedSessions.map(async (session) => [
        session.id,
        await storeMessagePayloads(this.blobStore, session, existingArtifactRefsBySessionId.get(session.id)),
      ] as const),
    ));

    const stagedBlobIds = [...payloadsBySessionId.values()].flatMap((payloads) => payloadBlobIds(payloads));
    let blobIdsToDelete: string[];
    try {
      blobIdsToDelete = this.withDb((db) => {
        const existingAuditLogCounts = readAuditLogCountRows(db);
        const existingSessionIds = readSessionIds(db);
        const nextSessionIds = new Set(normalizedSessions.map((session) => session.id));
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
              previousBlobIds.push(...collectSessionBlobIds(db, existingSessionId));
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
              existingAuditLogCounts.get(session.id) ?? 0,
            );
            deleteMessagesStatement.run(session.id);
            writeSessionMessages(insertMessageStatement, insertArtifactStatement, session, payloads);
          });
          blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
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

  async deleteSession(sessionId: string): Promise<void> {
    const blobIdsToDelete = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const previousBlobIds = collectSessionBlobIds(db, sessionId);
        db.prepare(DELETE_SESSION_SQL).run(sessionId);
        const blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
        db.exec("COMMIT");
        return blobIdsToDelete;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  async clearSessions(): Promise<void> {
    const blobIdsToDelete = this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const previousBlobIds = collectAllSessionBlobIds(db);
        db.prepare(DELETE_ALL_SESSIONS_SQL).run();
        const blobIdsToDelete = deleteUnreferencedBlobObjectRows(db, previousBlobIds);
        db.exec("COMMIT");
        return blobIdsToDelete;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  private async deleteUnpersistedBlobs(blobIds: readonly string[]): Promise<void> {
    const unpersistedBlobIds = this.withDb((db) => {
      const statement = db.prepare(IS_BLOB_OBJECT_PERSISTED_SQL);
      return [...new Set(blobIds)].filter((blobId) => !statement.get(blobId));
    });
    await this.blobStore.deleteUnreferenced(unpersistedBlobIds);
  }

  close(): void {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = null;
  }
}
