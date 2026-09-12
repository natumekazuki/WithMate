import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAuxiliarySessionStartError,
  applyAuxiliarySessionStartResult,
  beginAuxiliarySessionStartOperation,
  createActiveAuxiliarySessionStartResultApplier,
  createAuxiliarySessionStartErrorHandler,
  createAuxiliarySessionStartResultApplier,
  finishAuxiliarySessionStartClosedLoad,
  finishAuxiliarySessionStartClosedLoadWithApi,
  runAuxiliarySessionStartOperation,
  runSessionWindowAuxiliarySessionStartOperation,
} from "../../src/auxiliary-session-start-operation.js";
import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src/auxiliary-session-state.js";

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

describe("runAuxiliarySessionStartOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "create request を組み立て、作成済み session を active へ反映する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "createAuxiliarySessionへのprovider/model/runtime option等の入力とapplyStartedSessionへ渡す作成済みsession が期待値と異なる"
  // observable = "createAuxiliarySessionへのprovider/model/runtime option等の入力とapplyStartedSessionへ渡す作成済みsession"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("create request を組み立て、作成済み session を active へ反映する", async () => {
    const requests: CreateAuxiliarySessionInput[] = [];
    const session = makeAuxiliarySession({
      parentSessionId: "parent-1",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      customAgentName: "reviewer",
    });
    const applied: AuxiliarySession[] = [];

    assert.equal(
      await runAuxiliarySessionStartOperation({
        parentSessionId: "parent-1",
        provider: "codex",
        defaults: {
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
          approvalMode: "never",
          codexSandboxMode: "read-only",
          customAgentName: "reviewer",
        },
        createAuxiliarySession: async (request) => {
          requests.push(request);
          return session;
        },
        applyStartedSession: (createdSession) => {
          applied.push(createdSession);
        },
      }),
      session,
    );
    assert.deepEqual(requests, [{
      parentSessionId: "parent-1",
      provider: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "read-only",
      customAgentName: "reviewer",
    }]);
    assert.deepEqual(applied, [session]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "defaults が null の場合は provider と parentSessionId だけで作成する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "defaults=null時のcreateAuxiliarySession入力（providerとparentSessionId） が期待値と異なる"
  // observable = "defaults=null時のcreateAuxiliarySession入力（providerとparentSessionId）"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("defaults が null の場合は provider と parentSessionId だけで作成する", async () => {
    const requests: CreateAuxiliarySessionInput[] = [];
    const session = makeAuxiliarySession();

    await runAuxiliarySessionStartOperation({
      parentSessionId: "parent-1",
      provider: "copilot",
      defaults: null,
      createAuxiliarySession: async (request) => {
        requests.push(request);
        return session;
      },
      applyStartedSession: () => undefined,
    });

    assert.deepEqual(requests, [{
      parentSessionId: "parent-1",
      provider: "copilot",
      model: undefined,
      reasoningEffort: undefined,
      approvalMode: undefined,
      codexSandboxMode: undefined,
      customAgentName: undefined,
    }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "作成に失敗した場合は active 反映せず例外を伝播する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "createAuxiliarySessionのreject結果とactive session更新callbackの未呼出 が期待値と異なる"
  // observable = "createAuxiliarySessionのreject結果とactive session更新callbackの未呼出"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("作成に失敗した場合は active 反映せず例外を伝播する", async () => {
    const error = new Error("create failed");
    let applied = false;

    await assert.rejects(
      runAuxiliarySessionStartOperation({
        parentSessionId: "parent-1",
        provider: "codex",
        createAuxiliarySession: async () => {
          throw error;
        },
        applyStartedSession: () => {
          applied = true;
        },
      }),
      error,
    );
    assert.equal(applied, false);
  });
});

