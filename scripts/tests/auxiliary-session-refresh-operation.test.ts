import assert from "node:assert/strict";
import test from "node:test";

import {
  applyActiveAuxiliarySessionLoadResult,
  applyActiveAuxiliarySessionRefreshResult,
  applyClosedAuxiliarySessionsLoadResult,
  clearAuxiliarySessionsLoadState,
  createAuxiliaryLoadRevisionGuard,
  runActiveAuxiliarySessionLoadAndApply,
  runActiveAuxiliarySessionLoadOperation,
  runActiveAuxiliarySessionRefreshAndApply,
  runActiveAuxiliarySessionRefreshOperation,
  runClosedAuxiliarySessionsLoadAndApply,
  runClosedAuxiliarySessionsLoadOperation,
} from "../../src/auxiliary-session-refresh-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

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

// @test-value v2
// kind = "contract"
// claim = "createAuxiliaryLoadRevisionGuard は revision と active 状態が一致する場合だけ true を返す"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "revisionとactive状態から返るload適用可否boolean が期待値と異なる"
// observable = "revisionとactive状態から返るload適用可否boolean"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("createAuxiliaryLoadRevisionGuard は revision と active 状態が一致する場合だけ true を返す", () => {
  const loadRevision = { current: 3 };
  let active = true;
  const canApplyLoadResult = createAuxiliaryLoadRevisionGuard({
    loadRevision,
    expectedRevision: 3,
    isActive: () => active,
  });

  assert.equal(canApplyLoadResult(), true);

  loadRevision.current = 4;
  assert.equal(canApplyLoadResult(), false);

  loadRevision.current = 3;
  active = false;
  assert.equal(canApplyLoadResult(), false);
});

// @test-value v2
// kind = "contract"
// claim = "createAuxiliaryLoadRevisionGuard は active callback なしで revision だけを判定する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "revisionとactive状態から返るload適用可否boolean が期待値と異なる"
// observable = "revisionとactive状態から返るload適用可否boolean"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("createAuxiliaryLoadRevisionGuard は active callback なしで revision だけを判定する", () => {
  const loadRevision = { current: 7 };
  const canApplyLoadResult = createAuxiliaryLoadRevisionGuard({
    loadRevision,
    expectedRevision: 7,
  });

  assert.equal(canApplyLoadResult(), true);

  loadRevision.current = 8;
  assert.equal(canApplyLoadResult(), false);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshOperation は active id が違う場合 load しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active id判定、load呼出、saved/null/stale result が期待値と異なる"
// observable = "active id判定、load呼出、saved/null/stale result"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshOperation は active id が違う場合 load しない", async () => {
  const loadedSessionIds: string[] = [];

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: "aux-1",
    activeSessionId: "aux-other",
    loadAuxiliarySession: async (sessionId) => {
      loadedSessionIds.push(sessionId);
      return createAuxiliarySession({ id: sessionId });
    },
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(loadedSessionIds, []);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshOperation は load 後に inactive なら stale にする"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active id判定、load呼出、saved/null/stale result が期待値と異なる"
// observable = "active id判定、load呼出、saved/null/stale result"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshOperation は load 後に inactive なら stale にする", async () => {
  const savedSession = createAuxiliarySession({ title: "saved" });
  let active = true;

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: savedSession.id,
    activeSessionId: savedSession.id,
    loadAuxiliarySession: async () => {
      active = false;
      return savedSession;
    },
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshOperation は active のままなら saved session を返す"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active id判定、load呼出、saved/null/stale result が期待値と異なる"
// observable = "active id判定、load呼出、saved/null/stale result"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshOperation は active のままなら saved session を返す", async () => {
  const savedSession = createAuxiliarySession({ title: "saved" });

  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: savedSession.id,
    activeSessionId: savedSession.id,
    loadAuxiliarySession: async () => savedSession,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    savedSession,
  });
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshOperation は active のままなら null 保存結果も返す"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active id判定、load呼出、saved/null/stale result が期待値と異なる"
// observable = "active id判定、load呼出、saved/null/stale result"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshOperation は active のままなら null 保存結果も返す", async () => {
  const result = await runActiveAuxiliarySessionRefreshOperation({
    sessionId: "aux-1",
    activeSessionId: "aux-1",
    loadAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    savedSession: null,
  });
});

// @test-value v2
// kind = "contract"
// claim = "applyActiveAuxiliarySessionRefreshResult は反映時に active ref を同期する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active sessionとactive refの更新有無 が期待値と異なる"
// observable = "active sessionとactive refの更新有無"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyActiveAuxiliarySessionRefreshResult は反映時に active ref を同期する", () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const savedSession = createAuxiliarySession({ id: "aux-1", title: "saved" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };

  assert.equal(
    applyActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession,
      sessionId: "aux-1",
      activeSessionRef,
    }),
    savedSession,
  );
  assert.equal(activeSessionRef.current, savedSession);
});

