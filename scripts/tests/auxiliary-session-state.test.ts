import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAuxiliarySessionPatch,
  resolveEditableActiveAuxiliarySession,
  type AuxiliarySession,
} from "../../src/auxiliary-session-state.js";

function createAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

test("applyAuxiliarySessionPatch は指定 field と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession();

  assert.deepEqual(
    applyAuxiliarySessionPatch(
      session,
      {
        approvalMode: "on-request",
        codexSandboxMode: "read-only",
      },
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("resolveEditableActiveAuxiliarySession は保存対象の active session を返す", () => {
  const activeSession = createAuxiliarySession();
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: null,
    }),
    activeSession,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession,
    }),
    currentSession,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
    }),
    null,
  );
  assert.equal(
    resolveEditableActiveAuxiliarySession({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
    }),
    null,
  );
});
