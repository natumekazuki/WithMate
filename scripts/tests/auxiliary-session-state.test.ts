import assert from "node:assert/strict";
import test from "node:test";

import {
  addAuxiliarySessionAdditionalDirectory,
  applyAuxiliarySessionPatch,
  applyAuxiliarySessionComposerDraftPatch,
  applyAuxiliarySessionCustomAgentPatch,
  applyAuxiliarySessionModelSelectionPatch,
  applyAuxiliarySessionRuntimeOptionsPatch,
  buildAuxiliaryDraftSaveRequest,
  buildEditableActiveAuxiliarySessionPatch,
  buildAuxiliarySessionRunningTransition,
  buildRunningAuxiliarySessionTurn,
  loadClosedAuxiliarySessionDetails,
  removeAuxiliarySessionAdditionalDirectory,
  resolveActiveAuxiliarySessionRefreshResult,
  resolveAuxiliarySessionDisplayAfterMessageIndex,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  resolveClosedAuxiliarySessionIds,
  resolveClosedAuxiliarySessionsAfterReturn,
  resolveClosedAuxiliarySessionsLoadResult,
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

test("applyAuxiliarySessionRuntimeOptionsPatch は runtime option と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
  });

  assert.deepEqual(
    applyAuxiliarySessionRuntimeOptionsPatch(
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

test("applyAuxiliarySessionModelSelectionPatch は model selection と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
  });

  assert.deepEqual(
    applyAuxiliarySessionModelSelectionPatch(
      session,
      {
        catalogRevision: 2,
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
      },
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      catalogRevision: 2,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("addAuxiliarySessionAdditionalDirectory は重複を避けて directory と updatedAt を更新する", () => {
  const session = createAuxiliarySession({
    allowedAdditionalDirectories: ["C:/workspace/existing"],
  });

  assert.deepEqual(
    addAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/next",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/existing", "C:/workspace/next"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
  assert.deepEqual(
    addAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/existing",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/existing"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("removeAuxiliarySessionAdditionalDirectory は指定 directory と updatedAt を更新する", () => {
  const session = createAuxiliarySession({
    allowedAdditionalDirectories: ["C:/workspace/keep", "C:/workspace/remove"],
  });

  assert.deepEqual(
    removeAuxiliarySessionAdditionalDirectory(
      session,
      "C:/workspace/remove",
      "2026-01-02T00:00:00.000Z",
    ),
    {
      ...session,
      allowedAdditionalDirectories: ["C:/workspace/keep"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionComposerDraftPatch は draft と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    composerDraft: "before",
  });

  assert.deepEqual(
    applyAuxiliarySessionComposerDraftPatch(session, "after", "2026-01-02T00:00:00.000Z"),
    {
      ...session,
      composerDraft: "after",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("applyAuxiliarySessionCustomAgentPatch は custom agent と updatedAt だけを更新する", () => {
  const session = createAuxiliarySession({
    customAgentName: "reviewer",
  });

  assert.deepEqual(
    applyAuxiliarySessionCustomAgentPatch(session, "planner", "2026-01-02T00:00:00.000Z"),
    {
      ...session,
      customAgentName: "planner",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("buildAuxiliaryDraftSaveRequest は保存すべき draft request を作る", () => {
  const currentSession = createAuxiliarySession({
    composerDraft: "draft text",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(
    buildAuxiliaryDraftSaveRequest({
      currentSession,
      targetSessionId: currentSession.id,
      draft: "draft text",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    {
      ...currentSession,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  );
});

test("buildAuxiliaryDraftSaveRequest は古い draft save を無視する", () => {
  const currentSession = createAuxiliarySession({
    composerDraft: "newer draft",
  });

  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession,
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession: createAuxiliarySession({ id: "aux-other", composerDraft: "stale draft" }),
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    buildAuxiliaryDraftSaveRequest({
      currentSession: null,
      targetSessionId: currentSession.id,
      draft: "stale draft",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
    null,
  );
});

test("resolveAuxiliarySessionSendPreflight は送信文を trim する", () => {
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      messageText: "  hello  ",
    }),
    {
      blockedReason: null,
      blockedMessage: "",
      userMessage: "hello",
    },
  );
});

test("resolveAuxiliarySessionSendPreflight は送信前 block 理由を返す", () => {
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      messageText: "   ",
    }),
    {
      blockedReason: "empty-message",
      blockedMessage: "送信するメッセージが空だよ。",
      userMessage: "",
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession({ runState: "running" }),
      messageText: "hello",
    }),
    {
      blockedReason: "running",
      blockedMessage: "Auxiliary Session はまだ実行中だよ。",
      userMessage: "hello",
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendPreflight({
      activeSession: createAuxiliarySession(),
      composerBlockedReason: "blocked",
      messageText: "hello",
    }),
    {
      blockedReason: "composer-blocked",
      blockedMessage: "blocked",
      userMessage: "hello",
    },
  );
});

test("resolveAuxiliarySessionSendTarget は保存後の送信対象 session を返す", () => {
  const activeSession = createAuxiliarySession({ title: "active" });
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: null,
    }),
    {
      blockedReason: null,
      session: activeSession,
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession,
    }),
    {
      blockedReason: null,
      session: currentSession,
    },
  );
});

test("resolveAuxiliarySessionSendTarget は session 変更と running を区別する", () => {
  const activeSession = createAuxiliarySession();

  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
    }),
    {
      blockedReason: "session-changed",
      session: null,
    },
  );
  assert.deepEqual(
    resolveAuxiliarySessionSendTarget({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
    }),
    {
      blockedReason: "running",
      session: null,
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

test("buildEditableActiveAuxiliarySessionPatch は保存対象 session に recipe を適用する", () => {
  const activeSession = createAuxiliarySession({ title: "active" });
  const currentSession = createAuxiliarySession({ title: "current" });

  assert.deepEqual(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession,
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    {
      ...currentSession,
      title: "next",
    },
  );
  assert.equal(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession: createAuxiliarySession({ id: "aux-other" }),
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    null,
  );
  assert.equal(
    buildEditableActiveAuxiliarySessionPatch({
      activeSession,
      currentSession: createAuxiliarySession({ runState: "running" }),
      recipe: (current) => ({ ...current, title: "next" }),
    }),
    null,
  );
});

test("resolveActiveAuxiliarySessionRefreshResult は完了後 refresh の反映先を解決する", () => {
  const currentSession = createAuxiliarySession({
    runState: "running",
    title: "optimistic",
    messages: [{ role: "user", text: "sent" }],
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  const savedIdleSession = createAuxiliarySession({
    runState: "idle",
    title: "saved",
    messages: [
      { role: "user", text: "sent" },
      { role: "assistant", text: "done" },
    ],
    updatedAt: "2026-01-03T00:00:00.000Z",
  });
  const staleSavedIdleSession = createAuxiliarySession({
    runState: "idle",
    title: "stale saved",
    messages: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const staleTimestampSavedIdleSession = createAuxiliarySession({
    runState: "idle",
    title: "stale timestamp",
    messages: [{ role: "user", text: "sent" }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const savedRunningSession = createAuxiliarySession({ runState: "running", title: "saved running" });

  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: savedRunningSession,
      sessionId: currentSession.id,
    }),
    currentSession,
  );
  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: savedIdleSession,
      sessionId: currentSession.id,
    }),
    savedIdleSession,
  );
  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: staleSavedIdleSession,
      sessionId: currentSession.id,
    }),
    currentSession,
  );
  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: staleTimestampSavedIdleSession,
      sessionId: currentSession.id,
    }),
    currentSession,
  );
  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: null,
      sessionId: currentSession.id,
    }),
    null,
  );
  assert.equal(
    resolveActiveAuxiliarySessionRefreshResult({
      currentSession,
      savedSession: savedIdleSession,
      sessionId: "aux-other",
    }),
    currentSession,
  );
});

test("resolveAuxiliarySessionDisplayAfterMessageIndex は初回 Auxiliary anchor を解決する", () => {
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 0,
      currentDisplayAfterMessageIndex: null,
      parentMessageCount: 5,
    }),
    4,
  );
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 1,
      currentDisplayAfterMessageIndex: 2,
      parentMessageCount: 5,
    }),
    2,
  );
  assert.equal(
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount: 0,
      currentDisplayAfterMessageIndex: 3,
      parentMessageCount: null,
    }),
    3,
  );
});