// @test-value v2
// kind = "contract"
// claim = "applyActiveAuxiliarySessionRefreshResult は反映しない場合 active ref を維持する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active sessionとactive refの更新有無 が期待値と異なる"
// observable = "active sessionとactive refの更新有無"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyActiveAuxiliarySessionRefreshResult は反映しない場合 active ref を維持する", () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const savedSession = createAuxiliarySession({ id: "aux-other", title: "saved" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };

  assert.equal(
    applyActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession,
      sessionId: "aux-other",
      activeSessionRef,
    }),
    currentSession,
  );
  assert.equal(activeSessionRef.current, currentSession);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshAndApply は loaded result を active session と ref に反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するactive sessionとrefの更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するactive sessionとrefの更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshAndApply は loaded result を active session と ref に反映する", async () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const savedSession = createAuxiliarySession({ id: "aux-1", title: "saved" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };
  const appliedSessions: Array<AuxiliarySession | null> = [];

  const result = await runActiveAuxiliarySessionRefreshAndApply({
    sessionId: savedSession.id,
    activeSessionId: savedSession.id,
    loadAuxiliarySession: async () => savedSession,
    isActive: () => true,
    setActiveSession: (updater) => {
      const nextSession = updater(currentSession);
      appliedSessions.push(nextSession);
    },
    activeSessionRef,
  });

  assert.deepEqual(result, {
    status: "loaded",
    savedSession,
  });
  assert.deepEqual(appliedSessions, [savedSession]);
  assert.equal(activeSessionRef.current, savedSession);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionRefreshAndApply は stale / skipped result では active session を変更しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するactive sessionとrefの更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するactive sessionとrefの更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionRefreshAndApply は stale / skipped result では active session を変更しない", async () => {
  const currentSession = createAuxiliarySession({ id: "aux-1", title: "current" });
  const activeSessionRef = { current: currentSession as AuxiliarySession | null };
  const appliedSessions: Array<AuxiliarySession | null> = [];
  let active = true;

  assert.deepEqual(
    await runActiveAuxiliarySessionRefreshAndApply({
      sessionId: "aux-1",
      activeSessionId: "aux-other",
      loadAuxiliarySession: async () => createAuxiliarySession(),
      isActive: () => true,
      setActiveSession: (updater) => {
        appliedSessions.push(updater(currentSession));
      },
      activeSessionRef,
    }),
    { status: "skipped" },
  );

  assert.deepEqual(
    await runActiveAuxiliarySessionRefreshAndApply({
      sessionId: "aux-1",
      activeSessionId: "aux-1",
      loadAuxiliarySession: async () => {
        active = false;
        return createAuxiliarySession({ id: "aux-1", title: "saved" });
      },
      isActive: () => active,
      setActiveSession: (updater) => {
        appliedSessions.push(updater(currentSession));
      },
      activeSessionRef,
    }),
    { status: "stale" },
  );

  assert.deepEqual(appliedSessions, []);
  assert.equal(activeSessionRef.current, currentSession);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadOperation は parent session id がない場合 load しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadOperation は parent session id がない場合 load しない", async () => {
  const loadedParentSessionIds: string[] = [];

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: null,
    getActiveAuxiliarySession: async (parentSessionId) => {
      loadedParentSessionIds.push(parentSessionId);
      return createAuxiliarySession({ parentSessionId });
    },
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(loadedParentSessionIds, []);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadOperation は active session を読み込む"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadOperation は active session を読み込む", async () => {
  const activeSession = createAuxiliarySession({ parentSessionId: "parent-1" });

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => activeSession,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    session: activeSession,
  });
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadOperation は load failure を null loaded result にする"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadOperation は load failure を null loaded result にする", async () => {
  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => {
      throw new Error("load failed");
    },
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    session: null,
  });
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadOperation は load 後に inactive なら stale にする"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadOperation は load 後に inactive なら stale にする", async () => {
  let active = true;

  const result = await runActiveAuxiliarySessionLoadOperation({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => {
      active = false;
      return createAuxiliarySession({ parentSessionId: "parent-1" });
    },
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

// @test-value v2
// kind = "contract"
// claim = "applyActiveAuxiliarySessionLoadResult は loaded result だけ active session に反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/null/stale結果に対するactive session更新 が期待値と異なる"
// observable = "loaded/null/stale結果に対するactive session更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyActiveAuxiliarySessionLoadResult は loaded result だけ active session に反映する", () => {
  const activeSession = createAuxiliarySession({ id: "aux-loaded" });
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: {
        status: "loaded",
        session: activeSession,
      },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [activeSession]);
});