describe("runSessionWindowAuxiliarySessionStartOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "最新 Session 選択を Main に委譲して Auxiliary Session を作成する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "selectLatestSessionの選択結果とcreateAuxiliarySessionのparentSessionId が期待値と異なる"
  // observable = "selectLatestSessionの選択結果とcreateAuxiliarySessionのparentSessionId"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("最新 Session 選択を Main に委譲して Auxiliary Session を作成する", async () => {
    const requests: CreateAuxiliarySessionInput[] = [];
    const session = makeAuxiliarySession();

    await runSessionWindowAuxiliarySessionStartOperation({
      parentSessionId: "parent-1",
      provider: "codex",
      createAuxiliarySession: async (request) => {
        requests.push(request);
        return session;
      },
      applyStartedSession: () => undefined,
    });

    assert.deepEqual(requests, [{
      parentSessionId: "parent-1",
      provider: "codex",
      runtimeSelection: "latest-session",
    }]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Main の選択・作成失敗時は active 反映せず例外を伝播する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "Main選択/create失敗時のactive session更新callback が期待値と異なる"
  // observable = "Main選択/create失敗時のactive session更新callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("Main の選択・作成失敗時は active 反映せず例外を伝播する", async () => {
    const error = new Error("latest selection read failed");
    let applied = false;

    await assert.rejects(
      runSessionWindowAuxiliarySessionStartOperation({
        parentSessionId: "parent-1",
        provider: "codex",
        createAuxiliarySession: async () => {
          throw error;
        },
        applyStartedSession: () => {
          applied = true;
        },
      }),
      error,
    );

    assert.equal(applied, false);
  });
});

describe("beginAuxiliarySessionStartOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "feedback reset、load revision increment、pending true の順に反映して revision を返す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "feedback reset、load revision、pending callbackの記録順と返却revision が期待値と異なる"
  // observable = "feedback reset、load revision、pending callbackの記録順と返却revision"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("feedback reset、load revision increment、pending true の順に反映して revision を返す", () => {
    const loadRevision = { current: 4 };
    const events: string[] = [];

    assert.equal(
      beginAuxiliarySessionStartOperation({
        loadRevision,
        resetLaunchFeedback: () => {
          events.push("reset");
        },
        setActionPending: (pending) => {
          events.push(`pending:${pending}`);
        },
      }),
      5,
    );
    assert.equal(loadRevision.current, 5);
    assert.deepEqual(events, ["reset", "pending:true"]);
  });
});

describe("applyAuxiliarySessionStartError", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "start error を launch error state に反映する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "setLaunchStartErrorへ渡されたerror値 が期待値と異なる"
  // observable = "setLaunchStartErrorへ渡されたerror値"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("start error を launch error state に反映する", () => {
    const error = new Error("start failed");
    const errors: unknown[] = [];

    applyAuxiliarySessionStartError({
      error,
      setLaunchStartError: (nextError) => {
        errors.push(nextError);
      },
    });

    assert.deepEqual(errors, [error]);
  });
});

describe("createAuxiliarySessionStartErrorHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "受け取った start error を launch error state に反映する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "setLaunchStartErrorへ渡されたerror値 が期待値と異なる"
  // observable = "setLaunchStartErrorへ渡されたerror値"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("受け取った start error を launch error state に反映する", () => {
    const error = new Error("start failed");
    const errors: unknown[] = [];
    const handleStartError = createAuxiliarySessionStartErrorHandler({
      setLaunchStartError: (nextError) => {
        errors.push(nextError);
      },
    });

    handleStartError(error);

    assert.deepEqual(errors, [error]);
  });
});