test("resolveClosedAuxiliarySessionIds は closed summary を新しい順の id にする", () => {
  assert.deepEqual(
    resolveClosedAuxiliarySessionIds([
      createAuxiliarySession({ id: "closed-1", status: "closed" }),
      createAuxiliarySession({ id: "active-1", status: "active" }),
      createAuxiliarySession({ id: "closed-2", status: "closed" }),
    ]),
    ["closed-2", "closed-1"],
  );
});

test("resolveClosedAuxiliarySessionsLoadResult は null を除外する", () => {
  const closedSession = createAuxiliarySession({ id: "closed-1", status: "closed" });

  assert.deepEqual(
    resolveClosedAuxiliarySessionsLoadResult([null, closedSession, null]),
    [closedSession],
  );
});

test("resolveClosedAuxiliarySessionsAfterReturn は重複を避けて closed session を末尾に置く", () => {
  const oldClosedSession = createAuxiliarySession({ id: "aux-1", status: "closed", title: "old" });
  const otherClosedSession = createAuxiliarySession({ id: "aux-2", status: "closed", title: "other" });
  const returnedClosedSession = createAuxiliarySession({ id: "aux-1", status: "closed", title: "returned" });

  assert.deepEqual(
    resolveClosedAuxiliarySessionsAfterReturn(
      [oldClosedSession, otherClosedSession],
      returnedClosedSession,
    ),
    [otherClosedSession, returnedClosedSession],
  );
});