// @test-value v2
// kind = "contract"
// claim = "applyActiveAuxiliarySessionLoadResult は loaded null result を active session clear として反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/null/stale結果に対するactive session更新 が期待値と異なる"
// observable = "loaded/null/stale結果に対するactive session更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyActiveAuxiliarySessionLoadResult は loaded null result を active session clear として反映する", () => {
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: {
        status: "loaded",
        session: null,
      },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [null]);
});

// @test-value v2
// kind = "contract"
// claim = "applyActiveAuxiliarySessionLoadResult は stale / skipped result では active session を変更しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/null/stale結果に対するactive session更新 が期待値と異なる"
// observable = "loaded/null/stale結果に対するactive session更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyActiveAuxiliarySessionLoadResult は stale / skipped result では active session を変更しない", () => {
  const appliedSessions: Array<AuxiliarySession | null> = [];

  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: { status: "stale" },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    false,
  );
  assert.equal(
    applyActiveAuxiliarySessionLoadResult({
      result: { status: "skipped" },
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    false,
  );

  assert.deepEqual(appliedSessions, []);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadAndApply は loaded result を active session に反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するactive session更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するactive session更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadAndApply は loaded result を active session に反映する", async () => {
  const activeSession = createAuxiliarySession({ id: "aux-loaded" });
  const appliedSessions: Array<AuxiliarySession | null> = [];

  const result = await runActiveAuxiliarySessionLoadAndApply({
    parentSessionId: "parent-1",
    getActiveAuxiliarySession: async () => activeSession,
    isActive: () => true,
    setActiveSession: (session) => {
      appliedSessions.push(session);
    },
  });

  assert.deepEqual(result, {
    status: "loaded",
    session: activeSession,
  });
  assert.deepEqual(appliedSessions, [activeSession]);
});

// @test-value v2
// kind = "contract"
// claim = "runActiveAuxiliarySessionLoadAndApply は stale / skipped result では active session を変更しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するactive session更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するactive session更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runActiveAuxiliarySessionLoadAndApply は stale / skipped result では active session を変更しない", async () => {
  const appliedSessions: Array<AuxiliarySession | null> = [];
  let active = true;

  assert.deepEqual(
    await runActiveAuxiliarySessionLoadAndApply({
      parentSessionId: null,
      getActiveAuxiliarySession: async () => createAuxiliarySession(),
      isActive: () => true,
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    { status: "skipped" },
  );

  assert.deepEqual(
    await runActiveAuxiliarySessionLoadAndApply({
      parentSessionId: "parent-1",
      getActiveAuxiliarySession: async () => {
        active = false;
        return createAuxiliarySession();
      },
      isActive: () => active,
      setActiveSession: (session) => {
        appliedSessions.push(session);
      },
    }),
    { status: "stale" },
  );

  assert.deepEqual(appliedSessions, []);
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadOperation は parent session id がない場合 load しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、closed details load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、closed details load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadOperation は parent session id がない場合 load しない", async () => {
  const listedSessionIds: string[] = [];

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: null,
    listAuxiliarySessions: async (parentSessionId) => {
      listedSessionIds.push(parentSessionId);
      return [];
    },
    getAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(listedSessionIds, []);
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadOperation は closed session details を読み込む"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、closed details load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、closed details load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadOperation は closed session details を読み込む", async () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const listedParentSessionIds: string[] = [];
  const requestedSessionIds: string[] = [];

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async (parentSessionId) => {
      listedParentSessionIds.push(parentSessionId);
      return [
        createAuxiliarySession({ id: "active-1", status: "active" }),
        createAuxiliarySession({ id: "closed-1", status: "closed" }),
        createAuxiliarySession({ id: "closed-missing", status: "closed" }),
      ];
    },
    getAuxiliarySession: async (sessionId) => {
      requestedSessionIds.push(sessionId);
      if (sessionId === closedSession.id) {
        return closedSession;
      }
      return null;
    },
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    sessions: [closedSession],
  });
  assert.deepEqual(listedParentSessionIds, ["parent-1"]);
  assert.deepEqual(requestedSessionIds, ["closed-missing", "closed-1"]);
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadOperation は load failure を empty loaded result にする"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、closed details load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、closed details load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadOperation は load failure を empty loaded result にする", async () => {
  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async () => {
      throw new Error("load failed");
    },
    getAuxiliarySession: async () => null,
    isActive: () => true,
  });

  assert.deepEqual(result, {
    status: "loaded",
    sessions: [],
  });
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadOperation は load 後に inactive なら stale にする"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "parent session id判定、closed details load結果、stale状態 が期待値と異なる"
// observable = "parent session id判定、closed details load結果、stale状態"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadOperation は load 後に inactive なら stale にする", async () => {
  let active = true;

  const result = await runClosedAuxiliarySessionsLoadOperation({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async () => {
      active = false;
      return [];
    },
    getAuxiliarySession: async () => null,
    isActive: () => active,
  });

  assert.deepEqual(result, { status: "stale" });
});

