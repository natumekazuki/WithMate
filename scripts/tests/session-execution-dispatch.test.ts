import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, type Session } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { runSessionExecutionDispatch } from "../../src-electron/session-execution-dispatch.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      taskTitle: "Dispatch",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-1",
      character: "Character",
      characterIconPath: "",
      characterThemeColors: { main: "#000000", sub: "#111111" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

describe("runSessionExecutionDispatch", () => {
  it("EXT-TERMINAL-05: Session completion commit後のcancel競合はexecutionもcompletedへ収束する", async () => {
    const session = createSession({
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "completed" },
      ],
    });

    const outcome = await runSessionExecutionDispatch({
      runTurn: async () => ({ session, terminalState: "completed" }),
      isCanceled: () => true,
    });

    assert.deepEqual(outcome, { state: "completed", result: { assistantText: "completed" } });
  });

  it("EXT-TERMINAL-CANCEL-07: runtimeが確定したcancel終端をexecutionへ投影する", async () => {
    const session = createSession({
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "キャンセルしたよ。" },
      ],
    });

    const outcome = await runSessionExecutionDispatch({
      runTurn: async () => ({ session, terminalState: "canceled" }),
      isCanceled: () => false,
    });

    assert.deepEqual(outcome, { state: "canceled", result: null, reason: "user_requested" });
  });

  it("EXT-TERMINAL-05: completion前にabortされたfailureだけをcanceledへ収束する", async () => {
    const outcome = await runSessionExecutionDispatch({
      runTurn: async () => { throw new Error("aborted"); },
      isCanceled: () => true,
    });

    assert.deepEqual(outcome, { state: "canceled", result: null, reason: "user_requested" });
  });

  it("EXT-ERROR-06: provider terminal failureはstable PROVIDER_FAILUREを返す", async () => {
    const outcome = await runSessionExecutionDispatch({
      runTurn: async () => ({
        session: createSession({ runState: "error" }),
        terminalState: "failed",
      }),
      isCanceled: () => false,
    });

    assert.deepEqual(outcome, {
      state: "failed",
      result: null,
      errorCode: "PROVIDER_FAILURE",
      reason: "provider_turn_failed",
    });
  });
});
