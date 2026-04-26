import type { DatabaseSync } from "node:sqlite";

import {
  cloneCompanionSessions,
  cloneCompanionSessionSummaries,
  type CompanionChangedFileSummary,
  type CompanionGroup,
  type CompanionSession,
  type CompanionSessionSummary,
} from "../src/companion-state.js";
import type { Message } from "../src/session-state.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import { openAppDatabase } from "./sqlite-connection.js";

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
  changed_files_json: string;
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
  character_role_markdown: string;
  character_icon_path: string;
  character_theme_main: string;
  character_theme_sub: string;
  created_at: string;
  updated_at: string;
};

type CompanionMessageRow = {
  id: number;
  session_id: string;
  position: number;
  role: string;
  text: string;
  accent: number;
  artifact_json: string;
  created_at: string;
};

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
  changed_files_json,
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
  character_role_markdown,
  character_icon_path,
  character_theme_main,
  character_theme_sub,
  created_at,
  updated_at
`;

function rowToGroup(row: CompanionGroupRow): CompanionGroup {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: CompanionSessionRow): CompanionSession {
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
    changedFiles: parseChangedFiles(row.changed_files_json),
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
    characterRoleMarkdown: row.character_role_markdown,
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

function rowToMessage(row: CompanionMessageRow): Message {
  const artifact = (() => {
    if (!row.artifact_json.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(row.artifact_json) as Message["artifact"];
    } catch {
      return undefined;
    }
  })();
  return {
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.text,
    accent: row.accent === 1 ? true : undefined,
    artifact,
  };
}

function parseSelectedPaths(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseChangedFiles(value: string): CompanionChangedFileSummary[] {
  if (!value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item): CompanionChangedFileSummary[] => {
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
  } catch {
    return [];
  }
}

function sessionToSummary(session: CompanionSession): CompanionSessionSummary {
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
    updatedAt: session.updatedAt,
  };
}

function sessionToStoredMessages(session: CompanionSession): Message[] {
  return session.messages.map((message) => ({
    ...message,
    artifact: message.artifact ? JSON.parse(JSON.stringify(message.artifact)) as Message["artifact"] : undefined,
  }));
}

export class CompanionStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_groups (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS companion_sessions (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES companion_groups(id) ON DELETE CASCADE,
        task_title TEXT NOT NULL,
        status TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        focus_path TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        base_snapshot_ref TEXT NOT NULL DEFAULT '',
        base_snapshot_commit TEXT NOT NULL DEFAULT '',
        companion_branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        selected_paths_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        run_state TEXT NOT NULL DEFAULT 'idle',
        thread_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        catalog_revision INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION},
        model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL_ID}',
        reasoning_effort TEXT NOT NULL DEFAULT '${DEFAULT_REASONING_EFFORT}',
        custom_agent_name TEXT NOT NULL DEFAULT '',
        approval_mode TEXT NOT NULL DEFAULT '${DEFAULT_APPROVAL_MODE}',
        codex_sandbox_mode TEXT NOT NULL DEFAULT '${DEFAULT_CODEX_SANDBOX_MODE}',
        character_id TEXT NOT NULL,
        character_name TEXT NOT NULL,
        character_role_markdown TEXT NOT NULL DEFAULT '',
        character_icon_path TEXT NOT NULL,
        character_theme_main TEXT NOT NULL DEFAULT '#6f8cff',
        character_theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_companion_sessions_group_status
        ON companion_sessions(group_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS companion_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        accent INTEGER NOT NULL DEFAULT 0,
        artifact_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(session_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_companion_messages_session_position
        ON companion_messages(session_id, position);
    `);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(companion_sessions)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );

    if (!columns.has("base_snapshot_ref")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN base_snapshot_ref TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("base_snapshot_commit")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN base_snapshot_commit TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("run_state")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN run_state TEXT NOT NULL DEFAULT 'idle';");
    }
    if (!columns.has("selected_paths_json")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN selected_paths_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!columns.has("changed_files_json")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN changed_files_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!columns.has("thread_id")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';");
    }
    if (!columns.has("character_role_markdown")) {
      this.db.exec("ALTER TABLE companion_sessions ADD COLUMN character_role_markdown TEXT NOT NULL DEFAULT '';");
    }
  }

  ensureGroup(group: CompanionGroup): CompanionGroup {
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

  createSession(session: CompanionSession): CompanionSession {
    this.db.prepare(`
      INSERT INTO companion_sessions (
        ${COMPANION_SESSION_COLUMNS}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(session.changedFiles),
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
      session.characterRoleMarkdown,
      session.characterIconPath,
      session.characterThemeColors.main,
      session.characterThemeColors.sub,
      session.createdAt,
      session.updatedAt,
    );

    this.replaceMessages(session.id, session.messages, session.createdAt);

    return cloneCompanionSessions([session])[0] as CompanionSession;
  }

  listSessionSummaries(): CompanionSessionSummary[] {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      ORDER BY updated_at DESC, id DESC
    `).all() as CompanionSessionRow[];
    return cloneCompanionSessionSummaries(rows.map(rowToSession).map(sessionToSummary));
  }

  listActiveSessionSummaries(): CompanionSessionSummary[] {
    const rows = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      WHERE status = 'active'
      ORDER BY updated_at DESC, id DESC
    `).all() as CompanionSessionRow[];
    return cloneCompanionSessionSummaries(rows.map(rowToSession).map(sessionToSummary));
  }

  getSession(sessionId: string): CompanionSession | null {
    const row = this.db.prepare(`
      SELECT ${COMPANION_SESSION_COLUMNS}
      FROM companion_sessions
      WHERE id = ?
    `).get(sessionId) as CompanionSessionRow | undefined;
    if (!row) {
      return null;
    }

    const session = rowToSession(row);
    session.messages = this.listMessages(session.id);
    return cloneCompanionSessions([session])[0] ?? null;
  }

  updateSession(session: CompanionSession): CompanionSession {
    this.db.prepare(`
      UPDATE companion_sessions SET
        task_title = ?,
        status = ?,
        selected_paths_json = ?,
        changed_files_json = ?,
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
        character_role_markdown = ?,
        character_icon_path = ?,
        character_theme_main = ?,
        character_theme_sub = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      session.taskTitle,
      session.status,
      JSON.stringify(session.selectedPaths),
      JSON.stringify(session.changedFiles),
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
      session.characterRoleMarkdown,
      session.characterIconPath,
      session.characterThemeColors.main,
      session.characterThemeColors.sub,
      session.updatedAt,
      session.id,
    );
    this.replaceMessages(session.id, sessionToStoredMessages(session), session.updatedAt);
    return this.getSession(session.id) ?? cloneCompanionSessions([session])[0] as CompanionSession;
  }

  private listMessages(sessionId: string): Message[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, position, role, text, accent, artifact_json, created_at
      FROM companion_messages
      WHERE session_id = ?
      ORDER BY position ASC
    `).all(sessionId) as CompanionMessageRow[];
    return rows.map(rowToMessage);
  }

  private replaceMessages(sessionId: string, messages: Message[], createdAt: string): void {
    this.db.prepare("DELETE FROM companion_messages WHERE session_id = ?").run(sessionId);
    const statement = this.db.prepare(`
      INSERT INTO companion_messages (session_id, position, role, text, accent, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    messages.forEach((message, index) => {
      statement.run(
        sessionId,
        index,
        message.role,
        message.text,
        message.accent ? 1 : 0,
        message.artifact ? JSON.stringify(message.artifact) : "",
        createdAt,
      );
    });
  }

  clearCompanions(): void {
    this.db.exec("DELETE FROM companion_sessions; DELETE FROM companion_groups;");
  }

  close(): void {
    this.db.close();
  }
}
