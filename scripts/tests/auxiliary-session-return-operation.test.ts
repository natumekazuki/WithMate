import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAuxiliarySessionReturnToMainOperation } from "../../src/auxiliary-session-return-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
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
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

describe("runAuxiliarySessionReturnToMainOperation", () => {
  it("active session がない場合は close せず null を返す", async () => {
    let closed = false;

    assert.equal(
      await runAuxiliarySessionReturnToMainOperation({
        activeSession: null,
        closeAuxiliarySession: async (sessionId) => {
          closed = true;
          return makeAuxiliarySession({ id: sessionId });
        },
        applyClosedSession: () => undefined,
        applyReturnedMainSession: () => undefined,
      }),
      null,
    );
    assert.equal(closed, false);
  });

  it("beforeClose、close、closed反映、main反映の順に実行する", async () => {
    const active = makeAuxiliarySession({ id: "aux-1" });
    const closed = makeAuxiliarySession({ id: "aux-1", status: "closed" });
    const events: string[] = [];

    assert.equal(
      await runAuxiliarySessionReturnToMainOperation({
        activeSession: active,
        beforeClose: () => {
          events.push("before");
        },
        closeAuxiliarySession: async (sessionId) => {
          events.push(`close:${sessionId}`);
          return closed;
        },
        applyClosedSession: (session) => {
          events.push(`closed:${session.status}`);
        },
        applyReturnedMainSession: () => {
          events.push("main");
        },
      }),
      closed,
    );
    assert.deepEqual(events, ["before", "close:aux-1", "closed:closed", "main"]);
  });

  it("close が失敗した場合は closed/main 反映を実行せず例外を伝播する", async () => {
    const error = new Error("close failed");
    const events: string[] = [];

    await assert.rejects(
      runAuxiliarySessionReturnToMainOperation({
        activeSession: makeAuxiliarySession(),
        beforeClose: () => {
          events.push("before");
        },
        closeAuxiliarySession: async () => {
          events.push("close");
          throw error;
        },
        applyClosedSession: () => {
          events.push("closed");
        },
        applyReturnedMainSession: () => {
          events.push("main");
        },
      }),
      error,
    );
    assert.deepEqual(events, ["before", "close"]);
  });
});
