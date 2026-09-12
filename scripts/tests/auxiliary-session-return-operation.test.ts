import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAuxiliarySessionReturnToMainUiState,
  beginAuxiliarySessionReturnToMainOperation,
  createAuxiliarySessionReturnBeforeCloseHandler,
  createAuxiliarySessionReturnToMainErrorHandler,
  createAuxiliarySessionReturnToMainOperationAppliers,
  createAuxiliarySessionReturnToMainUiStateApplier,
  applyReturnedAuxiliaryClosedSession,
  createReturnedAuxiliaryClosedSessionApplier,
  finishAuxiliarySessionReturnToMainOperation,
  resolveAuxiliarySessionReturnToMainErrorMessage,
  resolveAuxiliarySessionReturnToMainPreflight,
  runAuxiliarySessionReturnToMainOperation,
  runAuxiliarySessionReturnToMainOperationWithApi,
  runGuardedAuxiliarySessionReturnToMainOperationWithApi,
} from "../../src/auxiliary-session-return-operation.js";
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
  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main UI state は active session を閉じて main caret を draft 長に丸める"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "return-to-main UI stateのactive session、main caret、draft が期待値と異なる"
  // observable = "return-to-main UI stateのactive session、main caret、draft"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main UI state は active session を閉じて main caret を draft 長に丸める", () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const mutationRevision = { current: 2 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    const events: string[] = [];
    let activeSession: AuxiliarySession | null = active;
    let composerCaret = 0;
    let actionDockExpanded = true;
    let forceBlockedFeedback = true;

    applyAuxiliarySessionReturnToMainUiState({
      mutationRevision,
      activeSessionRef,
      setActiveSession: (session) => {
        activeSession = session;
        events.push("active");
      },
      mainDraft: "hello",
      mainCaret: 99,
      setComposerCaret: (caret) => {
        composerCaret = caret;
        events.push(`caret:${caret}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        actionDockExpanded = expanded;
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        forceBlockedFeedback = forced;
        events.push(`feedback:${forced}`);
      },
    });

    assert.equal(mutationRevision.current, 3);
    assert.equal(activeSessionRef.current, null);
    assert.equal(activeSession, null);
    assert.equal(composerCaret, 5);
    assert.equal(actionDockExpanded, false);
    assert.equal(forceBlockedFeedback, false);
    assert.deepEqual(events, ["active", "caret:5", "dock:false", "feedback:false"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main UI state applier は callback として main UI state を反映する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "return-to-main UI stateのactive session、main caret、draft が期待値と異なる"
  // observable = "return-to-main UI stateのactive session、main caret、draft"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main UI state applier は callback として main UI state を反映する", () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    const events: string[] = [];
    const applyReturnedMainSession = createAuxiliarySessionReturnToMainUiStateApplier({
      mutationRevision,
      activeSessionRef,
      setActiveSession: () => {
        events.push("active");
      },
      mainDraft: "hello",
      mainCaret: 10,
      setComposerCaret: (caret) => {
        events.push(`caret:${caret}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
    });

    applyReturnedMainSession();

    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, null);
    assert.deepEqual(events, ["active", "caret:5", "dock:false", "feedback:false"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main beforeClose handler は load revision を進める"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "beforeClose時のload revision更新 が期待値と異なる"
  // observable = "beforeClose時のload revision更新"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main beforeClose handler は load revision を進める", () => {
    const loadRevision = { current: 3 };
    const beforeClose = createAuxiliarySessionReturnBeforeCloseHandler({
      loadRevision,
    });

    beforeClose();

    assert.equal(loadRevision.current, 4);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main operation appliers は beforeClose / closed list / main UI state を組み立てる"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "return-to-main UI stateのactive session、main caret、draft が期待値と異なる"
  // observable = "return-to-main UI stateのactive session、main caret、draft"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main operation appliers は beforeClose / closed list / main UI state を組み立てる", () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const returned = makeAuxiliarySession({ id: "aux-returned", status: "closed" });
    const loadRevision = { current: 3 };
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    let closedSessions = [makeAuxiliarySession({ id: "aux-existing" })];
    let activeSession: AuxiliarySession | null = active;
    let composerCaret = 0;
    let actionDockExpanded = true;
    let forceBlockedFeedback = true;

    const appliers = createAuxiliarySessionReturnToMainOperationAppliers({
      loadRevision,
      setClosedSessions: (updater) => {
        closedSessions = updater(closedSessions);
      },
      mutationRevision,
      activeSessionRef,
      setActiveSession: (session) => {
        activeSession = session;
      },
      mainDraft: "hello",
      mainCaret: 99,
      setComposerCaret: (caret) => {
        composerCaret = caret;
      },
      setActionDockPinnedExpanded: (expanded) => {
        actionDockExpanded = expanded;
      },
      setForceComposerBlockedFeedback: (forced) => {
        forceBlockedFeedback = forced;
      },
    });

    appliers.beforeClose();
    appliers.applyClosedSession(returned);
    appliers.applyReturnedMainSession();

    assert.equal(loadRevision.current, 4);
    assert.deepEqual(closedSessions.map((session) => session.id), ["aux-existing", "aux-returned"]);
    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, null);
    assert.equal(activeSession, null);
    assert.equal(composerCaret, 5);
    assert.equal(actionDockExpanded, false);
    assert.equal(forceBlockedFeedback, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main begin は pending を true にする"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "pending true callback が期待値と異なる"
  // observable = "pending true callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main begin は pending を true にする", () => {
    const pendingValues: boolean[] = [];

    beginAuxiliarySessionReturnToMainOperation({
      setActionPending: (pending) => {
        pendingValues.push(pending);
      },
    });

    assert.deepEqual(pendingValues, [true]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main cleanup は pending を false に戻す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "pending false callback が期待値と異なる"
  // observable = "pending false callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main cleanup は pending を false に戻す", () => {
    const pendingValues: boolean[] = [];

    finishAuxiliarySessionReturnToMainOperation({
      setActionPending: (pending) => {
        pendingValues.push(pending);
      },
    });

    assert.deepEqual(pendingValues, [false]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main preflight は API / active session / pending を判定する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "API有無、active session、pendingから返るpreflight結果 が期待値と異なる"
  // observable = "API有無、active session、pendingから返るpreflight結果"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main preflight は API / active session / pending を判定する", () => {
    const api = { closeAuxiliarySession: async (sessionId: string) => makeAuxiliarySession({ id: sessionId }) };
    const activeSession = makeAuxiliarySession();

    assert.deepEqual(
      resolveAuxiliarySessionReturnToMainPreflight({
        api: null,
        activeSession,
        isActionPending: false,
      }),
      { status: "blocked" },
    );
    assert.deepEqual(
      resolveAuxiliarySessionReturnToMainPreflight({
        api,
        activeSession: null,
        isActionPending: false,
      }),
      { status: "blocked" },
    );
    assert.deepEqual(
      resolveAuxiliarySessionReturnToMainPreflight({
        api,
        activeSession,
        isActionPending: true,
      }),
      { status: "blocked" },
    );
    assert.deepEqual(
      resolveAuxiliarySessionReturnToMainPreflight({
        api,
        activeSession,
        isActionPending: false,
      }),
      { status: "ready", api, activeSession },
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "closed session 反映は重複を避けて末尾に置く"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "重複除去後のclosed session list が期待値と異なる"
  // observable = "重複除去後のclosed session list"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("closed session 反映は重複を避けて末尾に置く", () => {
    const existing = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const closed = makeAuxiliarySession({ id: "closed-2", status: "closed" });

    assert.deepEqual(
      applyReturnedAuxiliaryClosedSession([existing], closed),
      [existing, closed],
    );
    assert.deepEqual(
      applyReturnedAuxiliaryClosedSession([existing], existing),
      [existing],
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "closed session applier は setter callback 経由で closed list を更新する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "重複除去後のclosed session list が期待値と異なる"
  // observable = "重複除去後のclosed session list"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("closed session applier は setter callback 経由で closed list を更新する", () => {
    const existing = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const closed = makeAuxiliarySession({ id: "closed-2", status: "closed" });
    const appliedSessions: AuxiliarySession[][] = [];
    const applyClosedSession = createReturnedAuxiliaryClosedSessionApplier({
      setClosedSessions: (updater) => {
        appliedSessions.push(updater([existing]));
      },
    });

    applyClosedSession(closed);

    assert.deepEqual(appliedSessions, [[existing, closed]]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "active session がない場合は close せず null を返す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "close API未呼出とnull結果 が期待値と異なる"
  // observable = "close API未呼出とnull結果"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "beforeClose、close、closed反映、main反映の順に実行する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "beforeClose、close、closed反映、main反映のcallback実行順 が期待値と異なる"
  // observable = "beforeClose、close、closed反映、main反映のcallback実行順"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "API adapter 経由でも beforeClose、close、closed反映、main反映の順に実行する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "beforeClose、close、closed反映、main反映のcallback実行順 が期待値と異なる"
  // observable = "beforeClose、close、closed反映、main反映のcallback実行順"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("API adapter 経由でも beforeClose、close、closed反映、main反映の順に実行する", async () => {
    const active = makeAuxiliarySession({ id: "aux-1" });
    const closed = makeAuxiliarySession({ id: "aux-1", status: "closed" });
    const events: string[] = [];

    assert.equal(
      await runAuxiliarySessionReturnToMainOperationWithApi({
        activeSession: active,
        beforeClose: () => {
          events.push("before");
        },
        api: {
          closeAuxiliarySession: async (sessionId) => {
            events.push(`close:${sessionId}`);
            return closed;
          },
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

  // @test-value v2
  // kind = "contract"
  // claim = "API adapter 経由でも active session がない場合は close せず null を返す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "close API未呼出とnull結果 が期待値と異なる"
  // observable = "close API未呼出とnull結果"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("API adapter 経由でも active session がない場合は close せず null を返す", async () => {
    let closed = false;

    assert.equal(
      await runAuxiliarySessionReturnToMainOperationWithApi({
        activeSession: null,
        api: {
          closeAuxiliarySession: async (sessionId) => {
            closed = true;
            return makeAuxiliarySession({ id: sessionId });
          },
        },
        applyClosedSession: () => undefined,
        applyReturnedMainSession: () => undefined,
      }),
      null,
    );
    assert.equal(closed, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "API adapter 経由でも close が失敗した場合は closed/main 反映を実行せず例外を伝播する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "API adapter経由のclose結果と各反映callback実行順 が期待値と異なる"
  // observable = "API adapter経由のclose結果と各反映callback実行順"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("API adapter 経由でも close が失敗した場合は closed/main 反映を実行せず例外を伝播する", async () => {
    const error = new Error("close failed");
    const events: string[] = [];

    await assert.rejects(
      runAuxiliarySessionReturnToMainOperationWithApi({
        activeSession: makeAuxiliarySession(),
        beforeClose: () => {
          events.push("before");
        },
        api: {
          closeAuxiliarySession: async () => {
            events.push("close");
            throw error;
          },
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

  // @test-value v2
  // kind = "contract"
  // claim = "guarded API operation は preflight blocked なら pending を変更せず close しない"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "API有無、active session、pendingから返るpreflight結果 が期待値と異なる"
  // observable = "API有無、active session、pendingから返るpreflight結果"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("guarded API operation は preflight blocked なら pending を変更せず close しない", async () => {
    const events: string[] = [];

    assert.equal(
      await runGuardedAuxiliarySessionReturnToMainOperationWithApi({
        api: {
          closeAuxiliarySession: async () => {
            events.push("close");
            return makeAuxiliarySession();
          },
        },
        activeSession: makeAuxiliarySession(),
        isActionPending: true,
        setActionPending: (pending) => {
          events.push(`pending:${pending}`);
        },
        alertError: (message) => {
          events.push(`error:${message}`);
        },
        loadRevision: { current: 0 },
        setClosedSessions: () => {
          events.push("closed");
        },
        mutationRevision: { current: 0 },
        activeSessionRef: { current: makeAuxiliarySession() },
        setActiveSession: () => {
          events.push("active");
        },
        mainDraft: "",
        mainCaret: 0,
        setComposerCaret: () => {
          events.push("caret");
        },
        setActionDockPinnedExpanded: () => {
          events.push("dock");
        },
        setForceComposerBlockedFeedback: () => {
          events.push("feedback");
        },
      }),
      null,
    );
    assert.deepEqual(events, []);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "guarded API operation は preflight、pending、close、appliers、cleanup を一連で実行する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "pending false callback が期待値と異なる"
  // observable = "pending false callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("guarded API operation は preflight、pending、close、appliers、cleanup を一連で実行する", async () => {
    const active = makeAuxiliarySession({ id: "aux-active" });
    const closed = makeAuxiliarySession({ id: "aux-active", status: "closed" });
    const loadRevision = { current: 3 };
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: active as AuxiliarySession | null };
    const events: string[] = [];
    let closedSessions: AuxiliarySession[] = [];

    assert.equal(
      await runGuardedAuxiliarySessionReturnToMainOperationWithApi({
        api: {
          closeAuxiliarySession: async (sessionId) => {
            events.push(`close:${sessionId}`);
            return closed;
          },
        },
        activeSession: active,
        isActionPending: false,
        setActionPending: (pending) => {
          events.push(`pending:${pending}`);
        },
        alertError: (message) => {
          events.push(`error:${message}`);
        },
        loadRevision,
        setClosedSessions: (updater) => {
          closedSessions = updater(closedSessions);
          events.push(`closed:${closedSessions.length}`);
        },
        mutationRevision,
        activeSessionRef,
        setActiveSession: (session) => {
          events.push(`active:${session?.id ?? "none"}`);
        },
        mainDraft: "hello",
        mainCaret: 99,
        setComposerCaret: (caret) => {
          events.push(`caret:${caret}`);
        },
        setActionDockPinnedExpanded: (expanded) => {
          events.push(`dock:${expanded}`);
        },
        setForceComposerBlockedFeedback: (forced) => {
          events.push(`feedback:${forced}`);
        },
      }),
      closed,
    );

    assert.equal(loadRevision.current, 4);
    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, null);
    assert.deepEqual(closedSessions, [closed]);
    assert.deepEqual(events, [
      "pending:true",
      "close:aux-active",
      "closed:1",
      "active:none",
      "caret:5",
      "dock:false",
      "feedback:false",
      "pending:false",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "guarded API operation は close failure を alert に渡して cleanup する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "pending false callback が期待値と異なる"
  // observable = "pending false callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("guarded API operation は close failure を alert に渡して cleanup する", async () => {
    const error = new Error("close failed");
    const events: string[] = [];

    assert.equal(
      await runGuardedAuxiliarySessionReturnToMainOperationWithApi({
        api: {
          closeAuxiliarySession: async () => {
            events.push("close");
            throw error;
          },
        },
        activeSession: makeAuxiliarySession(),
        isActionPending: false,
        setActionPending: (pending) => {
          events.push(`pending:${pending}`);
        },
        alertError: (message) => {
          events.push(`error:${message}`);
        },
        loadRevision: { current: 0 },
        setClosedSessions: () => {
          events.push("closed");
        },
        mutationRevision: { current: 0 },
        activeSessionRef: { current: makeAuxiliarySession() },
        setActiveSession: () => {
          events.push("active");
        },
        mainDraft: "",
        mainCaret: 0,
        setComposerCaret: () => {
          events.push("caret");
        },
        setActionDockPinnedExpanded: () => {
          events.push("dock");
        },
        setForceComposerBlockedFeedback: () => {
          events.push("feedback");
        },
      }),
      null,
    );
    assert.deepEqual(events, ["pending:true", "close", "error:close failed", "pending:false"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "close が失敗した場合は closed/main 反映を実行せず例外を伝播する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "close が失敗した場合は closed/main 反映を実行せず例外を伝播する のassertionが読む戻り値、状態、またはcallback記録 が期待値と異なる"
  // observable = "close が失敗した場合は closed/main 反映を実行せず例外を伝播する のassertionが読む戻り値、状態、またはcallback記録"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main failure message は Error message を優先し、非 Error は fallback を返す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "Error/non-Error入力から生成されたfailure message が期待値と異なる"
  // observable = "Error/non-Error入力から生成されたfailure message"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main failure message は Error message を優先し、非 Error は fallback を返す", () => {
    assert.equal(resolveAuxiliarySessionReturnToMainErrorMessage(new Error("close failed")), "close failed");
    assert.equal(
      resolveAuxiliarySessionReturnToMainErrorMessage("close failed"),
      "Auxiliary Session の終了に失敗したよ。",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "return-to-main error handler は解決済み message を alert に渡す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-return-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "alertへ渡された解決済みerror message が期待値と異なる"
  // observable = "alertへ渡された解決済みerror message"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-return-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("return-to-main error handler は解決済み message を alert に渡す", () => {
    const messages: string[] = [];
    const handleError = createAuxiliarySessionReturnToMainErrorHandler({
      alertError: (message) => {
        messages.push(message);
      },
    });

    handleError(new Error("close failed"));
    handleError("close failed");

    assert.deepEqual(messages, [
      "close failed",
      "Auxiliary Session の終了に失敗したよ。",
    ]);
  });
});
