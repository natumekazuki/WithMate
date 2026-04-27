import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { CREATE_V2_SCHEMA_SQL } from "../../src-electron/database-schema-v2.js";
import { SessionStorageV2Read } from "../../src-electron/session-storage-v2-read.js";

type V2SessionHeaderInput = {
  id?: string;
  taskTitle?: string;
  allowedAdditionalDirectoriesJson?: string;
  messageCount?: number;
};

async function withTempV2Database<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "withmate-session-v2-read-"));
  const dbPath = path.join(dir, "withmate-v2.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    for (const statement of CREATE_V2_SCHEMA_SQL) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }

  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function insertSessionHeader(db: DatabaseSync, input: V2SessionHeaderInput = {}): string {
  const id = input.id ?? "session-1";
  db.prepare(`
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
  `).run(
    id,
    input.taskTitle ?? "Runtime task",
    "Runtime summary",
    "idle",
    "2026-04-27T00:00:00.000Z",
    "codex",
    1,
    "workspace-a",
    "workspace-a",
    "main",
    "default",
    "char-a",
    "A",
    "",
    "#6f8cff",
    "#6fb8c7",
    "idle",
    "never",
    "workspace-write",
    "gpt-5.4-mini",
    "medium",
    "",
    input.allowedAdditionalDirectoriesJson ?? JSON.stringify(["shared/reference"]),
    "thread-1",
    input.messageCount ?? 0,
    0,
    1,
  );
  return id;
}

function insertMessage(db: DatabaseSync, input: {
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  accent?: number;
  artifactAvailable?: number;
}): number {
  const result = db.prepare(`
    INSERT INTO session_messages (
      session_id,
      seq,
      role,
      text,
      accent,
      artifact_available,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.seq,
    input.role,
    input.text,
    input.accent ?? 0,
    input.artifactAvailable ?? 0,
    "2026-04-27T00:00:00.000Z",
  );
  return Number(result.lastInsertRowid);
}

function insertArtifact(db: DatabaseSync, messageId: number, artifact: object): void {
  db.prepare("INSERT INTO session_message_artifacts (message_id, artifact_json) VALUES (?, ?)").run(
    messageId,
    JSON.stringify(artifact),
  );
}

describe("SessionStorageV2Read", () => {
  it("listSessionSummaries は V2 sessions header から summary を復元する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-summary",
          taskTitle: "Task title",
          allowedAdditionalDirectoriesJson: JSON.stringify(["shared/reference"]),
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2Read(dbPath);
      try {
        const summaries = storage.listSessionSummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].id, "session-summary");
        assert.equal(summaries[0].taskTitle, "Task title");
        assert.deepEqual(summaries[0].allowedAdditionalDirectories, ["shared/reference"]);
        assert.equal(summaries[0].workspacePath, "workspace-a");
      } finally {
        storage.close();
      }
    });
  });

  it("getSession は messages を seq 順で復元し artifact と stream: [] を返す", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const sessionId = insertSessionHeader(db, {
          id: "session-with-messages",
          messageCount: 2,
        });
        insertMessage(db, {
          sessionId,
          seq: 2,
          role: "assistant",
          text: "second",
        });
        const userMessageId = insertMessage(db, {
          sessionId,
          seq: 0,
          role: "user",
          text: "first",
          accent: 1,
          artifactAvailable: 1,
        });
        insertArtifact(db, userMessageId, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2Read(dbPath);
      try {
        const session = storage.getSession("session-with-messages");
        assert.ok(session);
        assert.deepEqual(session.stream, []);
        assert.deepEqual(session.messages.map((message) => message.text), ["first", "second"]);
        assert.equal(session.messages[0].role, "user");
        assert.equal(session.messages[0].accent, true);
        assert.deepEqual(session.messages[0].artifact, {
          title: "Result artifact",
          activitySummary: ["done"],
          changedFiles: [],
          runChecks: [],
        });
        assert.equal(session.messages[1].role, "assistant");
        assert.equal(session.messages[1].artifact, undefined);
      } finally {
        storage.close();
      }
    });
  });

  it("getSession は存在しない id で null を返す", async () => {
    await withTempV2Database((dbPath) => {
      const storage = new SessionStorageV2Read(dbPath);
      try {
        assert.equal(storage.getSession("missing-session-id"), null);
      } finally {
        storage.close();
      }
    });
  });

  it("壊れた allowed_additional_directories_json は summary で skip し detail で throw する", async () => {
    await withTempV2Database((dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        insertSessionHeader(db, {
          id: "session-valid",
          taskTitle: "Good session",
          allowedAdditionalDirectoriesJson: JSON.stringify(["shared/valid"]),
        });
        insertSessionHeader(db, {
          id: "session-bad-directories",
          taskTitle: "Bad session",
          allowedAdditionalDirectoriesJson: "{invalid",
        });
      } finally {
        db.close();
      }

      const storage = new SessionStorageV2Read(dbPath);
      try {
        assert.deepEqual(storage.listSessionSummaries().map((session) => session.id), ["session-valid"]);
        assert.throws(() => {
          storage.getSession("session-bad-directories");
        });
      } finally {
        storage.close();
      }
    });
  });
});
