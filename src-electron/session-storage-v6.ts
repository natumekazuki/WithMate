import { workItemDecisionRevisionMatchesSql } from "./work-item-decision-revision-sql.js";
import { SESSION_ROLE_CHILDREN, type SessionRole } from "../src/session-role-binding.js";
import { restoreRootBudgetWithinTransaction } from "./session-lifecycle-restore.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SessionCrudError } from "./session-crud-service.js";
import { restoreRootWorkItemWithinTransaction } from "./work-item-storage-v6.js";
import { applySessionMove } from "./session-lifecycle-move.js";
import { validateSessionConstruction, initializeSessionConstruction } from "./session-lifecycle-creation.js";
import type { SessionRuntimeCreateInput } from "../src/session-external-runtime-contract.js";

import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
  CURRENT_SESSION_SCHEMA_VERSION,
  normalizeMessage,
  normalizeHomeSessionSummary,
  normalizeSession,
  normalizeSessionSummary,
  summarizeMessageArtifact,
  type Message,
  type MessageArtifact,
  type HomeSessionSummary,
  type HomeSessionSummaryPageResult,
  type Session,
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type SessionSummary,
} from "../src/session-state.js";
import type { RelatedSessionSummary } from "../src/related-session-details.js";
import {
  requireSessionRoleBinding,
  sameSessionRoleBinding,
  type SessionRoleBinding,
} from "../src/session-role-binding.js";
import type { SessionTurnAuthoritySession } from "../src/session-turn-communication-authority.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  type MutationAuthorityProof,
} from "../src/session-authority.js";
import {
  assertWorkItemEventPayloadWithinLimit,
  type WorkItemCreatedEventPayload,
} from "../src/work-item.js";
import { normalizeProviderId } from "../src/model-catalog.js";
import {
  parseCharacterRuntimeSnapshotJson,
  stringifyCharacterRuntimeSnapshot,
} from "../src/character/character-runtime-snapshot.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../src/character-state.js";
import {
  UNKNOWN_CHARACTER_OWNER_ID,
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
  recoverStoredCharacterOwnerId,
} from "../src/character/character-owner.js";
import {
  registerSessionProviderIdNormalizer,
  SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION,
} from "./session-provider-id-sql.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import {
  appendSessionFileSagaEvent,
  appendSessionResourceEvent,
  appendWorkItemEventHeader,
  claimSessionContainerRevision,
  createSagaOperationId,
  getSessionResourceRevision as readSessionResourceRevision,
  SessionResourceRevisionConflictError,
} from "./resource-history-schema.js";
import {
  assertGrantProofCurrent,
  createDelegatedChildAuthority,
  ensureBaselineSessionAuthority,
} from "./session-authority-storage.js";
import {
  SessionIdCollisionError,
  SessionRunningTurnStartConflictError,
} from "./session-storage-errors.js";
import {
  buildSessionSummaryKeysetClause,
  buildSessionSummarySearchClause,
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "./session-summary-query.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../src/withmate-window-types.js";
import {
  writeSessionTurnTerminalCommit,
  type SessionTurnTerminalCommit,
} from "./session-turn-terminal-commit.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";
import type { SessionRuntimeDeleteManifestResult, SessionRuntimeSessionMoveManifestResult } from "../src/session-external-runtime-contract.js";
import {
  SessionLifecycleStorage,
  type PrepareLifecycleMutationInput,
  type SessionLifecycleOperationRecord,
  type SessionLifecycleOperation,
} from "./session-lifecycle-storage.js";
import { buildSessionLifecycleManifest } from "./session-lifecycle-manifest.js";

type SessionV6Row = {
  id: string;
  title: string;
  state: string;
  session_kind: string;
  provider_id: string;
  catalog_revision: number;
  model_id: string;
  reasoning_effort: string;
  custom_agent_name: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  allowed_additional_directories_json: string;
  runtime_policy_json: string;
  thread_id: string;
  character_id: string | null;
  character_snapshot_json: string | null;
  workspace_path: string;
  is_pinned: number;
  updated_at: string;
  last_active_at: string;
  role_session_role: string | null;
  role_contract_revision: number | null;
  role_root_session_id: string | null;
  role_parent_session_id: string | null;
  role_delegation_depth: number | null;
};

type HomeSessionSummaryV6Row = {
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
  character_name: string | null;
  character_icon_path: string | null;
  character_theme_main: string | null;
  character_theme_sub: string | null;
  run_state: string | null;
  is_pinned: number;
  last_active_at: string;
};

type MessageV6Row = {
  role: "user" | "assistant" | "tool" | "system";
  body: string;
  artifact_body?: string | null;
};

type ExistingMessageArtifactRow = {
  seq: number;
  artifact_body: string | null;
};

type SessionIdRow = {
  id: string;
};

type SessionMessageSequenceRow = {
  seq: number;
};

type SessionCharacterUsageRow = {
  character_id: string | null;
};

type RelatedSessionSummaryRow = {
  session_id: string;
  task_title: string;
};

type SessionTurnAuthorityRow = {
  session_id: string;
  title: string;
  session_role: string;
  role_contract_revision: number;
  root_session_id: string;
  parent_session_id: string | null;
  delegation_depth: number;
};

type SessionV6SummaryBaseRow = Omit<SessionV6Row, "character_snapshot_json">;

type SessionV6SummaryRow = SessionV6SummaryBaseRow & {
  character_snapshot_present: number;
  snapshot_json_valid: number;
  snapshot_character_id: unknown;
  snapshot_name: unknown;
  snapshot_icon_file_path: unknown;
  snapshot_theme_main: unknown;
  snapshot_theme_sub: unknown;
  snapshot_definition_markdown_type: string | null;
};

const SESSION_SUMMARY_SELECT_COLUMNS = `
  id,
  title,
  state,
  session_kind,
  provider_id,
  catalog_revision,
  model_id,
  reasoning_effort,
  custom_agent_name,
  approval_mode,
  codex_sandbox_mode,
  allowed_additional_directories_json,
  runtime_policy_json,
  thread_id,
  character_id,
  workspace_path,
  is_pinned,
  updated_at,
  last_active_at,
  character_snapshot_json IS NOT NULL AS character_snapshot_present,
  CASE WHEN json_valid(character_snapshot_json) THEN 1 ELSE 0 END AS snapshot_json_valid,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.characterId') END AS snapshot_character_id,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.name') END AS snapshot_name,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.iconFilePath') END AS snapshot_icon_file_path,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.theme.main') END AS snapshot_theme_main,
  CASE WHEN json_valid(character_snapshot_json) THEN json_extract(character_snapshot_json, '$.theme.sub') END AS snapshot_theme_sub,
  CASE WHEN json_valid(character_snapshot_json) THEN json_type(character_snapshot_json, '$.definitionMarkdown') END AS snapshot_definition_markdown_type,
  (SELECT session_role FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_session_role,
  (SELECT role_contract_revision FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_contract_revision,
  (SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_root_session_id,
  (SELECT parent_session_id FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_parent_session_id,
  (SELECT delegation_depth FROM session_role_bindings_v6 WHERE session_id = sessions_v6.id) AS role_delegation_depth
`;

function v6RuntimeJsonValue(path: string): string {
  return `CASE WHEN json_valid(s.runtime_policy_json) THEN json_extract(s.runtime_policy_json, '${path}') ELSE NULL END`;
}

function v6SnapshotJsonValue(path: string): string {
  return `CASE WHEN json_valid(s.character_snapshot_json) THEN json_extract(s.character_snapshot_json, '${path}') ELSE NULL END`;
}

const V6_HOME_RUNTIME_CHARACTER_ID_EXPRESSION = v6RuntimeJsonValue("$.characterId");
const V6_HOME_CHARACTER_ID_EXPRESSION = `COALESCE(
  NULLIF(TRIM(s.character_id), ''),
  NULLIF(TRIM(CAST(${V6_HOME_RUNTIME_CHARACTER_ID_EXPRESSION} AS TEXT)), ''),
  '${UNKNOWN_CHARACTER_OWNER_ID}'
)`;
const V6_HOME_SNAPSHOT_STRUCTURE_EXPRESSION = `CASE WHEN json_valid(s.character_snapshot_json) THEN
  CASE WHEN json_type(s.character_snapshot_json, '$.characterId') = 'text'
    AND json_type(s.character_snapshot_json, '$.name') = 'text'
    AND json_type(s.character_snapshot_json, '$.definitionMarkdown') = 'text'
    THEN 1 ELSE 0 END
  ELSE 0 END`;
const V6_HOME_SNAPSHOT_MATCH_EXPRESSION = `CASE WHEN ${V6_HOME_SNAPSHOT_STRUCTURE_EXPRESSION} = 1 THEN
  CASE WHEN TRIM(COALESCE(json_extract(s.character_snapshot_json, '$.characterId'), '')) = TRIM(${V6_HOME_CHARACTER_ID_EXPRESSION})
    AND TRIM(${V6_HOME_CHARACTER_ID_EXPRESSION}) <> '${UNKNOWN_CHARACTER_OWNER_ID}'
    THEN 1 ELSE 0 END
  ELSE 0 END`;
const HOME_SESSION_SUMMARY_SELECT_COLUMNS = `
  s.id,
  s.title AS task_title,
  CASE
    WHEN ${v6RuntimeJsonValue("$.appStatus")} IN ('running', 'idle', 'saved') THEN ${v6RuntimeJsonValue("$.appStatus")}
    WHEN s.state = 'active' THEN 'running'
    ELSE 'idle'
  END AS status,
  COALESCE(NULLIF(s.updated_at, ''), s.last_active_at) AS updated_at,
  COALESCE(${v6RuntimeJsonValue("$.workspaceLabel")}, '') AS workspace_label,
  s.workspace_path,
  s.session_kind,
  COALESCE(${v6RuntimeJsonValue("$.accessMode")}, 'active') AS access_mode,
  COALESCE(${v6RuntimeJsonValue("$.sourceSchemaVersion")}, ${CURRENT_SESSION_SCHEMA_VERSION}) AS source_schema_version,
  ${V6_HOME_CHARACTER_ID_EXPRESSION} AS character_id,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.name")}
    ELSE ${v6RuntimeJsonValue("$.characterName")}
  END AS character_name,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.iconFilePath")}
    ELSE ${v6RuntimeJsonValue("$.characterIconPath")}
  END AS character_icon_path,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.theme.main")}
    ELSE ${v6RuntimeJsonValue("$.characterThemeColors.main")}
  END AS character_theme_main,
  CASE WHEN ${V6_HOME_SNAPSHOT_MATCH_EXPRESSION} = 1
    THEN ${v6SnapshotJsonValue("$.theme.sub")}
    ELSE ${v6RuntimeJsonValue("$.characterThemeColors.sub")}
  END AS character_theme_sub,
  COALESCE(${v6RuntimeJsonValue("$.runState")}, 'idle') AS run_state,
  s.is_pinned,
  s.last_active_at
`;

type SessionCrudIdempotencyRow = {
  request_fingerprint: string;
  session_id: string;
  result_json: string;
};

type SessionRoleBindingRow = {
  session_role: string;
  role_contract_revision: number;
  root_session_id: string;
  parent_session_id: string | null;
  delegation_depth: number;
};

type SessionFileWriteIdempotencyRow = {
  operation_id: string;
  request_fingerprint: string;
  session_id: string;
  relative_path: string;
  temp_name: string;
  state: "pending" | "applied" | "rejected";
  output_sha256: string | null;
  byte_length: number | null;
  file_device: string | null;
  file_inode: string | null;
  target_precondition_json: string | null;
  result_json: string | null;
  authority_proof_json: string | null;
};

export type SessionFileWritePreparedProof = {
  sha256: string;
  byteLength: number;
  device: string;
  inode: string;
  targetPrecondition: SessionFileTargetPrecondition;
};

export type SessionFileTargetPrecondition =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; byteLength: number; device: string; inode: string };

export type SessionCrudOperation = "session.create" | "session.rename";
export type SessionCrudReplayResult =
  | { kind: "absent" }
  | { kind: "replay"; sessionId: string; result: unknown };
export type SessionSummaryPagePosition = { lastActiveAt: string; sessionId: string };
export type SessionSummaryPageEntry = { summary: SessionSummary; lastActiveAt: string };

export class SessionCrudIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different input.");
    this.name = "SessionCrudIdempotencyConflictError";
  }
}

export class SessionCrudIdempotencyResponseUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_RESPONSE_UNAVAILABLE";
  readonly effect = "applied" as const;

  constructor(readonly operation: SessionCrudOperation, readonly idempotencyKey: string) {
    super(`The original Session mutation response is unavailable after migration: ${operation}`);
    this.name = "SessionCrudIdempotencyResponseUnavailableError";
  }
}

