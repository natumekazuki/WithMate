import assert from "node:assert/strict";
import test from "node:test";

import { finishAuxiliarySessionStartClosedLoadWithApi } from "../../src/auxiliary-session-start-operation.js";
import type { AuxiliarySession, AuxiliarySessionSummary } from "../../src/auxiliary-session-state.js";

const closedSession: AuxiliarySession = {
  id: "closed-auxiliary",
  parentSessionId: "companion-parent",
  status: "closed",
  runState: "idle",
  title: "Closed Auxiliary",
  provider: "copilot",
  catalogRevision: 1,
  model: "model",
  reasoningEffort: "medium",
  approvalMode: "never",
  codexSandboxMode: "workspace-write",
  codexSpeed: "fast",
  codexReviewer: "none",
  customAgentName: "",
  allowedAdditionalDirectories: [],
  threadId: "closed-thread",
  composerDraft: "",
  messages: [{ role: "assistant", text: "closed" }],
  displayAfterMessageIndex: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  closedAt: "2026-01-02T00:00:00.000Z",
};

const closedSummary: AuxiliarySessionSummary = { ...closedSession };

// @test-value v2
// kind = "invariant"
// claim = "Companion Auxiliary start後のclosed履歴loadはsessionが切り替わった場合に結果を反映しない"
// oracle = { type = "contract", ref = "issue-710 concurrent Auxiliary load ownership" }
// fault = "画面切替後の遅延closed loadが新しいCompanion画面へ旧Auxiliary履歴を混入させる"
// observable = "finishAuxiliarySessionStartClosedLoadWithApiのclosed更新とpending状態"
// observation_boundary = "public-boundary"
// scope = "companion-auxiliary-closed-load"
// lifecycle = "permanent"
// @end-test-value
test("Companion Auxiliary start は closed 履歴ロードを無効化した revision で再ロードする", async () => {
  let active = true;
  const events: string[] = [];
  const appliedSessions: AuxiliarySession[][] = [];

  finishAuxiliarySessionStartClosedLoadWithApi({
    parentSessionId: closedSession.parentSessionId,
    api: {
      listAuxiliarySessions: async (parentSessionId) => {
        events.push(`list:${parentSessionId}`);
        return [closedSummary];
      },
      getAuxiliarySession: async (sessionId) => {
        events.push(`get:${sessionId}`);
        active = false;
        return closedSession;
      },
    },
    isActive: () => active,
    setClosedSessions: (sessions) => {
      events.push("closed");
      appliedSessions.push(sessions);
    },
    setActionPending: (pending) => {
      events.push(`pending:${pending}`);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, [
    "list:companion-parent",
    "pending:false",
    "get:closed-auxiliary",
  ]);
  assert.deepEqual(appliedSessions, []);
});
