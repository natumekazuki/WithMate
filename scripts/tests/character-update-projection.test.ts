import assert from "node:assert/strict";
import test from "node:test";

import type { AuditLogEntry, LiveSessionRunState, Session } from "../../src/app-state.js";
import {
  buildCharacterUpdateLatestCommandView,
  selectLatestCharacterUpdateSession,
  selectLatestMainAuditCommandOperation,
} from "../../src/character-update-projection.js";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "session-1",
    taskTitle: "更新",
    taskSummary: "",
    status: "idle",
    updatedAt: "2026/03/29 12:00",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "char",
    workspacePath: "C:/characters/char-1",
    branch: "main",
    sessionKind: "character-update",
    characterId: "char-1",
    character: "Muse",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    runState: "idle",
    approvalMode: "suggest",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    messages: [],
    stream: [],
    ...overrides,
  };
}

function makeAuditLog(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 1,
    sessionId: "session-1",
    createdAt: "2026/03/29 12:00",
    phase: "completed",
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "suggest",
    threadId: "",
    logicalPrompt: {
      systemText: "",
      inputText: "",
      composedText: "",
    },
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
    ...overrides,
  };
}

test("selectLatestCharacterUpdateSession は running 中の update session を優先する", () => {
  const sessions = [
    makeSession({ id: "saved", status: "saved", updatedAt: "2026/03/29 12:05" }),
    makeSession({ id: "idle", status: "idle", updatedAt: "2026/03/29 12:10" }),
    makeSession({ id: "running", status: "running", updatedAt: "2026/03/29 12:01" }),
    makeSession({ id: "other-branch", branch: "main", sessionKind: "default", status: "running", updatedAt: "2026/03/29 12:20" }),
  ];

  assert.equal(selectLatestCharacterUpdateSession(sessions, "char-1")?.id, "running");
});

test("selectLatestCharacterUpdateSession は running がなければ updatedAt の新しい session を返す", () => {
  const sessions = [
    makeSession({ id: "older", updatedAt: "2026/03/29 10:00" }),
    makeSession({ id: "newer", updatedAt: "2026/03/29 11:00" }),
  ];

  assert.equal(selectLatestCharacterUpdateSession(sessions, "char-1")?.id, "newer");
});

test("selectLatestMainAuditCommandOperation は background を除いた command_execution を返す", () => {
  const auditLogs = [
    makeAuditLog({
      id: 3,
      phase: "background-completed",
      operations: [{ type: "command_execution", summary: "bg", details: "" }],
    }),
    makeAuditLog({
      id: 2,
      phase: "completed",
      operations: [{ type: "write_file", summary: "noop", details: "" }],
    }),
    makeAuditLog({
      id: 1,
      phase: "failed",
      operations: [{ type: "command_execution", summary: "npm test", details: "failed" }],
    }),
  ];

  const latest = selectLatestMainAuditCommandOperation(auditLogs);

  assert.equal(latest.operation?.summary, "npm test");
  assert.equal(latest.phase, "failed");
});

test("buildCharacterUpdateLatestCommandView は live run を audit より優先する", () => {
  const liveRun: LiveSessionRunState = {
    sessionId: "session-1",
    threadId: "thread-1",
    assistantText: "",
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    steps: [
      {
        id: "step-1",
        type: "command_execution",
        summary: "pnpm test",
        details: "running",
        status: "in_progress",
      },
    ],
  };
  const auditLogs = [
    makeAuditLog({
      operations: [{ type: "command_execution", summary: "npm test", details: "done" }],
    }),
  ];

  const view = buildCharacterUpdateLatestCommandView({ liveRun, auditLogs });

  assert.equal(view?.summary, "pnpm test");
  assert.equal(view?.sourceLabel, "live");
});