test("loadClosedAuxiliarySessionDetails は closed session details を読み込む", async () => {
  const closedSession1 = createAuxiliarySession({ id: "closed-1", status: "closed" });
  const closedSession2 = createAuxiliarySession({ id: "closed-2", status: "closed" });
  const requestedSessionIds: string[] = [];

  assert.deepEqual(
    await loadClosedAuxiliarySessionDetails({
      parentSessionId: "parent-1",
      listAuxiliarySessions: async (parentSessionId) => {
        assert.equal(parentSessionId, "parent-1");
        return [
          closedSession1,
          createAuxiliarySession({ id: "active-1", status: "active" }),
          closedSession2,
        ];
      },
      getAuxiliarySession: async (sessionId) => {
        requestedSessionIds.push(sessionId);
        if (sessionId === "closed-1") {
          return closedSession1;
        }
        if (sessionId === "closed-2") {
          return null;
        }
        return null;
      },
    }),
    [closedSession1],
  );
  assert.deepEqual(requestedSessionIds, ["closed-2", "closed-1"]);
});

test("buildRunningAuxiliarySessionTurn は実行中 session state を組み立てる", () => {
  const session = createAuxiliarySession({
    composerDraft: "draft text",
    displayAfterMessageIndex: 3,
    messages: [{ role: "user", text: "previous" }],
    updatedAt: "2026-05-30T00:00:00.000Z",
  });

  assert.deepEqual(
    buildRunningAuxiliarySessionTurn({
      session,
      userMessage: "next message",
      displayAfterMessageIndex: 8,
      updatedAt: "2026-05-31T00:00:00.000Z",
    }),
    {
      ...session,
      runState: "running",
      composerDraft: "",
      displayAfterMessageIndex: 8,
      updatedAt: "2026-05-31T00:00:00.000Z",
      messages: [
        { role: "user", text: "previous" },
        { role: "user", text: "next message" },
      ],
    },
  );
});

test("buildAuxiliarySessionRunningTransition は初回 anchor update と running state を組み立てる", () => {
  const session = createAuxiliarySession({
    composerDraft: "draft text",
    displayAfterMessageIndex: null,
    messages: [],
    updatedAt: "2026-05-30T00:00:00.000Z",
  });

  assert.deepEqual(
    buildAuxiliarySessionRunningTransition({
      session,
      userMessage: "next message",
      parentMessageCount: 4,
      updatedAt: "2026-05-31T00:00:00.000Z",
    }),
    {
      anchorUpdateSession: {
        ...session,
        displayAfterMessageIndex: 3,
      },
      runningSession: {
        ...session,
        runState: "running",
        composerDraft: "",
        displayAfterMessageIndex: 3,
        updatedAt: "2026-05-31T00:00:00.000Z",
        messages: [{ role: "user", text: "next message" }],
      },
    },
  );
});

test("buildAuxiliarySessionRunningTransition は既存 anchor では保存用 update を作らない", () => {
  const session = createAuxiliarySession({
    composerDraft: "draft text",
    displayAfterMessageIndex: 2,
    messages: [{ role: "user", text: "previous" }],
    updatedAt: "2026-05-30T00:00:00.000Z",
  });

  const result = buildAuxiliarySessionRunningTransition({
    session,
    userMessage: "next message",
    parentMessageCount: 4,
    updatedAt: "2026-05-31T00:00:00.000Z",
  });

  assert.equal(result.anchorUpdateSession, null);
  assert.deepEqual(result.runningSession, {
    ...session,
    runState: "running",
    composerDraft: "",
    displayAfterMessageIndex: 2,
    updatedAt: "2026-05-31T00:00:00.000Z",
    messages: [
      { role: "user", text: "previous" },
      { role: "user", text: "next message" },
    ],
  });
});
