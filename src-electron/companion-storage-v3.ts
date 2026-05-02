import type { DatabaseSync } from "node:sqlite";

import {
  cloneCompanionMergeRun,
  cloneCompanionMergeRunSummaries,
  cloneCompanionMergeRuns,
  cloneCompanionSessions,
  cloneCompanionSessionSummaries,
  type CompanionChangedFileSummary,
  type CompanionGroup,
  type CompanionMergeRun,
  type CompanionMergeRunSummary,
  type CompanionSession,
  type CompanionSessionSummary,
  type CompanionSiblingWarningSummary,
} from "../src/companion-state.js";
import type { ChangedFile, DiffRow } from "../src/runtime-state.js";
import { summarizeMessageArtifact, type Message, type MessageArtifact } from "../src/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";
import {
  V3_SUMMARY_JSON_MAX_LENGTH,
  V3_TEXT_PREVIEW_MAX_LENGTH,
} from "./database-schema-v3.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { type BlobRef, TextBlobStore } from "./text-blob-store.js";

type CompanionGroupRow = {
  id: string;
  repo_root: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type CompanionSessionRow = {
  id: string;
  group_id: string;
  task_title: string;
  status: string;
  repo_root: string;
  focus_path: string;
  target_branch: string;
  base_snapshot_ref: string;
  base_snapshot_commit: string;
  companion_branch: string;
  worktree_path: string;
  selected_paths_json: string;
  changed_files_summary_json: string;
  sibling_warnings_summary_json: string;
  allowed_additional_directories_json: string;
  run_state: string;
  thread_id: string;
  provider: string;
  catalog_revision: number;
  model: string;
  reasoning_effort: string;
  custom_agent_name: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  character_id: string;
  character_name: string;
  character_role_preview: string;
  character_role_blob_id: string | null;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  created_at: string;
  updated_at: string;
};

type CompanionMessageRow = {
  role: string;
  text_preview: string;
  text_blob_id: string | null;
  accent: number;
  artifact_available: number;
  artifact_summary_json: string | null;
  artifact_blob_id: string | null;
};

type CompanionMergeRunRow = {
  id: string;
  session_id: string;
  group_id: string;
  operation: string;
  selected_paths_json: string;
  changed_files_summary_json: string;
  sibling_warnings_summary_json: string;
  diff_snapshot_blob_id: string | null;
  created_at: string;
};

type BlobIdRow = {
  blob_id: string | null;
};

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

type StoredCompanionSessionPayload = {
  characterRole: BlobRef | null;
  messages: StoredMessagePayload[];
};

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

const DELETE_BLOB_OBJECT_SQL = "DELETE FROM blob_objects WHERE blob_id = ?";
const IS_BLOB_OBJECT_PERSISTED_SQL = "SELECT 1 FROM blob_objects WHERE blob_id = ? LIMIT 1";

const COMPANION_SESSION_COLUMNS = `
  id,
  group_id,
  task_title,
  status,
  repo_root,
  focus_path,
  target_branch,
  base_snapshot_ref,
  base_snapshot_commit,
  companion_branch,
  worktree_path,
  selected_paths_json,
  changed_files_summary_json,
  sibling_warnings_summary_json,
  allowed_additional_directories_json,
  run_state,
  thread_id,
  provider,
  catalog_revision,
  model,
  reasoning_effort,
  custom_agent_name,
  approval_mode,
  codex_sandbox_mode,
  character_id,
  character_name,
  character_role_preview,
  character_role_blob_id,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  created_at,
  updated_at
`;

const COMPANION_MERGE_RUN_COLUMNS = `
  id,
  session_id,
  group_id,
  operation,
  selected_paths_json,
  changed_files_summary_json,
  sibling_warnings_summary_json,
  diff_snapshot_blob_id,
  created_at
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

function summaryJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length <= V3_SUMMARY_JSON_MAX_LENGTH) {
    return text;
  }
  if (!Array.isArray(value)) {
    return JSON.stringify({ truncated: true });
  }

  const result: unknown[] = [];
  for (const item of value) {
    const next = [...result, item];
    const nextText = JSON.stringify(next);
    if (nextText.length > V3_SUMMARY_JSON_MAX_LENGTH) {
      break;
    }
    result.push(item);
  }
  return JSON.stringify(result);
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
            .filter((operation) => (
              typeof operation === "object" &&
              operation !== null &&
              typeof operation.type === "string" &&
              typeof operation.summary === "string"
            ))
            .map((operation) => {
              const candidate = operation as { type: string; summary: string };
              return { type: candidate.type, summary: candidate.summary };
            })
        : undefined,
      changedFiles: parsed.changedFiles
        .filter((file) => (
          typeof file === "object" &&
          file !== null &&
          (file.kind === "add" || file.kind === "edit" || file.kind === "delete") &&
          typeof file.path === "string"
        ))
        .map((file) => {
          const candidate = file as { kind: "add" | "edit" | "delete"; path: string; summary?: string };
          return {
            kind: candidate.kind,
            path: candidate.path,
            summary: typeof candidate.summary === "string" ? candidate.summary : "",
            diffRows: [],
          };
        }),
      runChecks: parsed.runChecks
        .filter((check) => (
          typeof check === "object" &&
          check !== null &&
          typeof check.label === "string" &&
          typeof check.value === "string"
        ))
        .map((check) => {
          const candidate = check as { label: string; value: string };
          return { label: candidate.label, value: candidate.value };
        }),
      detailAvailable: true,
    };
  } catch {
    return undefined;
  }
}

function parseJsonArray<T>(value: string, filter: (item: unknown) => T[]): T[] {
  if (!value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap(filter) : [];
  } catch {
    return [];
  }
}

function parseSelectedPaths(value: string): string[] {
  return parseJsonArray(value, (item) => (typeof item === "string" ? [item] : []));
}

function parseChangedFiles(value: string): CompanionChangedFileSummary[] {
  return parseJsonArray(value, (item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "path" in item &&
      "kind" in item &&
      typeof item.path === "string" &&
      (item.kind === "add" || item.kind === "edit" || item.kind === "delete")
    ) {
      return [{ path: item.path, kind: item.kind }];
    }
    return [];
  });
}

function parseSiblingWarnings(value: string): CompanionSiblingWarningSummary[] {
  return parseJsonArray(value, (item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      "sessionId" in item &&
      "taskTitle" in item &&
      "paths" in item &&
      "message" in item &&
      typeof item.sessionId === "string" &&
      typeof item.taskTitle === "string" &&
      Array.isArray(item.paths) &&
      typeof item.message === "string"
    ) {
      return [{
        sessionId: item.sessionId,
        taskTitle: item.taskTitle,
        paths: item.paths.filter((filePath): filePath is string => typeof filePath === "string"),
        message: item.message,
      }];
    }
    return [];
  });
}

function parseDiffRows(value: unknown): DiffRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): DiffRow[] => {
    if (
      typeof item === "object" &&
      item !== null &&
      "kind" in item &&
      (item.kind === "context" || item.kind === "add" || item.kind === "delete" || item.kind === "modify")
    ) {
      const row: DiffRow = { kind: item.kind };
      if ("leftNumber" in item && typeof item.leftNumber === "number") {
        row.leftNumber = item.leftNumber;
      }
      if ("rightNumber" in item && typeof item.rightNumber === "number") {
        row.rightNumber = item.rightNumber;
      }
      if ("leftText" in item && typeof item.leftText === "string") {
        row.leftText = item.leftText;
      }
      if ("rightText" in item && typeof item.rightText === "string") {
        row.rightText = item.rightText;
      }
      return [row];
    }
    return [];
  });
}

function parseDiffSnapshot(value: unknown): ChangedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ChangedFile[] => {
    if (
      typeof item === "object" &&
      item !== null &&
      "path" in item &&
      "kind" in item &&
      typeof item.path === "string" &&
      (item.kind === "add" || item.kind === "edit" || item.kind === "delete")
    ) {
      return [{
        path: item.path,
        kind: item.kind,
        summary: "summary" in item && typeof item.summary === "string" ? item.summary : `${item.kind}: ${item.path}`,
        diffRows: "diffRows" in item ? parseDiffRows(item.diffRows) : [],
      }];
    }
    return [];
  });
}

function rowToGroup(row: CompanionGroupRow): CompanionGroup {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function rowToSession(row: CompanionSessionRow, blobStore: TextBlobStore): Promise<CompanionSession> {
  return {
    id: row.id,
    groupId: row.group_id,
    taskTitle: row.task_title,
    status: row.status === "merged" || row.status === "discarded" || row.status === "recovery-required"
      ? row.status
      : "active",
    repoRoot: row.repo_root,
    focusPath: row.focus_path,
    targetBranch: row.target_branch,
    baseSnapshotRef: row.base_snapshot_ref,
    baseSnapshotCommit: row.base_snapshot_commit,
    companionBranch: row.companion_branch,
    worktreePath: row.worktree_path,
    selectedPaths: parseSelectedPaths(row.selected_paths_json),
    changedFiles: parseChangedFiles(row.changed_files_summary_json),
    siblingWarnings: parseSiblingWarnings(row.sibling_warnings_summary_json),
    allowedAdditionalDirectories: parseSelectedPaths(row.allowed_additional_directories_json),
    runState: row.run_state === "running" || row.run_state === "error" ? row.run_state : "idle",
    threadId: row.thread_id,
    provider: row.provider,
    catalogRevision: row.catalog_revision,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort:
      row.reasoning_effort === "minimal" ||
      row.reasoning_effort === "low" ||
      row.reasoning_effort === "medium" ||
      row.reasoning_effort === "high" ||
      row.reasoning_effort === "xhigh"
        ? row.reasoning_effort
        : DEFAULT_REASONING_EFFORT,
    customAgentName: row.custom_agent_name,
    approvalMode:
      row.approval_mode === "untrusted" || row.approval_mode === "on-failure" || row.approval_mode === "on-request"
        ? row.approval_mode
        : DEFAULT_APPROVAL_MODE,
    codexSandboxMode:
      row.codex_sandbox_mode === "read-only" ||
      row.codex_sandbox_mode === "workspace-write" ||
      row.codex_sandbox_mode === "workspace-write-network" ||
      row.codex_sandbox_mode === "danger-full-access"
        ? row.codex_sandbox_mode
        : DEFAULT_CODEX_SANDBOX_MODE,
    characterId: row.character_id,
    character: row.character_name,
    characterRoleMarkdown: row.character_role_blob_id
      ? await blobStore.getText(row.character_role_blob_id)
      : row.character_role_preview,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: [],
  };
}

async function rowToMessage(row: CompanionMessageRow, blobStore: TextBlobStore): Promise<Message> {
  return {
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.text_blob_id ? await blobStore.getText(row.text_blob_id) : row.text_preview,
    accent: row.accent === 1 ? true : undefined,
    artifact: row.artifact_available === 1 ? parseArtifactSummary(row.artifact_summary_json) : undefined,
  };
}

async function rowToMergeRun(row: CompanionMergeRunRow, blobStore: TextBlobStore): Promise<CompanionMergeRun> {
  let diffSnapshot: ChangedFile[] = [];
  if (row.diff_snapshot_blob_id) {
    try {
      diffSnapshot = parseDiffSnapshot(await blobStore.getJson<unknown>(row.diff_snapshot_blob_id));
    } catch {
      diffSnapshot = [];
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    groupId: row.group_id,
    operation: row.operation === "discard" ? "discard" : "merge",
    selectedPaths: parseSelectedPaths(row.selected_paths_json),
    changedFiles: parseChangedFiles(row.changed_files_summary_json),
    diffSnapshot,
    siblingWarnings: parseSiblingWarnings(row.sibling_warnings_summary_json),
    createdAt: row.created_at,
  };
}

function rowToMergeRunSummary(row: CompanionMergeRunRow): CompanionMergeRunSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    groupId: row.group_id,
    operation: row.operation === "discard" ? "discard" : "merge",
    selectedPaths: parseSelectedPaths(row.selected_paths_json),
    changedFiles: parseChangedFiles(row.changed_files_summary_json),
    siblingWarnings: parseSiblingWarnings(row.sibling_warnings_summary_json),
    diffSnapshotAvailable: row.diff_snapshot_blob_id !== null,
    createdAt: row.created_at,
  };
}

function sessionToSummary(
  session: CompanionSession,
  latestMergeRun: CompanionMergeRunSummary | null = null,
): CompanionSessionSummary {
  return {
    id: session.id,
    groupId: session.groupId,
    taskTitle: session.taskTitle,
    status: session.status,
    repoRoot: session.repoRoot,
    focusPath: session.focusPath,
    targetBranch: session.targetBranch,
    baseSnapshotRef: session.baseSnapshotRef,
    baseSnapshotCommit: session.baseSnapshotCommit,
    selectedPaths: session.selectedPaths,
    changedFiles: session.changedFiles,
    siblingWarnings: session.siblingWarnings,
    allowedAdditionalDirectories: session.allowedAdditionalDirectories,
    runState: session.runState,
    threadId: session.threadId,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    character: session.character,
    characterRoleMarkdown: session.characterRoleMarkdown,
    characterIconPath: session.characterIconPath,
    characterThemeColors: session.characterThemeColors,
    latestMergeRun,
    updatedAt: session.updatedAt,
  };
}

function rowToSessionSummary(
  row: CompanionSessionRow,
  latestMergeRun: CompanionMergeRunSummary | null = null,
): CompanionSessionSummary {
  return {
    id: row.id,
    groupId: row.group_id,
    taskTitle: row.task_title,
    status: row.status === "merged" || row.status === "discarded" || row.status === "recovery-required"
      ? row.status
      : "active",
    repoRoot: row.repo_root,
    focusPath: row.focus_path,
    targetBranch: row.target_branch,
    baseSnapshotRef: row.base_snapshot_ref,
    baseSnapshotCommit: row.base_snapshot_commit,
    selectedPaths: parseSelectedPaths(row.selected_paths_json),
    changedFiles: parseChangedFiles(row.changed_files_summary_json),
    siblingWarnings: parseSiblingWarnings(row.sibling_warnings_summary_json),
    allowedAdditionalDirectories: parseSelectedPaths(row.allowed_additional_directories_json),
    runState: row.run_state === "running" || row.run_state === "error" ? row.run_state : "idle",
    threadId: row.thread_id,
    provider: row.provider,
    model: row.model || DEFAULT_MODEL_ID,
    reasoningEffort: row.reasoning_effort === "minimal" ||
      row.reasoning_effort === "low" ||
      row.reasoning_effort === "medium" ||
      row.reasoning_effort === "high" ||
      row.reasoning_effort === "xhigh"
      ? row.reasoning_effort
      : DEFAULT_REASONING_EFFORT,
    approvalMode:
      row.approval_mode === "untrusted" || row.approval_mode === "on-failure" || row.approval_mode === "on-request"
        ? row.approval_mode
        : DEFAULT_APPROVAL_MODE,
    codexSandboxMode: row.codex_sandbox_mode === "read-only" ||
      row.codex_sandbox_mode === "workspace-write" ||
      row.codex_sandbox_mode === "workspace-write-network" ||
      row.codex_sandbox_mode === "danger-full-access"
      ? row.codex_sandbox_mode
      : DEFAULT_CODEX_SANDBOX_MODE,
    character: row.character_name,
    characterRoleMarkdown: row.character_role_preview,
    characterIconPath: row.character_icon_path,
    characterThemeColors: {
      main: row.character_theme_main,
      sub: row.character_theme_sub,
    },
    updatedAt: row.updated_at,
    latestMergeRun,
  };
}

function buildArtifactSummary(artifact: MessageArtifact | undefined): string {
  if (!artifact) {
    return "{}";
  }
  return summaryJson(summarizeMessageArtifact(artifact));
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

function insertBlobObjects(db: DatabaseSync, refs: ReadonlyArray<BlobRef | null>, createdAt: string): void {
  for (const ref of refs) {
    if (ref) {
      insertBlobObject(db, ref, createdAt);
    }
  }
}

function compactBlobIds(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function sessionPayloadBlobIds(payload: StoredCompanionSessionPayload): string[] {
  return compactBlobIds([
    payload.characterRole?.blobId,
    ...payload.messages.flatMap((message) => [
      message.text.blobId,
      message.artifact?.kind === "new" ? message.artifact.ref.blobId : null,
    ]),
  ]);
}

function blobRows(db: DatabaseSync, query: string, ...args: Array<string | number | null>): string[] {
  const rows = db.prepare(query).all(...args) as BlobIdRow[];
  return compactBlobIds(rows.map((row) => row.blob_id));
}

function collectCompanionSessionBlobIds(db: DatabaseSync, sessionId: string): string[] {
  return compactBlobIds([
    ...blobRows(db, "SELECT character_role_blob_id AS blob_id FROM companion_sessions WHERE id = ?", sessionId),
    ...blobRows(db, "SELECT text_blob_id AS blob_id FROM companion_messages WHERE session_id = ? AND text_blob_id IS NOT NULL", sessionId),
    ...blobRows(db, `
      SELECT a.artifact_blob_id AS blob_id
      FROM companion_message_artifacts AS a
      INNER JOIN companion_messages AS m ON m.id = a.message_id
      WHERE m.session_id = ? AND a.artifact_blob_id IS NOT NULL
    `, sessionId),
    ...blobRows(db, "SELECT diff_snapshot_blob_id AS blob_id FROM companion_merge_runs WHERE session_id = ? AND diff_snapshot_blob_id IS NOT NULL", sessionId),
    ...blobRows(db, `
      SELECT d.logical_prompt_blob_id AS blob_id
      FROM companion_audit_log_details AS d
      INNER JOIN companion_audit_logs AS a ON a.id = d.audit_log_id
      WHERE a.session_id = ? AND d.logical_prompt_blob_id IS NOT NULL
      UNION
      SELECT d.transport_payload_blob_id AS blob_id
      FROM companion_audit_log_details AS d
      INNER JOIN companion_audit_logs AS a ON a.id = d.audit_log_id
      WHERE a.session_id = ? AND d.transport_payload_blob_id IS NOT NULL
      UNION
      SELECT d.assistant_text_blob_id AS blob_id
      FROM companion_audit_log_details AS d
      INNER JOIN companion_audit_logs AS a ON a.id = d.audit_log_id
      WHERE a.session_id = ? AND d.assistant_text_blob_id IS NOT NULL
      UNION
      SELECT d.raw_items_blob_id AS blob_id
      FROM companion_audit_log_details AS d
      INNER JOIN companion_audit_logs AS a ON a.id = d.audit_log_id
      WHERE a.session_id = ? AND d.raw_items_blob_id IS NOT NULL
      UNION
      SELECT d.usage_blob_id AS blob_id
      FROM companion_audit_log_details AS d
      INNER JOIN companion_audit_logs AS a ON a.id = d.audit_log_id
      WHERE a.session_id = ? AND d.usage_blob_id IS NOT NULL
    `, sessionId, sessionId, sessionId, sessionId, sessionId),
    ...blobRows(db, `
      SELECT o.details_blob_id AS blob_id
      FROM companion_audit_log_operations AS o
      INNER JOIN companion_audit_logs AS a ON a.id = o.audit_log_id
      WHERE a.session_id = ? AND o.details_blob_id IS NOT NULL
    `, sessionId),
  ]);
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

function readCompanionArtifactRefs(db: DatabaseSync, sessionId: string): Map<number, ExistingMessageArtifactRef> {
  const rows = db.prepare(`
    SELECT
      m.position,
      a.artifact_summary_json,
      a.artifact_blob_id,
      a.artifact_original_bytes,
      a.artifact_stored_bytes
    FROM companion_message_artifacts AS a
    INNER JOIN companion_messages AS m ON m.id = a.message_id
    WHERE m.session_id = ?
      AND a.artifact_blob_id IS NOT NULL
  `).all(sessionId) as Array<{
    position: number;
    artifact_summary_json: string;
    artifact_blob_id: string | null;
    artifact_original_bytes: number;
    artifact_stored_bytes: number;
  }>;
  return new Map(rows.flatMap((row) => row.artifact_blob_id
    ? [[row.position, {
      summaryJson: row.artifact_summary_json,
      blobId: row.artifact_blob_id,
      originalBytes: row.artifact_original_bytes,
      storedBytes: row.artifact_stored_bytes,
    }] as const]
    : []));
}

async function storeSessionPayload(
  blobStore: TextBlobStore,
  session: CompanionSession,
  existingArtifactRefs: ReadonlyMap<number, ExistingMessageArtifactRef> = new Map(),
): Promise<StoredCompanionSessionPayload> {
  return {
    characterRole: session.characterRoleMarkdown
      ? await blobStore.putText({ contentType: "text/plain", text: session.characterRoleMarkdown })
      : null,
    messages: await Promise.all(session.messages.map(async (message, index) => ({
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
    }))),
  };
}

export class CompanionStorageV3 {
  private readonly db: DatabaseSync;
  private readonly blobStore: TextBlobStore;

  constructor(dbPath: string, blobRootPath: string) {
    this.db = openAppDatabase(dbPath);
    this.blobStore = new TextBlobStore(blobRootPath);
  }

  async ensureGroup(group: CompanionGroup): Promise<CompanionGroup> {
    this.db.prepare(`
      INSERT INTO companion_groups (id, repo_root, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repo_root) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run(group.id, group.repoRoot, group.displayName, group.createdAt, group.updatedAt);

    const row = this.db
      .prepare("SELECT id, repo_root, display_name, created_at, updated_at FROM companion_groups WHERE repo_root = ?")
      .get(group.repoRoot) as CompanionGroupRow | undefined;
    if (!row) {
      throw new Error("CompanionGroup の保存に失敗したよ。");
    }
    return rowToGroup(row);
  }

  async createSession(session: CompanionSession): Promise<CompanionSession> {
    return this.writeSession(session, false);
  }

  async updateSession(session: CompanionSession): Promise<CompanionSession> {
    return this.writeSession(session, true);
  }

  async updateSessionBaseSnapshot(session: CompanionSession): Promise<CompanionSession> {
    this.db.prepare(`
      UPDATE companion_sessions SET
        base_snapshot_commit = ?,
        selected_paths_json = ?,
        changed_files_summary_json = ?,
        sibling_warnings_summary_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      session.baseSnapshotCommit,
      JSON.stringify(session.selectedPaths),
      summaryJson(session.changedFiles),
      summaryJson(session.siblingWarnings),
      session.updatedAt,
      session.id,
    );
    return await this.getSession(session.id) ?? cloneCompanionSessions([session])[0] as CompanionSession;
  }

  async listSessionSummaries(): Promise<CompanionSessionSummary[]> {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      WHERE status NOT IN ('merged', 'discarded')
      ORDER BY updated_at DESC, id DESC
    `).all() as CompanionSessionRow[];
    return cloneCompanionSessionSummaries(await this.rowsToSummaries(rows, true));
  }

  async listActiveSessionSummaries(): Promise<CompanionSessionSummary[]> {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      WHERE status = 'active'
      ORDER BY updated_at DESC, id DESC
    `).all() as CompanionSessionRow[];
    return cloneCompanionSessionSummaries(await this.rowsToSummaries(rows, false));
  }

  async getSession(sessionId: string): Promise<CompanionSession | null> {
    const row = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      WHERE id = ?
    `).get(sessionId) as CompanionSessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = await rowToSession(row, this.blobStore);
    session.messages = await this.listMessages(session.id);
    return cloneCompanionSessions([session])[0] ?? null;
  }

  async getMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null> {
    const row = this.db.prepare(`
      SELECT a.artifact_blob_id AS blob_id
      FROM companion_messages AS m
      INNER JOIN companion_message_artifacts AS a ON a.message_id = m.id
      WHERE m.session_id = ?
        AND m.position = ?
        AND a.artifact_blob_id IS NOT NULL
    `).get(sessionId, messageIndex) as BlobIdRow | undefined;
    if (!row?.blob_id) {
      return null;
    }

    try {
      return await this.blobStore.getJson<MessageArtifact>(row.blob_id);
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const blobIdsToDelete = (() => {
      const previousBlobIds = collectCompanionSessionBlobIds(this.db, sessionId);
      this.db.prepare("DELETE FROM companion_sessions WHERE id = ?").run(sessionId);
      return deleteUnreferencedBlobObjectRows(this.db, previousBlobIds);
    })();
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  async createMergeRun(run: CompanionMergeRun): Promise<CompanionMergeRun> {
    const diffSnapshot = await this.blobStore.putJson({ value: run.diffSnapshot });
    try {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        insertBlobObject(this.db, diffSnapshot, run.createdAt);
        this.db.prepare(`
          INSERT INTO companion_merge_runs (
            ${COMPANION_MERGE_RUN_COLUMNS}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.id,
          run.sessionId,
          run.groupId,
          run.operation,
          JSON.stringify(run.selectedPaths),
          summaryJson(run.changedFiles),
          summaryJson(run.siblingWarnings),
          diffSnapshot.blobId,
          run.createdAt,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      await this.deleteUnpersistedBlobs([diffSnapshot.blobId]);
      throw error;
    }
    return cloneCompanionMergeRun(run);
  }

  async listMergeRunsForSession(sessionId: string): Promise<CompanionMergeRun[]> {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_MERGE_RUN_COLUMNS}
      FROM companion_merge_runs
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(sessionId) as CompanionMergeRunRow[];
    return cloneCompanionMergeRuns(await Promise.all(rows.map((row) => rowToMergeRun(row, this.blobStore))));
  }

  async listMergeRunSummariesForSession(sessionId: string): Promise<CompanionMergeRunSummary[]> {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_MERGE_RUN_COLUMNS}
      FROM companion_merge_runs
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(sessionId) as CompanionMergeRunRow[];
    return cloneCompanionMergeRunSummaries(rows.map(rowToMergeRunSummary));
  }

  async clearCompanions(): Promise<void> {
    const blobIdsToDelete = (() => {
      const sessionIds = (this.db.prepare("SELECT id FROM companion_sessions").all() as { id: string }[]).map((row) => row.id);
      const previousBlobIds = sessionIds.flatMap((sessionId) => collectCompanionSessionBlobIds(this.db, sessionId));
      this.db.exec("DELETE FROM companion_sessions; DELETE FROM companion_groups;");
      return deleteUnreferencedBlobObjectRows(this.db, previousBlobIds);
    })();
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
  }

  private async deleteUnpersistedBlobs(blobIds: readonly string[]): Promise<void> {
    const statement = this.db.prepare(IS_BLOB_OBJECT_PERSISTED_SQL);
    const unpersistedBlobIds = compactBlobIds(blobIds).filter((blobId) => !statement.get(blobId));
    await this.blobStore.deleteUnreferenced(unpersistedBlobIds);
  }

  close(): void {
    this.db.close();
  }

  private async writeSession(session: CompanionSession, updateOnly: boolean): Promise<CompanionSession> {
    const existingArtifactRefs = readCompanionArtifactRefs(this.db, session.id);
    const payload = await storeSessionPayload(this.blobStore, session, existingArtifactRefs);
    const previousBlobIds = collectCompanionSessionBlobIds(this.db, session.id);

    let blobIdsToDelete: string[] = [];
    try {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        insertBlobObjects(this.db, [
          payload.characterRole,
          ...payload.messages.flatMap((message) => [
            message.text,
            message.artifact?.kind === "new" ? message.artifact.ref : null,
          ]),
        ], session.updatedAt);
        if (updateOnly) {
          this.updateSessionRow(session, payload);
        } else {
          this.insertSessionRow(session, payload);
        }
        this.replaceMessages(session.id, session.messages, payload.messages, session.updatedAt);
        blobIdsToDelete = deleteUnreferencedBlobObjectRows(this.db, previousBlobIds);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      await this.deleteUnpersistedBlobs(sessionPayloadBlobIds(payload));
      throw error;
    }
    await this.blobStore.deleteUnreferenced(blobIdsToDelete);
    return await this.getSession(session.id) ?? cloneCompanionSessions([session])[0] as CompanionSession;
  }

  private insertSessionRow(session: CompanionSession, payload: StoredCompanionSessionPayload): void {
    this.db.prepare(`
      INSERT INTO companion_sessions (
        ${COMPANION_SESSION_COLUMNS},
        message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.groupId,
      session.taskTitle,
      session.status,
      session.repoRoot,
      session.focusPath,
      session.targetBranch,
      session.baseSnapshotRef,
      session.baseSnapshotCommit,
      session.companionBranch,
      session.worktreePath,
      JSON.stringify(session.selectedPaths),
      summaryJson(session.changedFiles),
      summaryJson(session.siblingWarnings),
      JSON.stringify(session.allowedAdditionalDirectories ?? []),
      session.runState,
      session.threadId,
      session.provider,
      session.catalogRevision,
      session.model,
      session.reasoningEffort,
      session.customAgentName,
      session.approvalMode,
      session.codexSandboxMode,
      session.characterId,
      session.character,
      preview(session.characterRoleMarkdown),
      payload.characterRole?.blobId ?? null,
      session.characterIconPath,
      session.characterThemeColors.main,
      session.characterThemeColors.sub,
      session.createdAt,
      session.updatedAt,
      session.messages.length,
    );
  }

  private updateSessionRow(session: CompanionSession, payload: StoredCompanionSessionPayload): void {
    this.db.prepare(`
      UPDATE companion_sessions SET
        task_title = ?,
        status = ?,
        selected_paths_json = ?,
        changed_files_summary_json = ?,
        sibling_warnings_summary_json = ?,
        allowed_additional_directories_json = ?,
        run_state = ?,
        thread_id = ?,
        provider = ?,
        catalog_revision = ?,
        model = ?,
        reasoning_effort = ?,
        custom_agent_name = ?,
        approval_mode = ?,
        codex_sandbox_mode = ?,
        character_id = ?,
        character_name = ?,
        character_role_preview = ?,
        character_role_blob_id = ?,
        character_icon_path = ?,
        character_theme_main = ?,
        character_theme_sub = ?,
        message_count = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      session.taskTitle,
      session.status,
      JSON.stringify(session.selectedPaths),
      summaryJson(session.changedFiles),
      summaryJson(session.siblingWarnings),
      JSON.stringify(session.allowedAdditionalDirectories ?? []),
      session.runState,
      session.threadId,
      session.provider,
      session.catalogRevision,
      session.model,
      session.reasoningEffort,
      session.customAgentName,
      session.approvalMode,
      session.codexSandboxMode,
      session.characterId,
      session.character,
      preview(session.characterRoleMarkdown),
      payload.characterRole?.blobId ?? null,
      session.characterIconPath,
      session.characterThemeColors.main,
      session.characterThemeColors.sub,
      session.messages.length,
      session.updatedAt,
      session.id,
    );
  }

  private replaceMessages(
    sessionId: string,
    messages: Message[],
    payloads: StoredMessagePayload[],
    createdAt: string,
  ): void {
    this.db.prepare("DELETE FROM companion_messages WHERE session_id = ?").run(sessionId);
    const messageStatement = this.db.prepare(`
      INSERT INTO companion_messages (
        session_id,
        position,
        role,
        text_preview,
        text_blob_id,
        text_original_bytes,
        text_stored_bytes,
        accent,
        artifact_available,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const artifactStatement = this.db.prepare(`
      INSERT INTO companion_message_artifacts (
        message_id,
        artifact_summary_json,
        artifact_blob_id,
        artifact_original_bytes,
        artifact_stored_bytes
      ) VALUES (?, ?, ?, ?, ?)
    `);

    messages.forEach((message, index) => {
      const payload = payloads[index];
      if (!payload) {
        return;
      }
      const result = messageStatement.run(
        sessionId,
        index,
        message.role,
        preview(message.text),
        payload.text.blobId,
        payload.text.originalBytes,
        payload.text.storedBytes,
        message.accent ? 1 : 0,
        message.artifact ? 1 : 0,
        createdAt,
      );
      if (message.artifact && payload.artifact) {
        const artifactBlob = artifactBlobMetadata(payload.artifact);
        artifactStatement.run(
          Number(result.lastInsertRowid),
          buildArtifactSummary(message.artifact),
          artifactBlob.blobId,
          artifactBlob.originalBytes,
          artifactBlob.storedBytes,
        );
      }
    });
  }

  private async listMessages(sessionId: string): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT
        m.role,
        m.text_preview,
        m.text_blob_id,
        m.accent,
        m.artifact_available,
        a.artifact_summary_json,
        a.artifact_blob_id
      FROM companion_messages AS m
      LEFT JOIN companion_message_artifacts AS a ON a.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.position ASC
    `).all(sessionId) as CompanionMessageRow[];
    return Promise.all(rows.map((row) => rowToMessage(row, this.blobStore)));
  }

  private async rowsToSummaries(rows: CompanionSessionRow[], includeLatestMergeRun: boolean): Promise<CompanionSessionSummary[]> {
    const summaries: CompanionSessionSummary[] = [];
    for (const row of rows) {
      summaries.push(rowToSessionSummary(
        row,
        includeLatestMergeRun ? this.getLatestMergeRunSummaryForSession(row.id) : null,
      ));
    }
    return summaries;
  }

  private getLatestMergeRunSummaryForSession(sessionId: string): CompanionMergeRunSummary | null {
    const row = this.db.prepare(`
      SELECT ${COMPANION_MERGE_RUN_COLUMNS}
      FROM companion_merge_runs
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(sessionId) as CompanionMergeRunRow | undefined;
    return row ? rowToMergeRunSummary(row) : null;
  }
}