export type SessionFileWriteReplayResult =
  | {
    kind: "pending";
    operationId: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    resumed: boolean;
  }
  | {
    kind: "replay";
    operationId: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    result: unknown;
  }
  | {
    kind: "rejected";
    operationId: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    prepared: SessionFileWritePreparedProof | null;
    error: unknown;
  };

export class SessionFileWriteIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used with different input.");
    this.name = "SessionFileWriteIdempotencyConflictError";
  }
}

export class SessionFileWriteIdempotencyResponseUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_RESPONSE_UNAVAILABLE";
  readonly effect: "applied" | "indeterminate";

  constructor(readonly idempotencyKey: string, readonly state: "pending" | "applied" | "rejected") {
    super("The original Session file write response is unavailable after migration.");
    this.name = "SessionFileWriteIdempotencyResponseUnavailableError";
    this.effect = state === "applied" ? "applied" : "indeterminate";
  }
}
type DecodedSessionV6RuntimeState = {
  runtimePolicy: Record<string, unknown>;
  characterId: string;
  snapshot: ReturnType<typeof parseCharacterRuntimeSnapshotJson>;
  threadId: string;
};


const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

function toV6State(session: Session): string {
  if (session.status === "running") {
    return "active";
  }
  return "completed";
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireStoredRoleField<T>(value: T | null, sessionId: string): T {
  if (value === null) {
    throw new Error(`Stored normal Session Role binding is incomplete: ${sessionId}`);
  }
  return value;
}

function decodeSessionRoleBinding(sessionId: string, row: SessionRoleBindingRow): SessionRoleBinding {
  return requireSessionRoleBinding(sessionId, {
    sessionRole: row.session_role,
    roleContractRevision: row.role_contract_revision,
    rootSessionId: row.root_session_id,
    parentSessionId: row.parent_session_id,
    delegationDepth: row.delegation_depth,
  });
}

function decodeSessionV6RuntimeState(row: SessionV6Row): DecodedSessionV6RuntimeState {
  const runtimePolicy = parseJsonObject(row.runtime_policy_json);
  const runtimeCharacterId = normalizeCharacterOwnerId(runtimePolicy.characterId);
  const storedCharacterId = normalizeCharacterOwnerId(row.character_id) ?? runtimeCharacterId;
  const characterId = recoverStoredCharacterOwnerId(storedCharacterId);
  const unresolvedOwner = isUnknownCharacterOwnerId(characterId);
  const parsedSnapshot = row.character_snapshot_json
    ? parseCharacterRuntimeSnapshotJson(row.character_snapshot_json)
    : null;
  const snapshot = !unresolvedOwner && parsedSnapshot
    && parsedSnapshot.characterId === characterId
    ? parsedSnapshot
    : null;
  const rejectedStoredSnapshot = row.character_snapshot_json !== null && snapshot === null;

  return {
    runtimePolicy,
    characterId,
    snapshot,
    threadId: unresolvedOwner || rejectedStoredSnapshot ? "" : row.thread_id,
  };
}

function normalizeSessionForStorage(session: Session): Session {
  const ownerId = normalizeCharacterOwnerId(session.characterId);
  const snapshotOwnerId = normalizeCharacterOwnerId(session.characterRuntimeSnapshot?.characterId);
  if (session.characterRuntimeSnapshot && (!ownerId || snapshotOwnerId !== ownerId)) {
    throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
  }

  const normalized = normalizeSession(session);
  if (!normalized) {
    throw new Error("SessionStorageV6 に保存できない session 形式だよ。");
  }
  return normalized;
}

function sessionLifecyclePatch(session: Session): import("./session-lifecycle-storage.js").SessionLifecycleSessionPatch {
  return {
    title: session.taskTitle,
    state: toV6State(session) as "active" | "completed" | "failed" | "archived",
    providerId: session.provider,
    catalogRevision: session.catalogRevision,
    modelId: session.model,
    reasoningEffort: session.reasoningEffort,
    customAgentName: session.customAgentName,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    allowedAdditionalDirectories: session.allowedAdditionalDirectories,
    runtimePolicyJson: JSON.stringify({
      appStatus: session.status,
      runState: session.runState,
      workspaceLabel: session.workspaceLabel,
      branch: session.branch,
      accessMode: session.accessMode,
      sourceSchemaVersion: session.sourceSchemaVersion,
      characterId: session.characterId,
      characterName: session.character,
      characterIconPath: session.characterIconPath,
      characterThemeColors: session.characterThemeColors,
      codexSpeed: session.codexSpeed,
      codexReviewer: session.codexReviewer,
    }),
    threadId: session.threadId,
    characterId: session.characterRuntimeSnapshot ? session.characterId : null,
    characterSnapshotJson: session.characterRuntimeSnapshot ? stringifyCharacterRuntimeSnapshot(session.characterRuntimeSnapshot) : null,
    workspacePath: session.workspacePath,
    isPinned: session.isPinned,
    binding: session.roleBinding ? {
      sessionRole: session.roleBinding.sessionRole,
      roleContractRevision: session.roleBinding.roleContractRevision,
      rootSessionId: session.roleBinding.rootSessionId,
      parentSessionId: session.roleBinding.parentSessionId,
      delegationDepth: session.roleBinding.delegationDepth,
    } : undefined,
  };
}

function encodeMessage(message: Message): string {
  return JSON.stringify(message.artifact
    ? { ...message, artifact: summarizeMessageArtifact(message.artifact) }
    : message);
}

function encodeMessageArtifact(message: Message): string | null {
  return message.artifact ? JSON.stringify(message.artifact) : null;
}

function isSameArtifactSummary(source: MessageArtifact, summary: MessageArtifact): boolean {
  return JSON.stringify(summarizeMessageArtifact(source)) === JSON.stringify(summary);
}

function isArtifactSummaryProjection(artifact: MessageArtifact): boolean {
  return artifact.detailAvailable === true &&
    (artifact.operationTimeline ?? []).every((operation) => operation.details === undefined) &&
    artifact.changedFiles.every((file) => file.diffRows.length === 0);
}

function encodeMessageArtifactForWrite(message: Message, existingArtifactBody: string | null | undefined): string | null {
  if (!message.artifact) {
    return null;
  }

  if (isArtifactSummaryProjection(message.artifact) && existingArtifactBody) {
    const existingArtifact = decodeMessageArtifact(existingArtifactBody);
    if (existingArtifact && isSameArtifactSummary(existingArtifact, message.artifact)) {
      return existingArtifactBody;
    }
  }

  return encodeMessageArtifact(message);
}

function decodeMessageArtifact(value: string | null | undefined): MessageArtifact | null {
  if (!value) {
    return null;
  }

  return normalizeMessage({
    role: "assistant",
    text: "",
    artifact: parseJsonObject(value),
  })?.artifact ?? null;
}

function decodeMessage(row: MessageV6Row): Message | null {
  const parsed = normalizeMessage(parseJsonObject(row.body));
  if (parsed) {
    return parsed;
  }
  if (row.role === "user" || row.role === "assistant") {
    return { role: row.role, text: row.body };
  }
  return null;
}

export class SessionStorageV6 {
  private readonly db: DatabaseSync;
  private readonly resourceBudgetStorage: ResourceBudgetStorage;
  private readonly lifecycleStorage: SessionLifecycleStorage;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    registerSessionProviderIdNormalizer(this.db);
    ensureV6Schema(this.db);
    this.ensureSchema();
    this.resourceBudgetStorage = new ResourceBudgetStorage(this.db);
    this.lifecycleStorage = new SessionLifecycleStorage(this.db);
  }

  listRootMemberSessionIds(sessionId: string): string[] {
    return (this.db.prepare(`
      SELECT member.session_id FROM session_role_bindings_v6 AS member
      INNER JOIN session_role_bindings_v6 AS target ON target.root_session_id = member.root_session_id
      WHERE target.session_id = ? ORDER BY member.session_id
    `).all(sessionId) as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  listRootSessionIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT root_session_id FROM session_role_bindings_v6 ORDER BY root_session_id")
      .all() as Array<{ root_session_id: string }>).map((row) => row.root_session_id);
  }

  listSessions(): Session[] {
    const rows = this.db.prepare(`
      SELECT sessions_v6.*,
        b.session_role AS role_session_role,
        b.role_contract_revision,
        b.root_session_id AS role_root_session_id,
        b.parent_session_id AS role_parent_session_id,
        b.delegation_depth AS role_delegation_depth
      FROM sessions_v6
      LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
      WHERE sessions_v6.deleted_at IS NULL AND sessions_v6.state <> 'archived'
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6Row[];
    return cloneSessions(rows.map((row) => this.rowToSession(row)));
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      WHERE deleted_at IS NULL AND state <> 'archived'
      ORDER BY last_active_at DESC, id DESC
    `).all() as SessionV6SummaryRow[];
    return cloneSessionSummaries(rows.map((row) => this.rowToSessionSummaryProjection(row)));
  }

  listRelatedSessionSummaries(sessionIds: readonly string[]): RelatedSessionSummary[] {
    const normalizedIds = [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
    if (normalizedIds.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT s.id AS session_id, s.title AS task_title
      FROM json_each(?) AS requested
      INNER JOIN sessions_v6 AS s ON s.id = requested.value AND s.deleted_at IS NULL AND s.state <> 'archived'
      ORDER BY requested.key ASC
    `).all(JSON.stringify(normalizedIds)) as RelatedSessionSummaryRow[];
    return rows.map((row) => ({ sessionId: row.session_id, taskTitle: row.task_title }));
  }

  getSessionTurnAuthority(sessionId: string): SessionTurnAuthoritySession | null {
    const row = this.db.prepare(`
      SELECT s.id AS session_id, s.title,
             b.session_role, b.role_contract_revision, b.root_session_id,
             b.parent_session_id, b.delegation_depth
      FROM sessions_v6 AS s
      INNER JOIN session_role_bindings_v6 AS b ON b.session_id = s.id
      WHERE s.id = ? AND s.deleted_at IS NULL AND s.state <> 'archived'
    `).get(sessionId.trim()) as SessionTurnAuthorityRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      title: row.title,
      ...requireSessionRoleBinding(row.session_id, {
        sessionRole: row.session_role,
        roleContractRevision: row.role_contract_revision,
        rootSessionId: row.root_session_id,
        parentSessionId: row.parent_session_id,
        delegationDepth: row.delegation_depth,
      }),
    };
  }

  listHomeSessionSummaryPage(request?: SessionSummaryPageRequest | null): HomeSessionSummaryPageResult {
    return this.queryHomeSessionSummaryPage(request);
  }

  private queryHomeSessionSummaryPage(request?: SessionSummaryPageRequest | null): HomeSessionSummaryPageResult {
    const parsed = parseSessionSummaryPageRequest(request);
    const isOpenScope = parsed.scope === "open";
    const cursor = parsed.scope === "open"
      ? null
      : decodeSessionSummaryCursor(parsed.cursor, parsed.scope, parsed.searchText);
    const search = buildSessionSummarySearchClause("s", parsed.searchText);
    const keyset = buildSessionSummaryKeysetClause("s", cursor);
    const where: string[] = ["s.deleted_at IS NULL", "s.state <> 'archived'"];
    const params: string[] = [];

    if (parsed.scope === "pinned") {
      where.push("s.is_pinned = 1");
    }
    if (isOpenScope) {
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
    if (!isOpenScope && search.sql) {
      where.push(search.sql);
      params.push(...search.params);
    }

    const rows = this.db.prepare(`
      SELECT ${HOME_SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6 AS s
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.last_active_at DESC, s.id DESC
      LIMIT ?
    `).all(...params, parsed.limit + 1) as HomeSessionSummaryV6Row[];
    const visibleRows = rows.slice(0, parsed.limit);
    const entries = cloneHomeSessionSummaries(
      visibleRows
        .map((row) => this.rowToHomeSessionSummary(row))
        .filter((summary): summary is HomeSessionSummary => summary !== null),
    );
    const hasMore = parsed.scope !== "open" && rows.length > parsed.limit;
    const lastRow = visibleRows.at(-1);

    return {
      entries,
      hasMore,
      nextCursor: hasMore && lastRow && parsed.scope !== "open"
        ? encodeSessionSummaryCursor(parsed.scope, lastRow.last_active_at, lastRow.id, parsed.searchText)
        : null,
    };
  }

  listSessionCharacterUsage(): SessionCharacterUsage[] {
    const characterIdExpression = `COALESCE(
      NULLIF(TRIM(s.character_id), ''),
      NULLIF(TRIM(CASE WHEN json_valid(s.runtime_policy_json) THEN json_extract(s.runtime_policy_json, '$.characterId') ELSE '' END), '')
    )`;
    const newerCharacterIdExpression = `COALESCE(
      NULLIF(TRIM(newer.character_id), ''),
      NULLIF(TRIM(CASE WHEN json_valid(newer.runtime_policy_json) THEN json_extract(newer.runtime_policy_json, '$.characterId') ELSE '' END), '')
    )`;
    const rows = this.db.prepare(`
      SELECT ${characterIdExpression} AS character_id
      FROM sessions_v6 AS s
      WHERE s.session_kind = 'default'
        AND s.deleted_at IS NULL
        AND s.state <> 'archived'
        AND ${characterIdExpression} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM sessions_v6 AS newer
          WHERE newer.session_kind = 'default'
            AND newer.deleted_at IS NULL
            AND newer.state <> 'archived'
            AND ${newerCharacterIdExpression} = ${characterIdExpression}
            AND (
              newer.last_active_at > s.last_active_at
              OR (newer.last_active_at = s.last_active_at AND newer.id > s.id)
            )
        )
      ORDER BY s.last_active_at DESC, s.id DESC
    `).all() as SessionCharacterUsageRow[];

    return rows
      .map((row) => recoverStoredCharacterOwnerId(normalizeCharacterOwnerId(row.character_id)))
      .filter((characterId): characterId is string => Boolean(characterId))
      .map((characterId) => ({ characterId, sessionKind: "default" as const }));
  }

  getLatestSessionSummaryForProvider(providerId: string): SessionSummary | null {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      WHERE deleted_at IS NULL AND state <> 'archived'
        AND ${SESSION_PROVIDER_ID_NORMALIZER_SQL_FUNCTION}(provider_id) = ?
      ORDER BY last_active_at DESC, id DESC
      LIMIT 1
    `).get(normalizeProviderId(normalizedProviderId)) as SessionV6SummaryRow | undefined;
    return row ? this.rowToSessionSummaryProjection(row) : null;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare(`
      SELECT sessions_v6.*,
        b.session_role AS role_session_role,
        b.role_contract_revision,
        b.root_session_id AS role_root_session_id,
        b.parent_session_id AS role_parent_session_id,
        b.delegation_depth AS role_delegation_depth
      FROM sessions_v6
      LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
      WHERE sessions_v6.id = ? AND sessions_v6.deleted_at IS NULL AND sessions_v6.state <> 'archived'
    `).get(sessionId) as SessionV6Row | undefined;
    return row ? this.rowToSession(row) : null;
  }

  getLifecycleSession(sessionId: string, includeArchived = false): Session | null {
    const row = this.db.prepare(`
      SELECT sessions_v6.*,
        b.session_role AS role_session_role,
        b.role_contract_revision,
        b.root_session_id AS role_root_session_id,
        b.parent_session_id AS role_parent_session_id,
        b.delegation_depth AS role_delegation_depth
      FROM sessions_v6
      LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
      WHERE sessions_v6.id = ? AND sessions_v6.deleted_at IS NULL
        AND (? = 1 OR sessions_v6.state <> 'archived')
    `).get(sessionId.trim(), includeArchived ? 1 : 0) as SessionV6Row | undefined;
    return row ? this.rowToSession(row) : null;
  }

  getLifecycleOperationByKey(operation: SessionLifecycleOperation, proof: MutationAuthorityProof, key: string, fingerprint: string): SessionLifecycleOperationRecord | null {
    return this.lifecycleStorage.getLifecycleOperationByKey(operation, proof, key, fingerprint);
  }

  prepareLifecycleMutation(input: PrepareLifecycleMutationInput & { requestFingerprint: string }): SessionLifecycleOperationRecord {
    this.assertLifecyclePreconditions(input.operation, input.input, input.proof, input.now);
    if ((input.operation === "session.create" || input.operation === "session.clone") && input.nextSession) {
      const constructionProof = input.operation === "session.clone" ? input.destinationProof : input.proof;
      if (!constructionProof) throw new SessionCrudError("SESSION_STATE_CONFLICT", "Clone construction authority is required.");
      validateSessionConstruction(this.db, this.lifecycleConstructionInput(input.input, input.nextSession), constructionProof, input.nextSession, input.now);
    }
    if (input.operation === "session.move" && input.input.kind === "cross_root") {
      if (!input.destinationProof) throw new SessionCrudError("SESSION_STATE_CONFLICT", "Destination authority is required.");
      assertGrantProofCurrent(this.db, input.destinationProof, new Date(input.now));
    }
    return this.lifecycleStorage.prepareLifecycleMutation(input);
  }

  private lifecycleConstructionInput(input: Record<string, unknown>, session: Session): SessionRuntimeCreateInput {
    return { ...input, workspace: input.workspace ?? { kind: "directory", path: session.workspacePath } } as unknown as SessionRuntimeCreateInput;
  }

  private assertLifecyclePreconditions(operation: SessionLifecycleOperation, request: Record<string, unknown>, proof: MutationAuthorityProof, now: string): void {
    assertGrantProofCurrent(this.db, proof, new Date(now));
    const creating = operation === "session.create" || operation === "session.clone";
    const sessionId = operation === "session.clone" ? request.sourceSessionId : request.sessionId;
    if (typeof sessionId === "string") {
      const current = this.db.prepare("SELECT resource_revision, state, deleted_at FROM sessions_v6 WHERE id = ?")
        .get(sessionId) as { resource_revision: number; state: string; deleted_at: string | null } | undefined;
      if (!current || current.deleted_at) throw new SessionCrudError("SESSION_NOT_FOUND", "The Session was not found.");
      const expected = operation === "session.clone" ? request.expectedSourceRevision : request.expectedRevision;
      if (current.resource_revision !== expected) throw new SessionResourceRevisionConflictError(sessionId, Number(expected), current.resource_revision);
      if (operation === "session.restore" ? current.state !== "archived" : current.state === "archived" && operation !== "session.delete") {
        throw new SessionCrudError("SESSION_STATE_CONFLICT", "The Session lifecycle state does not allow this operation.");
      }
      if (operation === "session.configure" && request.kind === "role") {
        const role = request.sessionRole as SessionRole;
        const children = this.db.prepare("SELECT session_role FROM session_role_bindings_v6 WHERE parent_session_id = ?").all(sessionId) as Array<{ session_role: SessionRole }>;
        if (children.some((child) => !(SESSION_ROLE_CHILDREN[role] as readonly string[]).includes(child.session_role))) {
          throw new SessionCrudError("INVALID_INPUT", "The requested role cannot own the existing children.");
        }
        const parent = this.db.prepare("SELECT parent.session_role FROM session_role_bindings_v6 child JOIN session_role_bindings_v6 parent ON parent.session_id = child.parent_session_id WHERE child.session_id = ?").get(sessionId) as { session_role: SessionRole } | undefined;
        if (parent && !(SESSION_ROLE_CHILDREN[parent.session_role] as readonly string[]).includes(role)) {
          throw new SessionCrudError("INVALID_INPUT", "The requested role is not allowed by its parent role.");
        }
      }
      if (operation === "session.restore" && request.kind === "root") {
        const predecessor = this.db.prepare("SELECT state FROM work_items_v6 WHERE root_session_id = ? AND kind = 'root' ORDER BY sequence DESC LIMIT 1").get(sessionId) as { state: string } | undefined;
        if (!predecessor || !["completed", "partially_completed", "failed", "canceled"].includes(predecessor.state)) {
          throw new SessionCrudError("SESSION_STATE_CONFLICT", "Root restore requires a terminal predecessor Work Item.");
        }
      }
      if (operation === "session.move" || operation === "session.delete") {
        const manifest = this.getLifecycleManifest(sessionId, typeof request.destinationRootSessionId === "string" ? request.destinationRootSessionId : undefined);
        const expectedManifest = operation === "session.delete" ? request.manifestRevision : request.transferManifestRevision;
        if ((operation === "session.delete" || request.kind === "cross_root") && manifest.manifestRevision !== expectedManifest) {
          throw new SessionCrudError("SESSION_REVISION_CONFLICT", "The lifecycle manifest has changed.", true);
        }
        if (operation === "session.delete" && !(manifest as SessionRuntimeDeleteManifestResult).deletable) {
          throw new SessionCrudError("SESSION_STATE_CONFLICT", "Referenced resources prevent deletion.");
        }
      }
      if (operation === "session.archive" || operation === "session.delete" || operation === "session.restore") {
        const active = this.db.prepare("SELECT 1 FROM session_executions_v6 WHERE session_id = ? AND state IN ('queued','running','cancel_requested') LIMIT 1").get(sessionId);
        if (active) throw new SessionCrudError("SESSION_STATE_CONFLICT", "Active executions prevent this lifecycle operation.");
      }
    }
    if (creating) {
      const placement = request.placement as { kind: string; parentSessionId?: string };
      const container = placement.kind === "child" ? placement.parentSessionId : proof.principal.kind === "agent" ? proof.principal.actorSessionId : null;
      if (container) {
        const actual = this.getSessionResourceRevision(container);
        if (actual !== request.expectedContainerRevision) throw new SessionResourceRevisionConflictError(container, Number(request.expectedContainerRevision), actual ?? 0);
      }
    }
  }

  commitLifecycleMutation(input: {
    operationId: string;
    expectedOperationRevision: number;
    proof: MutationAuthorityProof;
    now: string;
    projectResult(session: Session): unknown;
  }): SessionLifecycleOperationRecord {
    const record = this.lifecycleStorage.get(input.operationId);
    if (!record) throw new Error(`Session lifecycle operation was not found: ${input.operationId}`);
    const next = record.manifest.nextSession as Session | null | undefined;
    const operation = record.operation;
    return this.lifecycleStorage.commitLifecycleMutationAtomic(input, () => {
      const request = record.manifest.input as Record<string, unknown>;
      this.assertLifecyclePreconditions(operation, request, input.proof, input.now);
      if (next) {
        const current = this.getLifecycleSession(next.id, true);
        if (!current) {
          const construction = this.lifecycleConstructionInput(request, next);
          const constructionProof = operation === "session.clone" ? record.manifest.destinationProof as MutationAuthorityProof | null : input.proof;
          if (!constructionProof) throw new SessionCrudError("SESSION_STATE_CONFLICT", "Clone construction authority is required.");
          validateSessionConstruction(this.db, construction, constructionProof, next, input.now);
          this.writeSession(normalizeSessionForStorage(next), "create");
          initializeSessionConstruction(this.db, construction, constructionProof, next, record.operationId, input.now);
          appendSessionResourceEvent(this.db, { sessionId: next.id, revision: this.getSessionResourceRevision(next.id)!,
            eventKind: "created", proof: input.proof, operationId: record.operationId, idempotencyKey: record.idempotencyKey,
            occurredAt: input.now, payload: { operation } });
          const placement = construction.placement;
          const container = placement.kind === "child" ? placement.parentSessionId : input.proof.principal.kind === "agent" ? input.proof.principal.actorSessionId : null;
          if (container) claimSessionContainerRevision(this.db, {
            sessionId: container, expectedRevision: construction.expectedContainerRevision, eventKind: "child_created", proof: input.proof,
            operationId: record.operationId, idempotencyKey: record.idempotencyKey, occurredAt: input.now, payload: { childSessionId: next.id },
          });
        } else {
          if (operation === "session.restore") {
            const isRoot = current.roleBinding?.rootSessionId === current.id && current.roleBinding.parentSessionId === null;
            if ((request.kind === "root") !== isRoot) throw new SessionCrudError("SESSION_STATE_CONFLICT", "The restore placement does not match the archived Session.");
            if (isRoot) {
              const predecessor = this.db.prepare("SELECT id, scope, completion_criteria, authority, source_identity_json FROM work_items_v6 WHERE kind = 'root' AND root_session_id = ? ORDER BY sequence DESC LIMIT 1")
                .get(current.id) as { id: string; scope: string; completion_criteria: string; authority: string; source_identity_json: string } | undefined;
              if (!predecessor) throw new SessionCrudError("SESSION_STATE_CONFLICT", "The predecessor Root Work Item is missing.");
              restoreRootWorkItemWithinTransaction(this.db, next, {
                predecessorWorkItemId: predecessor.id, goal: String(request.purpose), scope: predecessor.scope,
                completionCriteria: predecessor.completion_criteria, authority: predecessor.authority,
                sourceIdentity: JSON.parse(predecessor.source_identity_json), idempotencyKey: record.idempotencyKey,
                requestFingerprint: record.requestFingerprint,
              }, input.proof, record.operationId, input.now);
              restoreRootBudgetWithinTransaction(this.db, current.id, request.budget as import("../src/session-external-runtime-contract.js").SessionRuntimeInitialBudget,
                input.proof, record.operationId, input.now);
              this.resourceBudgetStorage.consumeCount({ sessionId: current.id, dimension: "workItems", idempotencyKey: record.operationId, consumedAt: input.now });
            }
          }
          this.lifecycleStorage.applySessionMutation({
            sessionId: next.id,
            expectedRevision: Number(request.expectedRevision),
            patch: sessionLifecyclePatch(next),
            eventKind: `lifecycle.${operation}`,
            proof: input.proof,
            operationId: record.operationId,
            idempotencyKey: record.idempotencyKey,
            occurredAt: input.now,
            payload: { operation, lifecycleOperationId: record.operationId },
          });
        }
        const stored = this.getLifecycleSession(next.id, true);
        if (!stored) throw new Error("The lifecycle Session is missing after mutation.");
        return input.projectResult(stored);
      }
      if (record.targetSessionId && operation === "session.move") {
        const manifest = this.getLifecycleManifest(record.targetSessionId, typeof request.destinationRootSessionId === "string" ? request.destinationRootSessionId : undefined);
        applySessionMove(this.db, { ...(request as unknown as import("./session-lifecycle-move.js").SessionMoveInput), descendants: manifest.descendants,
          destinationProof: record.manifest.destinationProof as MutationAuthorityProof | undefined }, input.proof, input.now, record.operationId);
        const moved = this.getLifecycleSession(record.targetSessionId);
        if (!moved) throw new Error("The moved Session is missing.");
        return input.projectResult(moved);
      }
      if (record.targetSessionId && operation === "session.archive") {
        const ids = [record.targetSessionId, ...(request.descendantPolicy === "archive_descendants"
          ? this.getLifecycleManifest(record.targetSessionId).descendants.map((entry) => entry.sessionId) : [])];
        for (const id of ids) {
          if (this.db.prepare("SELECT 1 FROM session_executions_v6 WHERE session_id = ? AND state IN ('queued','running','cancel_requested') LIMIT 1").get(id)) {
            throw new SessionCrudError("SESSION_STATE_CONFLICT", "An active descendant execution prevents archive.");
          }
          this.lifecycleStorage.applySessionMutation({
            sessionId: id, expectedRevision: this.getSessionResourceRevision(id) ?? 0,
            patch: { state: "archived" }, eventKind: "lifecycle.archive", proof: input.proof,
            operationId: record.operationId, idempotencyKey: record.idempotencyKey, occurredAt: input.now,
            payload: { reason: request.reason },
          });
        }
        const archived = this.getLifecycleSession(record.targetSessionId, true);
        if (!archived) throw new Error("The archived Session is missing.");
        return input.projectResult(archived);
      }
      if (record.targetSessionId && operation === "session.delete") {
        const current = this.getLifecycleSession(record.targetSessionId, true);
        if (!current) throw new SessionCrudError("SESSION_NOT_FOUND", "The Session was not found.");
        const manifest = this.getLifecycleManifest(record.targetSessionId) as SessionRuntimeDeleteManifestResult;
        if (!manifest.deletable) throw new SessionCrudError("SESSION_STATE_CONFLICT", "Referenced resources prevent deletion.");
        this.tombstoneStoredSessionsByIds([record.targetSessionId], {
          proof: input.proof,
          operationId: record.operationId,
          idempotencyKey: record.idempotencyKey,
          occurredAt: input.now,
        });
        return input.projectResult(current);
      }
      throw new SessionCrudError("SESSION_STATE_CONFLICT", "The lifecycle operation has no applicable mutation.");
    });
  }

  completeLifecycleMutation(operationId: string, expectedRevision: number, now: string): SessionLifecycleOperationRecord {
    return this.lifecycleStorage.completeLifecycleMutation(operationId, expectedRevision, now);
  }

  rejectLifecycleMutation(operationId: string, expectedRevision: number, error: unknown, now: string): void {
    this.lifecycleStorage.reject(operationId, expectedRevision, error, now);
  }

  recordLifecycleStep(input: {
    operationId: string;
    expectedRevision: number;
    step: string;
    effect: "none" | "committed" | "unknown";
    payload?: Record<string, unknown>;
    occurredAt: string;
  }): SessionLifecycleOperationRecord {
    return this.lifecycleStorage.recordStep(input);
  }

  markRecoveryRequiredLifecycleMutation(operationId: string, expectedRevision: number, error: unknown, now: string): void {
    this.lifecycleStorage.markRecoveryRequired(operationId, expectedRevision, error, now);
  }

  listPendingLifecycleOperations(): SessionLifecycleOperationRecord[] {
    return this.lifecycleStorage.listPending();
  }

  getLifecycleManifest(sessionId: string, destinationRootSessionId?: string): SessionRuntimeDeleteManifestResult | SessionRuntimeSessionMoveManifestResult {
    return buildSessionLifecycleManifest(this.db, sessionId, destinationRootSessionId);
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db.prepare(`
      SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
      FROM sessions_v6
      WHERE id = ? AND deleted_at IS NULL AND state <> 'archived'
    `).get(sessionId) as SessionV6SummaryRow | undefined;
    return row ? this.rowToSessionSummaryProjection(row) : null;
  }

  getSessionResourceRevision(sessionId: string, includeDeleted = false): number | null {
    return readSessionResourceRevision(this.db, sessionId, includeDeleted);
  }

  listSessionSummaryPage(request?: SessionSummaryPageRequest | null): HomeSessionSummaryPageResult;
  listSessionSummaryPage(
    limit: number,
    position?: SessionSummaryPagePosition,
    rootSessionId?: string,
    sessionId?: string,
  ): SessionSummaryPageEntry[];
  listSessionSummaryPage(
    requestOrLimit?: SessionSummaryPageRequest | null | number,
    position?: SessionSummaryPagePosition,
    rootSessionId?: string,
    sessionId?: string,
  ): HomeSessionSummaryPageResult | SessionSummaryPageEntry[] {
    if (typeof requestOrLimit !== "number") {
      return this.queryHomeSessionSummaryPage(requestOrLimit);
    }
    const limit = requestOrLimit;
    const rows = (position
      ? this.db.prepare(`
          SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
          FROM sessions_v6
          WHERE session_kind = 'default'
            AND deleted_at IS NULL
            AND state <> 'archived'
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM session_role_bindings_v6 AS root_scope
              WHERE root_scope.session_id = sessions_v6.id AND root_scope.root_session_id = ?
            ))
            AND (? IS NULL OR sessions_v6.id = ?)
            AND (last_active_at < ? OR (last_active_at = ? AND id < ?))
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(
          rootSessionId ?? null,
          rootSessionId ?? null,
          sessionId ?? null,
          sessionId ?? null,
          position.lastActiveAt,
          position.lastActiveAt,
          position.sessionId,
          limit,
        )
      : this.db.prepare(`
          SELECT ${SESSION_SUMMARY_SELECT_COLUMNS}
          FROM sessions_v6
          WHERE session_kind = 'default'
            AND deleted_at IS NULL
            AND state <> 'archived'
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM session_role_bindings_v6 AS root_scope
              WHERE root_scope.session_id = sessions_v6.id AND root_scope.root_session_id = ?
            ))
            AND (? IS NULL OR sessions_v6.id = ?)
          ORDER BY last_active_at DESC, id DESC
          LIMIT ?
        `).all(rootSessionId ?? null, rootSessionId ?? null, sessionId ?? null, sessionId ?? null, limit)) as SessionV6SummaryRow[];
    return rows.map((row) => ({
      summary: this.rowToSessionSummaryProjection(row),
      lastActiveAt: row.last_active_at,
    }));
  }

  resolveSessionCrudIdempotency(
    operation: SessionCrudOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
    resolveExpectedFingerprint: string | ((result: unknown) => string),
    nowIso: string,
  ): SessionCrudReplayResult {
    this.cleanupSessionCrudIdempotency(nowIso);
    return this.resolveSessionCrudIdempotencyWithoutCleanup(
      operation,
      sessionPrincipalKey(proof),
      idempotencyKey,
      resolveExpectedFingerprint,
    );
  }

  getSessionRoleBinding(sessionId: string): SessionRoleBinding | null {
    const row = this.db.prepare(`
      SELECT binding.session_role, binding.role_contract_revision, binding.root_session_id,
             binding.parent_session_id, binding.delegation_depth
      FROM session_role_bindings_v6 AS binding
      INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
      WHERE binding.session_id = ? AND session.deleted_at IS NULL AND session.state <> 'archived'
    `).get(sessionId) as SessionRoleBindingRow | undefined;
    return row ? decodeSessionRoleBinding(sessionId, row) : null;
  }

  listSessionIdsWithChildren(sessionIds: readonly string[]): Set<string> {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) return new Set();
    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT DISTINCT binding.parent_session_id AS id
      FROM session_role_bindings_v6 AS binding
      INNER JOIN sessions_v6 AS child ON child.id = binding.session_id
      WHERE binding.parent_session_id IN (${placeholders})
        AND child.deleted_at IS NULL AND child.state <> 'archived'
    `).all(...uniqueSessionIds) as Array<SessionIdRow & { resource_revision: number }>;
    return new Set(rows.map((row) => row.id));
  }

  insertSessionIdempotently(
    session: Session,
    input: {
      operation: "session.create";
      principalSessionId: string;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
      expiresAt: string;
      expectedContainerRevision: number;
      proof: MutationAuthorityProof;
      projectResult(session: Session): unknown;
      resolveReplayFingerprint(result: unknown): string;
    },
  ): { session: Session; result: unknown; replayed: boolean } {
    const normalized = normalizeSessionForStorage(session);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const replay = this.resolveSessionCrudIdempotencyWithoutCleanup(
        input.operation,
        sessionPrincipalKey(input.proof),
        input.idempotencyKey,
        input.resolveReplayFingerprint,
      );
      if (replay.kind === "replay") {
        const stored = this.getSession(replay.sessionId);
        if (!stored) {
          throw new Error("Idempotent Session create result is missing its Session.");
        }
        this.db.exec("COMMIT");
        return { session: stored, result: replay.result, replayed: true };
      }

      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      const currentContainerRevision = readSessionResourceRevision(this.db, input.principalSessionId);
      if (currentContainerRevision === null) {
        throw new Error(`Session container was not found: ${input.principalSessionId}`);
      }
      if (currentContainerRevision !== input.expectedContainerRevision) {
        throw new SessionResourceRevisionConflictError(
          input.principalSessionId,
          input.expectedContainerRevision,
          currentContainerRevision,
        );
      }

      this.writeSession(normalized, "create");
      this.consumeCreatedSessionResources(normalized, input.principalSessionId);
      if (input.proof.principal.kind === "agent") {
        createDelegatedChildAuthority(this.db, {
          parentProof: input.proof,
          childSessionId: normalized.id,
          operationId: sessionOperationId(input.operation, input.proof, input.requestFingerprint),
          createdAt: input.createdAt,
        });
      } else {
        ensureBaselineSessionAuthority(this.db, normalized.id, input.createdAt);
      }
      appendSessionResourceEvent(this.db, {
        sessionId: normalized.id,
        revision: 1,
        eventKind: "created",
        proof: input.proof,
        operationId: sessionOperationId(input.operation, input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: {
          title: normalized.taskTitle,
          state: toV6State(normalized),
          sessionKind: normalized.sessionKind,
          providerId: normalized.provider,
          modelId: normalized.model,
          workspacePath: normalized.workspacePath,
          updatedAt: normalized.updatedAt,
        },
      });
      claimSessionContainerRevision(this.db, {
        sessionId: input.principalSessionId,
        expectedRevision: input.expectedContainerRevision,
        eventKind: "child_created",
        proof: input.proof,
        operationId: sessionOperationId(input.operation, input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { childSessionId: normalized.id },
      });
      const stored = this.getSession(normalized.id) ?? normalized;
      const result = input.projectResult(stored);
      this.insertSessionCrudIdempotency(input, stored.id, result);
      this.db.exec("COMMIT");
      return { session: stored, result, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renameSessionIdempotently(input: {
    operation: "session.rename";
    principalSessionId?: string;
    sessionId: string;
    title: string;
    expectedRevision: number;
    proof: MutationAuthorityProof;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: string;
    expiresAt: string;
    projectResult(session: SessionSummary): unknown;
  }): { session: SessionSummary; result: unknown; replayed: boolean } | null {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const replay = this.resolveSessionCrudIdempotencyWithoutCleanup(
        input.operation,
        sessionPrincipalKey(input.proof),
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (replay.kind === "replay") {
        const stored = this.getSessionSummary(replay.sessionId);
        if (!stored) {
          throw new Error("Idempotent Session rename result is missing its Session.");
        }
        this.db.exec("COMMIT");
        return { session: stored, result: replay.result, replayed: true };
      }

      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));

      const current = this.getSessionSummary(input.sessionId);
      if (!current || current.sessionKind !== "default") {
        this.db.exec("COMMIT");
        return null;
      }
      const changed = this.db.prepare(`
        UPDATE sessions_v6
        SET title = ?, updated_at = ?, resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL AND session_kind = 'default' AND resource_revision = ?
      `).run(input.title, input.createdAt, input.sessionId, input.expectedRevision);
      const actualRevision = readSessionResourceRevision(this.db, input.sessionId);
      if (changed.changes !== 1 || actualRevision !== input.expectedRevision + 1) {
        if (actualRevision === null) return null;
        throw new SessionResourceRevisionConflictError(input.sessionId, input.expectedRevision, actualRevision);
      }
      appendSessionResourceEvent(this.db, {
        sessionId: input.sessionId,
        revision: actualRevision,
        eventKind: "renamed",
        proof: input.proof,
        operationId: sessionOperationId(input.operation, input.proof, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { beforeTitle: current.taskTitle, title: input.title, updatedAt: input.createdAt },
      });
      const stored = this.getSessionSummary(input.sessionId);
      if (!stored) {
        throw new Error("Renamed Session could not be read back.");
      }
      const result = input.projectResult(stored);
      this.insertSessionCrudIdempotency(input, stored.id, result);
      this.db.exec("COMMIT");
      return { session: stored, result, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cleanupSessionCrudIdempotency(nowIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_crud_idempotency_v6
      WHERE expires_at <= ?
    `).run(nowIso);
    return Number(result.changes);
  }

  prepareSessionFileWrite(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    sessionId: string;
    relativePath: string;
    tempName: string;
    createdAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): SessionFileWriteReplayResult {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.cleanupAppliedSessionFileWriteIdempotency(input.createdAt);
      const existing = this.findSessionFileWriteIdempotency(input.proof, input.idempotencyKey);
      if (existing) {
        const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
        this.db.exec("COMMIT");
        return resolved;
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      const principal = mutationPrincipalIdentity(input.proof);
      const operationId = createSagaOperationId(
        "session-file-write",
        `${principal.kind}:${principal.id}:${input.idempotencyKey}`,
        input.requestFingerprint,
      ) + `:${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO session_file_write_idempotency_v6 (
          operation, idempotency_key, request_fingerprint, session_id, relative_path,
          temp_name, state, result_json, created_at, expires_at, authority_proof_json, operation_id,
          principal_kind, principal_id
        ) VALUES ('session.files.write_text', ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.sessionId,
        input.relativePath,
        input.tempName,
        input.createdAt,
        input.expiresAt,
        JSON.stringify(input.proof),
        operationId,
        principal.kind,
        principal.id,
      );
      appendSessionFileSagaEvent(this.db, {
        table: "session_file_write_events_v6",
        resourceKind: "session_files",
        operationId,
        sessionId: input.sessionId,
        revision: 1,
        eventKind: "prepared",
        proof: input.proof,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        effect: "none",
        payload: { relativePath: input.relativePath, tempName: input.tempName },
      });
      this.db.exec("COMMIT");
      return {
        kind: "pending",
        operationId,
        sessionId: input.sessionId,
        relativePath: input.relativePath,
        tempName: input.tempName,
        prepared: null,
        resumed: false,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordPreparedSessionFileWrite(input: {
    proof: MutationAuthorityProof;
    idempotencyKey: string;
    requestFingerprint: string;
    prepared: SessionFileWritePreparedProof;
  }): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.proof, input.idempotencyKey);
      if (!existing) throw new Error("Prepared Session file write idempotency record is missing.");
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind !== "pending") {
        this.db.exec("COMMIT");
        return;
      }
      if (resolved.prepared && !samePreparedProof(resolved.prepared, input.prepared)) {
        throw new Error("Pending Session file write proof changed between retries.");
      }
      const principal = mutationPrincipalIdentity(input.proof);
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET output_sha256 = ?, byte_length = ?, file_device = ?, file_inode = ?, target_precondition_json = ?
        WHERE operation = 'session.files.write_text'
          AND principal_kind = ? AND principal_id = ? AND idempotency_key = ? AND state = 'pending'
      `).run(
        input.prepared.sha256,
        input.prepared.byteLength,
        input.prepared.device,
        input.prepared.inode,
        JSON.stringify(input.prepared.targetPrecondition),
        principal.kind,
        principal.id,
        input.idempotencyKey,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeSessionFileWrite(input: {
    proof: MutationAuthorityProof;
    idempotencyKey: string;
    requestFingerprint: string;
    prepared: SessionFileWritePreparedProof;
    result: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.proof, input.idempotencyKey);
      if (!existing) {
        throw new Error("Prepared Session file write idempotency record is missing.");
      }
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind === "replay") {
        this.db.exec("COMMIT");
        return resolved.result;
      }
      if (resolved.kind === "rejected") {
        throw new Error("Rejected Session file write cannot be completed as applied.");
      }
      if (!resolved.prepared || !samePreparedProof(resolved.prepared, input.prepared)) {
        throw new Error("Session file write completion does not match the prepared proof.");
      }
      const resultJson = JSON.stringify(input.result);
      const principal = mutationPrincipalIdentity(input.proof);
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET state = 'applied', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'session.files.write_text'
          AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?
      `).run(resultJson, input.completedAt, input.expiresAt, principal.kind, principal.id, input.idempotencyKey);
      const proof = decodeStoredMutationProof(
        this.db,
        existing.session_id,
        existing.authority_proof_json,
        input.completedAt,
      );
      appendSessionFileSagaEvent(this.db, {
        table: "session_file_write_events_v6",
        resourceKind: "session_files",
        operationId: existing.operation_id,
        sessionId: existing.session_id,
        revision: 2,
        eventKind: "applied",
        proof,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.completedAt,
        effect: "committed",
        payload: { relativePath: existing.relative_path, result: input.result },
      });
      this.db.exec("COMMIT");
      return JSON.parse(resultJson) as unknown;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rejectSessionFileWrite(input: {
    proof: MutationAuthorityProof;
    idempotencyKey: string;
    requestFingerprint: string;
    error: unknown;
    completedAt: string;
    expiresAt: string;
  }): unknown {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existing = this.findSessionFileWriteIdempotency(input.proof, input.idempotencyKey);
      if (!existing) {
        throw new Error("Prepared Session file write idempotency record is missing.");
      }
      const resolved = resolveSessionFileWriteIdempotency(existing, input.requestFingerprint);
      if (resolved.kind === "rejected") {
        this.db.exec("COMMIT");
        return resolved.error;
      }
      if (resolved.kind === "replay") {
        throw new Error("Applied Session file write cannot be completed as rejected.");
      }
      const errorJson = JSON.stringify(input.error);
      const principal = mutationPrincipalIdentity(input.proof);
      this.db.prepare(`
        UPDATE session_file_write_idempotency_v6
        SET state = 'rejected', result_json = ?, created_at = ?, expires_at = ?
        WHERE operation = 'session.files.write_text'
          AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?
      `).run(errorJson, input.completedAt, input.expiresAt, principal.kind, principal.id, input.idempotencyKey);
      const proof = decodeStoredMutationProof(
        this.db,
        existing.session_id,
        existing.authority_proof_json,
        input.completedAt,
      );
      appendSessionFileSagaEvent(this.db, {
        table: "session_file_write_events_v6",
        resourceKind: "session_files",
        operationId: existing.operation_id,
        sessionId: existing.session_id,
        revision: 2,
        eventKind: "rejected",
        proof,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.completedAt,
        effect: "unknown",
        payload: { relativePath: existing.relative_path, error: input.error },
      });
      this.db.exec("COMMIT");
      return JSON.parse(errorJson) as unknown;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cleanupAppliedSessionFileWriteIdempotency(nowIso: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_file_write_idempotency_v6
      WHERE state IN ('applied', 'rejected') AND expires_at <= ?
    `).run(nowIso);
    return Number(result.changes);
  }

  setSessionPinned(sessionId: string, isPinned: boolean): SessionSummary {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const changed = this.db.prepare(`
        UPDATE sessions_v6
        SET is_pinned = ?, resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(isPinned ? 1 : 0, sessionId);
      if (Number(changed.changes) !== 1) throw new Error("対象セッションが見つからないよ。");
      appendStoredSessionSnapshotEvent(this.db, sessionId, "pin_changed");
      const summary = this.getSessionSummary(sessionId);
      if (!summary) throw new Error("対象セッションが見つからないよ。");
      this.db.exec("COMMIT");
      return summary;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionMessageArtifact(sessionId: string, messageIndex: number): MessageArtifact | null {
    const row = this.db.prepare(`
      SELECT role, body, artifact_body
      FROM session_messages_v6
      WHERE session_id = ? AND seq = ?
    `).get(sessionId, messageIndex) as MessageV6Row | undefined;
    return row ? decodeMessageArtifact(row.artifact_body) ?? decodeMessage(row)?.artifact ?? null : null;
  }

  listSessionIdsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): string[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM sessions_v6
      WHERE deleted_at IS NULL AND last_active_at < ?
      ORDER BY last_active_at ASC, id ASC
    `).all(cutoff.cutoffIso) as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => id.trim().length > 0);
  }

  upsertSession(session: Session): Session {
    return this.storeSession(session, "upsert");
  }

  upsertTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Session {
    return this.storeSession(session, "upsert", terminalCommit);
  }

  clearCharacterAuthoringRuntimeState(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): SessionCharacterAuthoringRuntimeClearResult {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new Error("Character authoring runtime clearの保存形式が不正だよ。");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const currentRow = this.db.prepare(`
        SELECT sessions_v6.*,
          b.session_role AS role_session_role,
          b.role_contract_revision,
          b.root_session_id AS role_root_session_id,
          b.parent_session_id AS role_parent_session_id,
          b.delegation_depth AS role_delegation_depth
        FROM sessions_v6
        LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
        WHERE sessions_v6.id = ? AND sessions_v6.deleted_at IS NULL
      `).get(sessionId) as SessionV6Row | undefined;
      if (!currentRow) {
        throw new Error("対象セッションが見つからないよ。");
      }
      if (currentRow.session_kind !== "character-authoring") {
        throw new Error("Character authoring runtime clearのownerが一致しないよ。");
      }

      const updateResult = this.db.prepare(`
        UPDATE sessions_v6
        SET character_snapshot_json = NULL,
            character_id = NULL,
            thread_id = '',
            resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(sessionId);
      if (Number(updateResult.changes) !== 1) {
        throw new Error("Character authoring runtime stateをclearできなかったよ。");
      }
      appendStoredSessionSnapshotEvent(this.db, sessionId, "character_runtime_cleared");

      const storedRow: SessionV6Row = {
        ...currentRow,
        character_snapshot_json: null,
        character_id: null,
        thread_id: "",
      };
      const storedResult: SessionCharacterAuthoringRuntimeClearResult = {
        summary: this.rowToSessionSummary(storedRow, decodeSessionV6RuntimeState(storedRow)),
        characterRuntimeSnapshot: null,
      };
      this.db.exec("COMMIT");
      return storedResult;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendRunningTurnStart(input: SessionRunningTurnStartInput): SessionRunningTurnStartResult {
    const sessionId = input.sessionId.trim();
    if (
      !sessionId
      || !Number.isSafeInteger(input.expectedMessageCount)
      || input.expectedMessageCount < 0
      || input.userMessage.role !== "user"
      || !input.userMessage.text.trim()
      || !input.updatedAt.trim()
    ) {
      throw new Error("running turn 開始の保存形式が不正だよ。");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const currentRow = this.db.prepare(`
        SELECT sessions_v6.*,
          b.session_role AS role_session_role,
          b.role_contract_revision,
          b.root_session_id AS role_root_session_id,
          b.parent_session_id AS role_parent_session_id,
          b.delegation_depth AS role_delegation_depth
        FROM sessions_v6
        LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = sessions_v6.id
        WHERE sessions_v6.id = ? AND sessions_v6.deleted_at IS NULL
      `).get(sessionId) as SessionV6Row | undefined;
      if (!currentRow) {
        throw new Error("対象セッションが見つからないよ。");
      }

      const updatesCharacterSnapshot = input.characterRuntimeSnapshot !== undefined;
      const nextCharacterSnapshot = input.characterRuntimeSnapshot;
      const currentRuntimeState = decodeSessionV6RuntimeState(currentRow);
      if (updatesCharacterSnapshot) {
        if (currentRow.session_kind !== "character-authoring") {
          throw new Error("running turn 開始のCharacter snapshot ownerが一致しないよ。");
        }
        if (
          nextCharacterSnapshot
          && nextCharacterSnapshot.characterId !== currentRuntimeState.characterId
        ) {
          throw new Error("running turn 開始のCharacter snapshot ownerが一致しないよ。");
        }
      }

      const tailRow = this.db.prepare(`
        SELECT seq
        FROM session_messages_v6
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `).get(sessionId) as SessionMessageSequenceRow | undefined;
      const actualMessageCount = tailRow ? tailRow.seq + 1 : 0;
      if (actualMessageCount !== input.expectedMessageCount) {
        throw new SessionRunningTurnStartConflictError(
          sessionId,
          input.expectedMessageCount,
          actualMessageCount,
        );
      }

      const runtimePolicyJson = JSON.stringify({
        ...parseJsonObject(currentRow.runtime_policy_json),
        appStatus: "running",
        runState: "running",
        ...(nextCharacterSnapshot ? {
          characterName: nextCharacterSnapshot.name,
          characterIconPath: nextCharacterSnapshot.iconFilePath,
          characterThemeColors: nextCharacterSnapshot.theme,
        } : {}),
      });
      const characterSnapshotJson = updatesCharacterSnapshot
        ? nextCharacterSnapshot
          ? stringifyCharacterRuntimeSnapshot(nextCharacterSnapshot)
          : null
        : currentRow.character_snapshot_json;
      const clearsProviderThread = updatesCharacterSnapshot && nextCharacterSnapshot === null;
      const updateResult = this.db.prepare(`
        UPDATE sessions_v6
        SET state = 'active',
            runtime_policy_json = ?,
            character_snapshot_json = CASE WHEN ? = 1 THEN ? ELSE character_snapshot_json END,
            character_id = CASE WHEN ? = 1 THEN ? ELSE character_id END,
            thread_id = CASE WHEN ? = 1 THEN '' ELSE thread_id END,
            updated_at = ?,
            last_active_at = ?,
            resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        runtimePolicyJson,
        updatesCharacterSnapshot ? 1 : 0,
        characterSnapshotJson,
        updatesCharacterSnapshot ? 1 : 0,
        nextCharacterSnapshot?.characterId ?? null,
        clearsProviderThread ? 1 : 0,
        input.updatedAt,
        input.updatedAt,
        sessionId,
      );
      if (Number(updateResult.changes) !== 1) {
        throw new Error("running turn のSession metadataを更新できなかったよ。");
      }
      appendStoredSessionSnapshotEvent(this.db, sessionId, "running_turn_started", input.updatedAt);

      this.db.prepare(`
        INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
        VALUES (?, ?, 'user', ?, NULL, ?)
      `).run(
        sessionId,
        input.expectedMessageCount,
        encodeMessage(input.userMessage),
        input.updatedAt,
      );
      const storedRow: SessionV6Row = {
        ...currentRow,
        state: "active",
        runtime_policy_json: runtimePolicyJson,
        character_snapshot_json: characterSnapshotJson,
        character_id: updatesCharacterSnapshot
          ? nextCharacterSnapshot?.characterId ?? null
          : currentRow.character_id,
        thread_id: clearsProviderThread ? "" : currentRow.thread_id,
        updated_at: input.updatedAt,
        last_active_at: input.updatedAt,
      };
      const decodedStoredRow = decodeSessionV6RuntimeState(storedRow);
      const storedResult: SessionRunningTurnStartResult = {
        summary: this.rowToSessionSummary(storedRow, decodedStoredRow),
        characterRuntimeSnapshot: decodedStoredRow.snapshot,
      };
      this.db.exec("COMMIT");
      return storedResult;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertSession(session: Session): Session {
    return this.storeSession(session, "create");
  }

  private storeSession(
    session: Session,
    operation: "create" | "upsert",
    terminalCommit?: SessionTurnTerminalCommit,
  ): Session {
    const normalized = normalizeSessionForStorage(session);
    if (terminalCommit && terminalCommit.sessionId !== normalized.id) {
      throw new Error("terminal Session と audit marker の owner が一致しないよ。");
    }

    const startedAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const terminalSession = terminalCommit
        ? this.mergeTerminalSessionWithCurrentProjection(normalized, terminalCommit)
        : normalized;
      this.writeSession(terminalSession, operation);
      if (operation === "create") {
        this.consumeCreatedSessionResources(terminalSession);
      }
      if (operation === "create" && terminalSession.sessionKind === "default" && terminalSession.roleBinding) {
        ensureBaselineSessionAuthority(this.db, terminalSession.id, terminalSession.updatedAt);
      }
      appendStoredSessionSnapshotEvent(
        this.db,
        terminalSession.id,
        operation === "create" ? "created" : "stored",
        terminalSession.updatedAt,
      );
      if (terminalCommit) {
        writeSessionTurnTerminalCommit(this.db, terminalCommit);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      logSessionRunStuckInvestigation(`storage-v6.${operation}-session.failed`, {
        sessionId: normalized.id,
        durationMs: Date.now() - startedAt,
        messageCount: normalized.messages.length,
        runState: normalized.runState,
        status: normalized.status,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let stored = normalized;
    try {
      stored = this.getSession(normalized.id) ?? normalized;
    } catch (error) {
      console.warn("Committed Session read-back failed", error);
    }
    logSessionRunStuckInvestigation(`storage-v6.${operation}-session.done`, {
      sessionId: normalized.id,
      durationMs: Date.now() - startedAt,
      messageCount: normalized.messages.length,
      runState: normalized.runState,
      status: normalized.status,
      storedRunState: stored.runState,
      storedStatus: stored.status,
    });
    return stored;
  }

  private mergeTerminalSessionWithCurrentProjection(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Session {
    // Use the storage-owned read path here. Public getSession is intentionally
    // replaceable by callers for post-commit read-back handling; terminal
    // conflict protection must still complete the transaction when that
    // read-back is unavailable.
    const current = this.getLifecycleSession(session.id, true);
    if (!current) {
      return session;
    }
    const bindingChanged = (current.roleBinding === null || session.roleBinding === null
      ? current.roleBinding !== session.roleBinding
      : !sameSessionRoleBinding(current.roleBinding, session.roleBinding))
      || !sameSessionRuntimeBindingProjection(current, session)
      || this.hasConcurrentSessionBindingMutation(session.id, terminalCommit.auditLogId);
    return {
      ...session,
      taskTitle: current.taskTitle,
      isPinned: current.isPinned,
      provider: current.provider,
      catalogRevision: current.catalogRevision,
      workspaceLabel: current.workspaceLabel,
      workspacePath: current.workspacePath,
      branch: current.branch,
      accessMode: current.accessMode,
      characterId: current.characterId,
      character: current.character,
      characterIconPath: current.characterIconPath,
      characterThemeColors: current.characterThemeColors,
      characterRuntimeSnapshot: current.characterRuntimeSnapshot,
      approvalMode: current.approvalMode,
      codexSandboxMode: current.codexSandboxMode,
      codexSpeed: current.codexSpeed,
      codexReviewer: current.codexReviewer,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      customAgentName: current.customAgentName,
      allowedAdditionalDirectories: [...current.allowedAdditionalDirectories],
      // Preserve a newer binding's thread state, but otherwise persist the
      // provider thread returned by this terminal turn.
      threadId: bindingChanged ? current.threadId : terminalCommit.threadId,
    };
  }

  private hasConcurrentSessionBindingMutation(sessionId: string, auditLogId: number): boolean {
    // Session history orders mutations even when timestamps share a millisecond.
    // The persisted turn-start snapshot precedes the audit row and provider run.
    const row = this.db.prepare(`
      SELECT 1
      FROM session_resource_events_v6 AS event
      LEFT JOIN session_lifecycle_operations_v6 AS operation
        ON operation.operation_id = json_extract(event.payload_json, '$.lifecycleOperationId')
      WHERE event.session_id = ?
        AND event.revision > (
          SELECT MAX(start.revision)
          FROM session_resource_events_v6 AS start
          INNER JOIN resource_event_headers_v6 AS header
            ON header.event_id = 'session:' || start.session_id || ':revision:' || start.revision
          INNER JOIN session_turns_v6 AS turn ON turn.id = ? AND turn.session_id = start.session_id
          WHERE start.session_id = event.session_id
            AND start.event_kind = 'running_turn_started'
            AND header.occurred_at <= turn.started_at
        )
        AND (
          (event.event_kind = 'lifecycle.session.configure'
            AND json_extract(operation.manifest_json, '$.input.kind') <> 'title')
          OR event.event_kind = 'lifecycle.session.restore'
          OR (event.event_kind = 'move' AND json_extract(event.payload_json, '$.sourceRootSessionId') IS NOT NULL)
        )
      LIMIT 1
    `).get(sessionId, auditLogId);
    return row !== undefined;
  }

  replaceSessions(nextSessions: Session[]): Session[] {
    const normalizedSessions = nextSessions.map((session) => normalizeSessionForStorage(session));

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const retainedSessionIds = normalizedSessions.map((session) => session.id);
      const removedSessionIds = this.listStoredSessionIdsExcept(retainedSessionIds);
      this.tombstoneStoredSessionsByIds(removedSessionIds);
      for (const session of normalizedSessions) {
        this.writeSession(session);
        appendStoredSessionSnapshotEvent(this.db, session.id, "stored", session.updatedAt);
      }
      this.db.exec("COMMIT");
      return this.listSessions();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(sessionId: string): void {
    this.deleteSessions([sessionId]);
  }

  deleteSessions(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.tombstoneStoredSessionsByIds(uniqueSessionIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearSessions(): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const sessionIds = (this.db.prepare("SELECT id FROM sessions_v6 WHERE deleted_at IS NULL").all() as SessionIdRow[])
        .map((row) => row.id);
      this.tombstoneStoredSessionsByIds(sessionIds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private resolveSessionCrudIdempotencyWithoutCleanup(
    operation: SessionCrudOperation,
    principalSessionId: string,
    idempotencyKey: string,
    resolveExpectedFingerprint: string | ((result: unknown) => string),
  ): SessionCrudReplayResult {
    const row = this.db.prepare(`
      SELECT request_fingerprint, session_id, result_json
      FROM session_crud_idempotency_v6
      WHERE operation = ? AND principal_session_id = ? AND idempotency_key = ?
    `).get(operation, principalSessionId, idempotencyKey) as SessionCrudIdempotencyRow | undefined;
    if (!row) {
      const legacy = this.db.prepare(`
        SELECT 1
        FROM session_crud_idempotency_v6
        WHERE operation = ? AND principal_session_id LIKE 'legacy_unknown:%' AND idempotency_key = ?
        LIMIT 1
      `).get(operation, idempotencyKey);
      if (legacy) throw new SessionCrudIdempotencyResponseUnavailableError(operation, idempotencyKey);
      return { kind: "absent" };
    }
    const result = JSON.parse(row.result_json) as unknown;
    const expectedFingerprint = typeof resolveExpectedFingerprint === "function"
      ? resolveExpectedFingerprint(result)
      : resolveExpectedFingerprint;
    if (row.request_fingerprint !== expectedFingerprint) {
      throw new SessionCrudIdempotencyConflictError();
    }
    return {
      kind: "replay",
      sessionId: row.session_id,
      result,
    };
  }

  private insertSessionCrudIdempotency(
    input: {
      operation: SessionCrudOperation;
      principalSessionId?: string;
      proof: MutationAuthorityProof;
      idempotencyKey: string;
      requestFingerprint: string;
      createdAt: string;
      expiresAt: string;
    },
    sessionId: string,
    result: unknown,
  ): void {
    this.db.prepare(`
      INSERT INTO session_crud_idempotency_v6 (
        operation,
        principal_session_id,
        idempotency_key,
        request_fingerprint,
        session_id,
        result_json,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operation,
      sessionPrincipalKey(input.proof),
      input.idempotencyKey,
      input.requestFingerprint,
      sessionId,
      JSON.stringify(result),
      input.createdAt,
      input.expiresAt,
    );
  }

  private findSessionFileWriteIdempotency(
    proof: MutationAuthorityProof,
    idempotencyKey: string,
  ): SessionFileWriteIdempotencyRow | undefined {
    const principal = mutationPrincipalIdentity(proof);
    const row = this.db.prepare(`
      SELECT operation_id, request_fingerprint, session_id, relative_path, temp_name, state,
        output_sha256, byte_length, file_device, file_inode, target_precondition_json, result_json,
        authority_proof_json
      FROM session_file_write_idempotency_v6
      WHERE operation = 'session.files.write_text'
        AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?
    `).get(principal.kind, principal.id, idempotencyKey) as SessionFileWriteIdempotencyRow | undefined;
    if (row) return row;
    const legacy = this.db.prepare(`
      SELECT state
      FROM session_file_write_idempotency_v6
      WHERE operation = 'session.files.write_text'
        AND principal_kind = 'legacy_unknown' AND idempotency_key = ?
      LIMIT 1
    `).get(idempotencyKey) as { state: "pending" | "applied" | "rejected" } | undefined;
    if (legacy) throw new SessionFileWriteIdempotencyResponseUnavailableError(idempotencyKey, legacy.state);
    return undefined;
  }

  private findSessionRoleBindingRow(sessionId: string): SessionRoleBindingRow | undefined {
    return this.db.prepare(`
      SELECT session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      FROM session_role_bindings_v6
      WHERE session_id = ?
    `).get(sessionId) as SessionRoleBindingRow | undefined;
  }

  private writeSession(session: Session, operation: "create" | "upsert" = "upsert"): void {
    const startedAt = Date.now();
    const existingRoleBindingRow = this.findSessionRoleBindingRow(session.id);
    const existingSessionRow = this.db.prepare("SELECT session_kind FROM sessions_v6 WHERE id = ?").get(session.id) as
      | { session_kind: string }
      | undefined;
    if (session.sessionKind === "default") {
      if (!session.roleBinding) {
        throw new Error(`Normal Session Role binding is missing: ${session.id}`);
      }
      if (existingRoleBindingRow) {
        const existingBinding = decodeSessionRoleBinding(session.id, existingRoleBindingRow);
        if (!sameSessionRoleBinding(existingBinding, session.roleBinding)) {
          throw new Error(`Session Role binding is immutable: ${session.id}`);
        }
      } else if (existingSessionRow) {
        throw new Error(`Stored normal Session Role binding is missing: ${session.id}`);
      }
    } else if (session.roleBinding !== null || existingRoleBindingRow) {
      throw new Error(`Non-normal Session cannot use a normal Session Role binding: ${session.id}`);
    }
    const snapshot = session.characterRuntimeSnapshot;
    const runtimePolicy = {
      appStatus: session.status,
      runState: session.runState,
      workspaceLabel: session.workspaceLabel,
      branch: session.branch,
      accessMode: session.accessMode,
      sourceSchemaVersion: session.sourceSchemaVersion,
      characterId: session.characterId,
      characterName: session.character,
      characterIconPath: session.characterIconPath,
      characterThemeColors: session.characterThemeColors,
      codexSpeed: session.codexSpeed,
      codexReviewer: session.codexReviewer,
    };
    const conflictClause = operation === "create"
      ? "ON CONFLICT(id) DO NOTHING"
      : `
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          state = excluded.state,
          session_kind = excluded.session_kind,
          provider_id = excluded.provider_id,
          catalog_revision = excluded.catalog_revision,
          model_id = excluded.model_id,
          reasoning_effort = excluded.reasoning_effort,
          custom_agent_name = excluded.custom_agent_name,
          approval_mode = excluded.approval_mode,
          codex_sandbox_mode = excluded.codex_sandbox_mode,
          allowed_additional_directories_json = excluded.allowed_additional_directories_json,
          runtime_policy_json = excluded.runtime_policy_json,
          thread_id = excluded.thread_id,
          character_id = excluded.character_id,
          character_snapshot_json = excluded.character_snapshot_json,
          workspace_path = excluded.workspace_path,
          updated_at = excluded.updated_at,
          last_active_at = excluded.last_active_at,
          resource_revision = sessions_v6.resource_revision + 1
        WHERE sessions_v6.deleted_at IS NULL
      `;
    const result = this.db.prepare(`
      INSERT INTO sessions_v6 (
        id,
        title,
        state,
        session_kind,
        provider_id,
        catalog_revision,
        model_id,
        reasoning_effort,
        custom_agent_name,
        approval_mode,
        codex_sandbox_mode,
        allowed_additional_directories_json,
        runtime_policy_json,
        thread_id,
        character_id,
        character_snapshot_json,
        workspace_path,
        is_pinned,
        created_at,
        updated_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).run(
      session.id,
      session.taskTitle,
      toV6State(session),
      session.sessionKind,
      session.provider,
      session.catalogRevision,
      session.model,
      session.reasoningEffort,
      session.customAgentName,
      session.approvalMode,
      session.codexSandboxMode,
      JSON.stringify(session.allowedAdditionalDirectories),
      JSON.stringify(runtimePolicy),
      session.threadId,
      snapshot ? session.characterId : null,
      snapshot ? stringifyCharacterRuntimeSnapshot(snapshot) : null,
      session.workspacePath,
      session.isPinned === true ? 1 : 0,
      session.updatedAt,
      session.updatedAt,
      session.updatedAt,
    );
    if (Number(result.changes) === 0) {
      throw new SessionIdCollisionError(session.id);
    }

    if (session.sessionKind === "default" && !existingRoleBindingRow) {
      const binding = requireSessionRoleBinding(session.id, session.roleBinding);
      this.db.prepare(`
        INSERT INTO session_role_bindings_v6 (
          session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        binding.sessionRole,
        binding.roleContractRevision,
        binding.rootSessionId,
        binding.parentSessionId,
        binding.delegationDepth,
      );
    }

    this.ensureRootWorkItem(session);

    const existingArtifactBodies = new Map(
      (this.db.prepare(`
        SELECT seq, artifact_body
        FROM session_messages_v6
        WHERE session_id = ?
      `).all(session.id) as ExistingMessageArtifactRow[])
        .map((row) => [row.seq, row.artifact_body] as const),
    );

    this.db.prepare("DELETE FROM session_messages_v6 WHERE session_id = ?").run(session.id);
    const insertMessage = this.db.prepare(`
      INSERT INTO session_messages_v6 (session_id, seq, role, body, artifact_body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    session.messages.forEach((message, index) => {
      insertMessage.run(
        session.id,
        index,
        message.role,
        encodeMessage(message),
        encodeMessageArtifactForWrite(message, existingArtifactBodies.get(index)),
        session.updatedAt,
      );
    });
    logSessionRunStuckInvestigation("storage-v6.write-session.done", {
      sessionId: session.id,
      durationMs: Date.now() - startedAt,
      messageCount: session.messages.length,
      existingArtifactBodyCount: existingArtifactBodies.size,
      runState: session.runState,
      status: session.status,
    });
  }

  private ensureSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(session_messages_v6)").all() as Array<{ name?: unknown }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );

    if (!columns.has("artifact_body")) {
      this.db.exec("ALTER TABLE session_messages_v6 ADD COLUMN artifact_body TEXT;");
    }
  }

  private consumeCreatedSessionResources(session: Session, accountOwnerSessionId?: string): void {
    if (session.sessionKind !== "default" || !session.roleBinding) return;
    const binding = session.roleBinding;
    const isRoot = binding.rootSessionId === session.id
      && binding.parentSessionId === null
      && binding.delegationDepth === 0;
    if (isRoot) {
      this.resourceBudgetStorage.bootstrapRootBudget({
        rootSessionId: session.id,
        rootCreatedAt: session.updatedAt,
        createdAt: session.updatedAt,
      });
      return;
    }
    this.resourceBudgetStorage.consumeCount({
      sessionId: accountOwnerSessionId ?? binding.parentSessionId ?? session.id,
      dimension: "sessions",
      idempotencyKey: `session.create:${session.id}`,
      consumedAt: session.updatedAt,
    });
  }

  private ensureRootWorkItem(session: Session): void {
    const binding = session.roleBinding;
    const isEligibleRoot = session.sessionKind === "default"
      && binding !== null
      && (binding.sessionRole === "standalone" || binding.sessionRole === "overall-coordinator")
      && binding.rootSessionId === session.id
      && binding.parentSessionId === null
      && binding.delegationDepth === 0;
    if (!isEligibleRoot) return;

    const existing = this.db.prepare(`
      SELECT id, creator_session_id, target_session_id, parent_work_item_id
      FROM work_items_v6
      WHERE kind = 'root' AND root_session_id = ?
    `).get(session.id) as {
      id: string;
      creator_session_id: string;
      target_session_id: string;
      parent_work_item_id: string | null;
    } | undefined;
    if (existing) {
      if (
        existing.creator_session_id !== session.id
        || existing.target_session_id !== session.id
        || existing.parent_work_item_id !== null
      ) {
        throw new Error(`Root Work Item binding is invalid: ${existing.id}`);
      }
      return;
    }

    const workItemId = `root-work-item:${session.id}`;
    const sourceIdentity = {
      workspace: session.workspacePath.trim() || null,
      repository: null,
      branch: session.branch.trim() || null,
      base: null,
      head: null,
    };
    const payload: WorkItemCreatedEventPayload = {
      kind: "root",
      rootSessionId: session.id,
      creatorSessionId: session.id,
      targetSessionId: session.id,
      parentWorkItemId: null,
      sourceIdentity,
      contract: {
        goal: session.taskTitle,
        scope: "",
        completionCriteria: "",
        authority: "",
      },
      progress: {
        progressSummary: "",
        blockers: [],
        nextAction: "",
      },
      state: "pending",
      result: null,
    };
    assertWorkItemEventPayloadWithinLimit("created", payload);
    this.db.prepare(`
      INSERT INTO work_items_v6 (
        id, kind, contract_revision, root_session_id, creator_session_id,
        target_session_id, parent_work_item_id, goal, scope, completion_criteria,
        authority, source_identity_json, state, revision, progress_summary,
        blockers_json, next_action, result_json, created_at, updated_at
      ) VALUES (?, 'root', 2, ?, ?, ?, NULL, ?, '', '', '', ?, 'pending', 1, '', '[]', '', NULL, ?, ?)
    `).run(
      workItemId,
      session.id,
      session.id,
      session.id,
      session.taskTitle,
      JSON.stringify(sourceIdentity),
      session.updatedAt,
      session.updatedAt,
    );
    this.db.prepare(`
      INSERT INTO work_item_events_v6 (
        work_item_id, revision, event_type, actor_session_id, principal_kind, payload_json, created_at
      ) VALUES (?, 1, 'created', ?, 'system', ?, ?)
    `).run(workItemId, session.id, JSON.stringify(payload), session.updatedAt);
    appendWorkItemEventHeader(this.db, {
      workItemId,
      revision: 1,
      eventKind: "created",
      proof: systemSessionProof(session, "session.create", "local_mutation", session.updatedAt),
      operationId: `system:root-work-item.create:${session.id}`,
      idempotencyKey: null,
      occurredAt: session.updatedAt,
    });
  }

  private rowToSessionSummaryProjection(row: SessionV6SummaryRow): SessionSummary {
    const runtimePolicy = parseJsonObject(row.runtime_policy_json);
    const runtimeCharacterId = normalizeCharacterOwnerId(runtimePolicy.characterId);
    const storedCharacterId = normalizeCharacterOwnerId(row.character_id) ?? runtimeCharacterId;
    const characterId = recoverStoredCharacterOwnerId(storedCharacterId);
    const unresolvedOwner = isUnknownCharacterOwnerId(characterId);
    const snapshotCharacterId = normalizeCharacterOwnerId(row.snapshot_character_id);
    const hasValidSnapshot = row.character_snapshot_present === 1 &&
      row.snapshot_json_valid === 1 &&
      typeof row.snapshot_name === "string" &&
      row.snapshot_definition_markdown_type === "text";
    const snapshot = hasValidSnapshot && !unresolvedOwner && snapshotCharacterId === characterId
      ? {
          characterId,
          name: row.snapshot_name as string,
          description: "",
          iconFilePath: typeof row.snapshot_icon_file_path === "string" ? row.snapshot_icon_file_path : "",
          theme: {
            main: typeof row.snapshot_theme_main === "string"
              ? row.snapshot_theme_main
              : DEFAULT_CHARACTER_THEME_COLORS.main,
            sub: typeof row.snapshot_theme_sub === "string"
              ? row.snapshot_theme_sub
              : DEFAULT_CHARACTER_THEME_COLORS.sub,
          },
          definitionMarkdown: "",
          definitionSha256: "",
          definitionByteSize: 0,
          snapshotAt: "",
        }
      : null;
    const decoded: DecodedSessionV6RuntimeState = {
      runtimePolicy,
      characterId,
      snapshot,
      threadId: unresolvedOwner || (row.character_snapshot_present === 1 && snapshot === null) ? "" : row.thread_id,
    };
    return this.rowToSessionSummary(row, decoded);
  }

  private rowToSessionSummary(
    row: SessionV6SummaryBaseRow,
    decoded?: DecodedSessionV6RuntimeState,
  ): SessionSummary {
    const resolvedDecoded = decoded ?? decodeSessionV6RuntimeState(row as SessionV6Row);
    const { runtimePolicy, snapshot, characterId, threadId } = resolvedDecoded;
    const sessionKind = row.session_kind === "character-authoring" ? "character-authoring" : "default";
    const roleBinding = sessionKind === "default"
      ? decodeSessionRoleBinding(row.id, {
          session_role: requireStoredRoleField(row.role_session_role, row.id),
          role_contract_revision: requireStoredRoleField(row.role_contract_revision, row.id),
          root_session_id: requireStoredRoleField(row.role_root_session_id, row.id),
          parent_session_id: row.role_parent_session_id,
          delegation_depth: requireStoredRoleField(row.role_delegation_depth, row.id),
        })
      : null;
    if (sessionKind === "character-authoring" && row.role_session_role !== null) {
      throw new Error(`Non-normal Session has a Role binding: ${row.id}`);
    }
    const summary = normalizeSessionSummary({
      id: row.id,
      taskTitle: row.title,
      status: typeof runtimePolicy.appStatus === "string" ? runtimePolicy.appStatus : row.state === "active" ? "running" : "idle",
      updatedAt: row.updated_at || row.last_active_at,
      isPinned: row.is_pinned === 1,
      provider: row.provider_id,
      catalogRevision: row.catalog_revision,
      workspaceLabel: runtimePolicy.workspaceLabel,
      workspacePath: row.workspace_path,
      branch: runtimePolicy.branch,
      sessionKind,
      accessMode: runtimePolicy.accessMode,
      sourceSchemaVersion: runtimePolicy.sourceSchemaVersion ?? CURRENT_SESSION_SCHEMA_VERSION,
      roleBinding,
      characterId,
      character: snapshot?.name ?? runtimePolicy.characterName,
      characterIconPath: snapshot?.iconFilePath ?? runtimePolicy.characterIconPath,
      characterThemeColors: snapshot?.theme ?? runtimePolicy.characterThemeColors,
      runState: runtimePolicy.runState,
      approvalMode: row.approval_mode,
      codexSandboxMode: row.codex_sandbox_mode,
      codexSpeed: runtimePolicy.codexSpeed,
      codexReviewer: runtimePolicy.codexReviewer,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      customAgentName: row.custom_agent_name,
      allowedAdditionalDirectories: parseJsonArray(row.allowed_additional_directories_json),
      threadId,
    });
    if (!summary) {
      throw new Error(`V6 session row を summary に変換できないよ: ${row.id}`);
    }
    return summary;
  }

  private rowToHomeSessionSummary(row: HomeSessionSummaryV6Row): HomeSessionSummary | null {
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

  private rowToSession(row: SessionV6Row): Session {
    const decoded = decodeSessionV6RuntimeState(row);
    const summary = this.rowToSessionSummary(row, decoded);
    const messageRows = this.db.prepare(`
      SELECT role, body
      FROM session_messages_v6
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(row.id) as MessageV6Row[];
    const session = normalizeSession({
      ...summary,
      characterRuntimeSnapshot: decoded.snapshot,
      messages: messageRows.map((messageRow) => decodeMessage(messageRow)).filter((message): message is Message => message !== null),
      stream: [],
    });
    if (!session) {
      throw new Error(`V6 session row を session に変換できないよ: ${row.id}`);
    }
    return session;
  }

  private listStoredSessionIdsExcept(retainedSessionIds: Iterable<string>): string[] {
    const retained = new Set(Array.from(retainedSessionIds).map((sessionId) => sessionId.trim()).filter(Boolean));
    const rows = this.db.prepare("SELECT id FROM sessions_v6 WHERE deleted_at IS NULL").all() as SessionIdRow[];
    return rows.map((row) => row.id).filter((id) => !retained.has(id));
  }

  private tombstoneStoredSessionsByIds(sessionIds: readonly string[], lifecycle?: {
    proof: MutationAuthorityProof;
    operationId: string;
    idempotencyKey: string | null;
    occurredAt: string;
  }): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    this.assertSessionsDeletable(uniqueSessionIds);
    const placeholders = uniqueSessionIds.map(() => "?").join(", ");
    const activeRows = this.db.prepare(`
      SELECT id, resource_revision FROM sessions_v6
      WHERE id IN (${placeholders}) AND deleted_at IS NULL
      ORDER BY id
    `).all(...uniqueSessionIds) as Array<SessionIdRow & { resource_revision: number }>;
    const deletedAt = new Date().toISOString();
    for (const row of activeRows) {
      this.db.prepare(`
        UPDATE sessions_v6
        SET deleted_at = ?, updated_at = ?, resource_revision = resource_revision + 1
        WHERE id = ? AND deleted_at IS NULL
      `).run(deletedAt, deletedAt, row.id);
      if (lifecycle) {
        appendSessionResourceEvent(this.db, {
          sessionId: row.id,
          revision: row.resource_revision + 1,
          eventKind: "lifecycle.session.delete",
          proof: lifecycle.proof,
          operationId: lifecycle.operationId,
          idempotencyKey: lifecycle.idempotencyKey,
          occurredAt: lifecycle.occurredAt,
          payload: { deletedAt, operation: "session.delete" },
        });
      } else {
        appendStoredSessionSnapshotEvent(this.db, row.id, "deleted", deletedAt);
      }
    }
  }

  private assertSessionsDeletable(sessionIds: readonly string[]): void {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    if (uniqueSessionIds.length === 0) return;
    const placeholders = uniqueSessionIds.map(() => "?").join(", ");

    const protectedItem = this.db.prepare(`
      SELECT item.id
      FROM work_items_v6 AS item
      WHERE (
        item.root_session_id IN (${placeholders})
        OR item.creator_session_id IN (${placeholders})
        OR item.target_session_id IN (${placeholders})
      )
        AND (
          item.state IN ('pending', 'in_progress', 'waiting')
          OR (
            item.kind = 'delegated'
            AND item.parent_work_item_id IS NULL
            AND item.state <> 'canceled'
            AND (
              item.result_json IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM work_items_v6 AS root_item
                WHERE root_item.kind = 'root'
                  AND root_item.root_session_id = item.root_session_id
                  AND root_item.state IN ('completed', 'partially_completed', 'failed', 'canceled')
              )
            )
          )
          OR (
            item.kind = 'delegated'
            AND item.parent_work_item_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM work_item_aggregation_decisions_v6 AS decision
              WHERE decision.child_work_item_id = item.id
                AND ${workItemDecisionRevisionMatchesSql("item")}
            )
          )
        )
      LIMIT 1
    `).get(...uniqueSessionIds, ...uniqueSessionIds, ...uniqueSessionIds) as { id?: unknown } | undefined;
    if (typeof protectedItem?.id === "string") {
      throw new Error(`WORK_ITEM_SESSION_PROTECTED: ${protectedItem.id}`);
    }

  }

}

function sessionOperationId(operation: SessionCrudOperation, proof: MutationAuthorityProof, requestFingerprint: string): string {
  return `session-operation:${operation}:${sessionPrincipalKey(proof)}:${requestFingerprint}`;
}

function sessionPrincipalKey(proof: MutationAuthorityProof): string {
  const principal = mutationPrincipalIdentity(proof);
  return `${principal.kind}:${principal.id}`;
}

function mutationPrincipalIdentity(proof: MutationAuthorityProof): {
  kind: "agent" | "user" | "system";
  id: string;
} {
  if (proof.principal.kind === "agent") {
    return { kind: "agent", id: proof.principal.actorSessionId };
  }
  if (proof.principal.kind === "user") {
    return { kind: "user", id: "local-user" };
  }
  return { kind: "system", id: proof.principal.service };
}

function decodeStoredMutationProof(
  db: DatabaseSync,
  sessionId: string,
  serialized: string | null,
  evaluatedAt: string,
): MutationAuthorityProof {
  if (serialized !== null) return JSON.parse(serialized) as MutationAuthorityProof;
  const binding = db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
    .get(sessionId) as { root_session_id: string } | undefined;
  return {
    principal: { kind: "system", service: "session-file-write-migration-recovery" },
    operation: "session.files.write_text",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "session.files.write_text",
    resolvedScope: {
      resourceKind: "session_files",
      resourceId: sessionId,
      rootSessionId: binding?.root_session_id ?? sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt,
  };
}

function systemSessionProof(
  session: Session,
  operation: "session.create",
  effectClass: "local_mutation",
  evaluatedAt: string,
): MutationAuthorityProof {
  const binding = requireSessionRoleBinding(session.id, session.roleBinding);
  return {
    principal: { kind: "system", service: "session-storage" },
    operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: operation,
    resolvedScope: {
      resourceKind: "session_namespace",
      resourceId: session.id,
      rootSessionId: binding.rootSessionId,
      ownerKind: "session",
      ownerId: session.id,
      relation: "self",
    },
    effectClass,
    grantId: null,
    grantRevision: null,
    evaluatedAt,
  };
}

function appendStoredSessionSnapshotEvent(
  db: DatabaseSync,
  sessionId: string,
  eventKind: string,
  occurredAt?: string,
): void {
  const row = db.prepare(`
    SELECT session.resource_revision, session.updated_at,
      COALESCE(binding.root_session_id, session.id) AS root_session_id
    FROM sessions_v6 AS session
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = session.id
    WHERE session.id = ?
  `).get(sessionId) as {
    resource_revision: number;
    updated_at: string;
    root_session_id: string;
  } | undefined;
  if (!row) throw new Error(`Session was not found: ${sessionId}`);
  const eventAt = occurredAt ?? row.updated_at;
  const operation = eventKind === "created" ? "session.create" : "session.rename";
  appendSessionResourceEvent(db, {
    sessionId,
    revision: row.resource_revision,
    eventKind,
    proof: {
      principal: { kind: "system", service: "session-storage" },
      operation,
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
      action: operation,
      resolvedScope: {
        resourceKind: operation === "session.create" ? "session_namespace" : "session",
        resourceId: sessionId,
        rootSessionId: row.root_session_id,
        ownerKind: "session",
        ownerId: sessionId,
        relation: "self",
      },
      effectClass: "local_mutation",
      grantId: null,
      grantRevision: null,
      evaluatedAt: eventAt,
    },
    operationId: `system:session-storage:${eventKind}:${sessionId}:${row.resource_revision}`,
    idempotencyKey: null,
    occurredAt: eventAt,
    payload: {},
  });
}

function resolveSessionFileWriteIdempotency(
  row: SessionFileWriteIdempotencyRow,
  requestFingerprint: string,
): SessionFileWriteReplayResult {
  if (row.request_fingerprint !== requestFingerprint) {
    throw new SessionFileWriteIdempotencyConflictError();
  }
  const prepared = decodePreparedProof(row);
  if (row.state === "applied") {
    if (!row.result_json) {
      throw new Error("Applied Session file write is missing its canonical result.");
    }
    return {
      kind: "replay",
      operationId: row.operation_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      tempName: row.temp_name,
      prepared,
      result: JSON.parse(row.result_json) as unknown,
    };
  }
  if (row.state === "rejected") {
    if (!row.result_json) {
      throw new Error("Rejected Session file write is missing its canonical error.");
    }
    return {
      kind: "rejected",
      operationId: row.operation_id,
      sessionId: row.session_id,
      relativePath: row.relative_path,
      tempName: row.temp_name,
      prepared,
      error: JSON.parse(row.result_json) as unknown,
    };
  }
  return {
    kind: "pending",
    operationId: row.operation_id,
    sessionId: row.session_id,
    relativePath: row.relative_path,
    tempName: row.temp_name,
    prepared,
    resumed: true,
  };
}

function decodePreparedProof(row: SessionFileWriteIdempotencyRow): SessionFileWritePreparedProof | null {
  const values = [row.output_sha256, row.byte_length, row.file_device, row.file_inode, row.target_precondition_json];
  if (values.every((value) => value === null)) return null;
  if (
    typeof row.output_sha256 !== "string"
    || typeof row.byte_length !== "number"
    || !Number.isSafeInteger(row.byte_length)
    || row.byte_length < 0
    || typeof row.file_device !== "string"
    || typeof row.file_inode !== "string"
    || (row.state === "pending" && typeof row.target_precondition_json !== "string")
  ) {
    throw new Error("Pending Session file write has an invalid prepared proof.");
  }
  const targetPrecondition = row.target_precondition_json === null
    ? { kind: "absent" } as const
    : JSON.parse(row.target_precondition_json) as unknown;
  if (!isTargetPrecondition(targetPrecondition)) {
    throw new Error("Pending Session file write has an invalid target precondition.");
  }
  return {
    sha256: row.output_sha256,
    byteLength: row.byte_length,
    device: row.file_device,
    inode: row.file_inode,
    targetPrecondition,
  };
}

function samePreparedProof(left: SessionFileWritePreparedProof, right: SessionFileWritePreparedProof): boolean {
  return left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.device === right.device
    && left.inode === right.inode
    && JSON.stringify(left.targetPrecondition) === JSON.stringify(right.targetPrecondition);
}

function sameSessionRuntimeBindingProjection(left: Session, right: Session): boolean {
  return left.provider === right.provider
    && left.catalogRevision === right.catalogRevision
    && left.workspaceLabel === right.workspaceLabel
    && left.workspacePath === right.workspacePath
    && left.branch === right.branch
    && left.accessMode === right.accessMode
    && left.characterId === right.characterId
    && left.character === right.character
    && left.characterIconPath === right.characterIconPath
    && JSON.stringify(left.characterThemeColors) === JSON.stringify(right.characterThemeColors)
    && JSON.stringify(left.characterRuntimeSnapshot) === JSON.stringify(right.characterRuntimeSnapshot)
    && left.approvalMode === right.approvalMode
    && left.codexSandboxMode === right.codexSandboxMode
    && left.codexSpeed === right.codexSpeed
    && left.codexReviewer === right.codexReviewer
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.customAgentName === right.customAgentName
    && JSON.stringify(left.allowedAdditionalDirectories) === JSON.stringify(right.allowedAdditionalDirectories);
}

function isTargetPrecondition(value: unknown): value is SessionFileTargetPrecondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionFileTargetPrecondition>;
  if (candidate.kind === "absent") return Object.keys(candidate).length === 1;
  return candidate.kind === "file"
    && typeof candidate.sha256 === "string"
    && typeof candidate.byteLength === "number"
    && Number.isSafeInteger(candidate.byteLength)
    && candidate.byteLength >= 0
    && typeof candidate.device === "string"
    && typeof candidate.inode === "string";
}