// @test-value v2
// kind = "contract"
// claim = "applyClosedAuxiliarySessionsLoadResult は loaded result だけ closed sessions に反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/empty/stale結果に対するclosed sessions更新 が期待値と異なる"
// observable = "loaded/empty/stale結果に対するclosed sessions更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyClosedAuxiliarySessionsLoadResult は loaded result だけ closed sessions に反映する", () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: {
        status: "loaded",
        sessions: [closedSession],
      },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [[closedSession]]);
});

// @test-value v2
// kind = "contract"
// claim = "applyClosedAuxiliarySessionsLoadResult は empty loaded result を closed sessions clear として反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/empty/stale結果に対するclosed sessions更新 が期待値と異なる"
// observable = "loaded/empty/stale結果に対するclosed sessions更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyClosedAuxiliarySessionsLoadResult は empty loaded result を closed sessions clear として反映する", () => {
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: {
        status: "loaded",
        sessions: [],
      },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    true,
  );

  assert.deepEqual(appliedSessions, [[]]);
});

// @test-value v2
// kind = "contract"
// claim = "applyClosedAuxiliarySessionsLoadResult は stale / skipped result では closed sessions を変更しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/empty/stale結果に対するclosed sessions更新 が期待値と異なる"
// observable = "loaded/empty/stale結果に対するclosed sessions更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("applyClosedAuxiliarySessionsLoadResult は stale / skipped result では closed sessions を変更しない", () => {
  const appliedSessions: AuxiliarySession[][] = [];

  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: { status: "stale" },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    false,
  );
  assert.equal(
    applyClosedAuxiliarySessionsLoadResult({
      result: { status: "skipped" },
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    false,
  );

  assert.deepEqual(appliedSessions, []);
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadAndApply は loaded result を closed sessions に反映する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するclosed sessions更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するclosed sessions更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadAndApply は loaded result を closed sessions に反映する", async () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const appliedSessions: AuxiliarySession[][] = [];

  const result = await runClosedAuxiliarySessionsLoadAndApply({
    parentSessionId: "parent-1",
    listAuxiliarySessions: async () => [closedSession],
    getAuxiliarySession: async () => closedSession,
    isActive: () => true,
    setClosedSessions: (sessions) => {
      appliedSessions.push(sessions);
    },
  });

  assert.deepEqual(result, {
    status: "loaded",
    sessions: [closedSession],
  });
  assert.deepEqual(appliedSessions, [[closedSession]]);
});

// @test-value v2
// kind = "contract"
// claim = "runClosedAuxiliarySessionsLoadAndApply は stale / skipped result では closed sessions を変更しない"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "loaded/stale/skipped結果に対するclosed sessions更新 が期待値と異なる"
// observable = "loaded/stale/skipped結果に対するclosed sessions更新"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("runClosedAuxiliarySessionsLoadAndApply は stale / skipped result では closed sessions を変更しない", async () => {
  const appliedSessions: AuxiliarySession[][] = [];
  let active = true;

  assert.deepEqual(
    await runClosedAuxiliarySessionsLoadAndApply({
      parentSessionId: null,
      listAuxiliarySessions: async () => [],
      getAuxiliarySession: async () => null,
      isActive: () => true,
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    { status: "skipped" },
  );

  assert.deepEqual(
    await runClosedAuxiliarySessionsLoadAndApply({
      parentSessionId: "parent-1",
      listAuxiliarySessions: async () => {
        active = false;
        return [];
      },
      getAuxiliarySession: async () => null,
      isActive: () => active,
      setClosedSessions: (sessions) => {
        appliedSessions.push(sessions);
      },
    }),
    { status: "stale" },
  );

  assert.deepEqual(appliedSessions, []);
});

// @test-value v2
// kind = "contract"
// claim = "clearAuxiliarySessionsLoadState は active session と closed sessions を初期化する"
// oracle = { type = "characterization", ref = "src/auxiliary-session-refresh-operation.ts at a4304ad5: 削除前の挙動" }
// fault = "active sessionとclosed sessionsの初期化callback が期待値と異なる"
// observable = "active sessionとclosed sessionsの初期化callback"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-refresh-operation"
// lifecycle = "ephemeral"
// remove_when = "旧operation本体と対応テストの削除確認が完了した時"
// @end-test-value
test("clearAuxiliarySessionsLoadState は active session と closed sessions を初期化する", () => {
  const activeSessions: Array<AuxiliarySession | null> = [];
  const closedSessions: AuxiliarySession[][] = [];

  clearAuxiliarySessionsLoadState({
    setActiveSession: (session) => {
      activeSessions.push(session);
    },
    setClosedSessions: (sessions) => {
      closedSessions.push(sessions);
    },
  });

  assert.deepEqual(activeSessions, [null]);
  assert.deepEqual(closedSessions, [[]]);
});