describe("applyAuxiliarySessionStartResult", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "mutation revision、active session、dock、feedback、dialog close の順に反映する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "mutation revision、active session、dock、feedback、dialog close callbackの記録順 が期待値と異なる"
  // observable = "mutation revision、active session、dock、feedback、dialog close callbackの記録順"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("mutation revision、active session、dock、feedback、dialog close の順に反映する", () => {
    const session = makeAuxiliarySession({ id: "aux-started" });
    const events: string[] = [];

    applyAuxiliarySessionStartResult({
      session,
      incrementMutationRevision: () => {
        events.push("revision");
      },
      applyActiveSession: (startedSession) => {
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    assert.deepEqual(events, [
      "revision",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("createAuxiliarySessionStartResultApplier", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "session を受け取る start result applier を作る"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "start result applierがactive sessionへ渡すsession値 が期待値と異なる"
  // observable = "start result applierがactive sessionへ渡すsession値"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("session を受け取る start result applier を作る", () => {
    const session = makeAuxiliarySession({ id: "aux-started" });
    const events: string[] = [];
    const applyStartedSession = createAuxiliarySessionStartResultApplier({
      incrementMutationRevision: () => {
        events.push("revision");
      },
      applyActiveSession: (startedSession) => {
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    applyStartedSession(session);

    assert.deepEqual(events, [
      "revision",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("createActiveAuxiliarySessionStartResultApplier", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "mutation revision と active session 反映を含む start result applier を作る"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "mutation revision、active session、dock、feedback、dialog close callbackの記録順 が期待値と異なる"
  // observable = "mutation revision、active session、dock、feedback、dialog close callbackの記録順"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("mutation revision と active session 反映を含む start result applier を作る", () => {
    const previousSession = makeAuxiliarySession({ id: "aux-previous" });
    const session = makeAuxiliarySession({ id: "aux-started" });
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: previousSession as AuxiliarySession | null };
    const appliedSessions: AuxiliarySession[] = [];
    const events: string[] = [];
    const applyStartedSession = createActiveAuxiliarySessionStartResultApplier({
      mutationRevision,
      activeSessionRef,
      setActiveSession: (startedSession) => {
        events.push(`revision:${mutationRevision.current}`);
        appliedSessions.push(startedSession);
        events.push(`active:${startedSession.id}`);
      },
      setActionDockPinnedExpanded: (expanded) => {
        events.push(`dock:${expanded}`);
      },
      setForceComposerBlockedFeedback: (forced) => {
        events.push(`feedback:${forced}`);
      },
      closeLaunchDialog: () => {
        events.push("close");
      },
    });

    applyStartedSession(session);

    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, session);
    assert.deepEqual(appliedSessions, [session]);
    assert.deepEqual(events, [
      "revision:5",
      "active:aux-started",
      "dock:true",
      "feedback:false",
      "close",
    ]);
  });
});

describe("finishAuxiliarySessionStartClosedLoad", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "closed sessions reload を起動して pending を false に戻す"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "closed sessions reload呼出とpending false callback が期待値と異なる"
  // observable = "closed sessions reload呼出とpending false callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("closed sessions reload を起動して pending を false に戻す", async () => {
    const closedSession = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const events: string[] = [];
    const appliedClosedSessions: AuxiliarySession[][] = [];

    finishAuxiliarySessionStartClosedLoad({
      parentSessionId: "parent-1",
      listAuxiliarySessions: async (parentSessionId) => {
        events.push(`list:${parentSessionId}`);
        return [closedSession];
      },
      getAuxiliarySession: async (sessionId) => {
        events.push(`get:${sessionId}`);
        return closedSession;
      },
      isActive: () => true,
      setClosedSessions: (sessions) => {
        events.push("closed");
        appliedClosedSessions.push(sessions);
      },
      setActionPending: (pending) => {
        events.push(`pending:${pending}`);
      },
    });

    assert.deepEqual(events.slice(0, 2), ["list:parent-1", "pending:false"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(events, [
      "list:parent-1",
      "pending:false",
      "get:closed-1",
      "closed",
    ]);
    assert.deepEqual(appliedClosedSessions, [[closedSession]]);
  });
});

describe("finishAuxiliarySessionStartClosedLoadWithApi", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "api adapter 経由で closed sessions reload と pending clear を実行する"
  // oracle = { type = "characterization", ref = "src/auxiliary-session-start-operation.ts at a4304ad5: 削除前の挙動" }
  // fault = "closed sessions reload呼出とpending false callback が期待値と異なる"
  // observable = "closed sessions reload呼出とpending false callback"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-start-operation"
  // lifecycle = "ephemeral"
  // remove_when = "旧operation本体と対応テストの削除確認が完了した時"
  // @end-test-value
  it("api adapter 経由で closed sessions reload と pending clear を実行する", async () => {
    const closedSession = makeAuxiliarySession({ id: "closed-1", status: "closed" });
    const events: string[] = [];
    const appliedClosedSessions: AuxiliarySession[][] = [];

    finishAuxiliarySessionStartClosedLoadWithApi({
      parentSessionId: "parent-1",
      api: {
        listAuxiliarySessions: async (parentSessionId) => {
          events.push(`list:${parentSessionId}`);
          return [closedSession];
        },
        getAuxiliarySession: async (sessionId) => {
          events.push(`get:${sessionId}`);
          return closedSession;
        },
      },
      isActive: () => true,
      setClosedSessions: (sessions) => {
        events.push("closed");
        appliedClosedSessions.push(sessions);
      },
      setActionPending: (pending) => {
        events.push(`pending:${pending}`);
      },
    });

    assert.deepEqual(events.slice(0, 2), ["list:parent-1", "pending:false"]);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(events, [
      "list:parent-1",
      "pending:false",
      "get:closed-1",
      "closed",
    ]);
    assert.deepEqual(appliedClosedSessions, [[closedSession]]);
  });
});
