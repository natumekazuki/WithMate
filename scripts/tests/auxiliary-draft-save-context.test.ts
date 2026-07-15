import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAuxiliaryDraftChangeUiState,
  applyScheduledAuxiliaryDraftSaveUiState,
  areStringArraysEqual,
  createAppliedAuxiliaryDraftSaveResultResolver,
  hasSameAuxiliaryDraftSaveContext,
  resolveAppliedAuxiliaryDraftSaveResult,
  resolveAuxiliaryDraftSaveOperationResult,
  resolveAuxiliaryDraftSaveResult,
  runAuxiliaryDraftChangeAndSaveOperation,
  runAuxiliaryDraftPatchOperation,
  runAuxiliaryDraftSaveOperation,
  runScheduledAuxiliaryDraftSaveAndApply,
  scheduleAuxiliaryDraftSaveOperation,
} from "../../src/auxiliary-draft-save-context.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "copilot",
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write-network",
    customAgentName: "",
    allowedAdditionalDirectories: ["C:/shared"],
    threadId: "thread-1",
    composerDraft: "draft",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

describe("applyAuxiliaryDraftChangeUiState", () => {
  it("blocked feedback を clear して composer caret を更新する", () => {
    const events: string[] = [];

    applyAuxiliaryDraftChangeUiState({
      selectionStart: 7,
      clearBlockedFeedback: () => {
        events.push("feedback:false");
      },
      setComposerCaret: (caret) => {
        events.push(`caret:${caret}`);
      },
    });

    assert.deepEqual(events, ["feedback:false", "caret:7"]);
  });
});

describe("areStringArraysEqual", () => {
  it("同順同長なら true", () => {
    assert.equal(areStringArraysEqual(["a", "b"], ["a", "b"]), true);
  });

  it("配列順が違えば false", () => {
    assert.equal(areStringArraysEqual(["a", "b"], ["b", "a"]), false);
  });

  it("長さが違えば false", () => {
    assert.equal(areStringArraysEqual(["a"], ["a", "a"]), false);
  });
});

describe("hasSameAuxiliaryDraftSaveContext", () => {
  it("共通比較フィールドが同一なら true", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession();

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request), true);
  });

  it("App 側は status を無視して比較できる", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession({ status: "closed" });

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request), true);
    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request, { compareStatus: false }), true);
  });

  it("CompanionReview 側は status を比較するので status 差異で false", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession({ status: "closed" });

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request, { compareStatus: true }), false);
  });
});

describe("resolveAuxiliaryDraftSaveResult", () => {
  it("保存 context が一致すると saved を返す", () => {
    const current = makeAuxiliarySession({ composerDraft: "draft" });
    const request = makeAuxiliarySession({ composerDraft: "draft" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });

    assert.deepEqual(resolveAuxiliaryDraftSaveResult(current, request, saved), saved);
  });

  it("structured clone 済みの保存応答から変更のない配列参照を引き継ぐ", () => {
    const messages = [{ role: "assistant" as const, text: "persisted response" }];
    const allowedAdditionalDirectories = ["C:\\workspace"];
    const current = makeAuxiliarySession({
      composerDraft: "draft",
      messages,
      allowedAdditionalDirectories,
    });
    const request = {
      ...current,
      updatedAt: "request",
    };
    const saved = structuredClone({
      ...request,
      updatedAt: "saved",
    });

    const resolved = resolveAuxiliaryDraftSaveResult(current, request, saved);

    assert.notEqual(saved.messages, messages);
    assert.notEqual(saved.allowedAdditionalDirectories, allowedAdditionalDirectories);
    assert.equal(resolved?.messages, messages);
    assert.equal(resolved?.allowedAdditionalDirectories, allowedAdditionalDirectories);
    assert.equal(resolved?.updatedAt, "saved");
  });

  it("current がない場合は null を返す", () => {
    const request = makeAuxiliarySession();
    const saved = makeAuxiliarySession({ updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(null, request, saved), null);
  });

  it("保存 context が変わった場合は current を維持する", () => {
    const current = makeAuxiliarySession({ composerDraft: "newer" });
    const request = makeAuxiliarySession({ composerDraft: "older" });
    const saved = makeAuxiliarySession({ composerDraft: "older", updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved), current);
  });

  it("compareStatus が true の場合は status 差異で current を維持する", () => {
    const current = makeAuxiliarySession({ status: "closed" });
    const request = makeAuxiliarySession({ status: "active" });
    const saved = makeAuxiliarySession({ status: "active", updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved, { compareStatus: true }), current);
  });
});

describe("resolveAuxiliaryDraftSaveOperationResult", () => {
  it("保存 result が null の場合は current を維持する", () => {
    const current = makeAuxiliarySession({ composerDraft: "current" });

    assert.equal(resolveAuxiliaryDraftSaveOperationResult(current, null), current);
  });

  it("保存 result がある場合は compareStatus を含めて result を解決する", () => {
    const current = makeAuxiliarySession({ status: "closed", composerDraft: "draft" });
    const request = makeAuxiliarySession({ status: "active", composerDraft: "draft" });
    const saved = makeAuxiliarySession({ status: "active", composerDraft: "draft", updatedAt: "saved" });

    assert.equal(
      resolveAuxiliaryDraftSaveOperationResult(current, { request, saved }, { compareStatus: true }),
      current,
    );
  });
});

describe("resolveAppliedAuxiliaryDraftSaveResult", () => {
  it("saved を適用できた場合は active ref も saved に同期する", () => {
    const current = makeAuxiliarySession({ composerDraft: "draft" });
    const request = makeAuxiliarySession({ composerDraft: "draft" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });
    const activeSessionRef = { current };

    const next = resolveAppliedAuxiliaryDraftSaveResult({
      current,
      result: { request, saved },
      activeSessionRef,
    });

    assert.deepEqual(next, saved);
    assert.equal(activeSessionRef.current, next);
  });

  it("saved を適用しない場合は active ref を維持する", () => {
    const current = makeAuxiliarySession({ composerDraft: "newer" });
    const request = makeAuxiliarySession({ composerDraft: "older" });
    const saved = makeAuxiliarySession({ composerDraft: "older", updatedAt: "saved" });
    const activeSessionRef = { current };

    const next = resolveAppliedAuxiliaryDraftSaveResult({
      current,
      result: { request, saved },
      activeSessionRef,
    });

    assert.equal(next, current);
    assert.equal(activeSessionRef.current, current);
  });
});

describe("createAppliedAuxiliaryDraftSaveResultResolver", () => {
  it("state updater callback として saved result を active ref に同期する", () => {
    const current = makeAuxiliarySession({ composerDraft: "draft" });
    const request = makeAuxiliarySession({ composerDraft: "draft" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });
    const activeSessionRef = { current };
    const resolveResult = createAppliedAuxiliaryDraftSaveResultResolver({
      result: { request, saved },
      activeSessionRef,
    });

    const resolved = resolveResult(current);
    assert.deepEqual(resolved, saved);
    assert.equal(activeSessionRef.current, resolved);
  });

  it("compareStatus が true の場合は status 差異で current を維持する", () => {
    const current = makeAuxiliarySession({ status: "closed", composerDraft: "draft" });
    const request = makeAuxiliarySession({ status: "active", composerDraft: "draft" });
    const saved = makeAuxiliarySession({ status: "active", composerDraft: "draft", updatedAt: "saved" });
    const activeSessionRef = { current };
    const resolveResult = createAppliedAuxiliaryDraftSaveResultResolver({
      result: { request, saved },
      activeSessionRef,
      compareStatus: true,
    });

    assert.equal(resolveResult(current), current);
    assert.equal(activeSessionRef.current, current);
  });
});

describe("runAuxiliaryDraftPatchOperation", () => {
  it("draft patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({ composerDraft: "before", updatedAt: "before" });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryDraftPatchOperation({
      draft: "after",
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      composerDraft: "after",
      updatedAt: "updated",
    });
  });
});

describe("runAuxiliaryDraftSaveOperation", () => {
  it("保存 request を作って save 結果を返す", async () => {
    const current = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "current" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });
    const requests: AuxiliarySession[] = [];

    assert.deepEqual(
      await runAuxiliaryDraftSaveOperation({
        currentSession: current,
        targetSessionId: current.id,
        draft: "draft",
        updatedAt: "request",
        saveAuxiliarySession: async (request) => {
          requests.push(request);
          return saved;
        },
      }),
      {
        request: {
          ...current,
          updatedAt: "request",
        },
        saved,
      },
    );
    assert.deepEqual(requests, [{
      ...current,
      updatedAt: "request",
    }]);
  });

  it("保存 request を作れない場合は save しない", async () => {
    let saved = false;

    assert.equal(
      await runAuxiliaryDraftSaveOperation({
        currentSession: makeAuxiliarySession({ composerDraft: "newer" }),
        targetSessionId: "aux-1",
        draft: "older",
        updatedAt: "request",
        saveAuxiliarySession: async (request) => {
          saved = true;
          return request;
        },
      }),
      null,
    );
    assert.equal(saved, false);
  });

  it("save が失敗した場合は例外を伝播する", async () => {
    const error = new Error("save failed");

    await assert.rejects(
      runAuxiliaryDraftSaveOperation({
        currentSession: makeAuxiliarySession({ composerDraft: "draft" }),
        targetSessionId: "aux-1",
        draft: "draft",
        updatedAt: "request",
        saveAuxiliarySession: async () => {
          throw error;
        },
      }),
      error,
    );
  });
});

describe("scheduleAuxiliaryDraftSaveOperation", () => {
  it("scheduled draft save の optimistic UI state を反映する", async () => {
    const nextSession = makeAuxiliarySession({ composerDraft: "next" });
    const saveOperation = Promise.resolve(null);
    const draftSaveQueue = Promise.resolve();
    const mutationRevision = { current: 4 };
    const activeSessionRef = { current: makeAuxiliarySession() as AuxiliarySession | null };
    const draftSaveQueueRef = { current: Promise.resolve() };
    let activeSession: AuxiliarySession | null = null;

    const returnedOperation = applyScheduledAuxiliaryDraftSaveUiState({
      scheduled: {
        nextSession,
        saveOperation,
        draftSaveQueue,
      },
      mutationRevision,
      activeSessionRef,
      draftSaveQueueRef,
      setActiveSession: (session) => {
        activeSession = session;
      },
    });

    assert.equal(returnedOperation, saveOperation);
    assert.equal(mutationRevision.current, 5);
    assert.equal(activeSessionRef.current, nextSession);
    assert.equal(activeSession, nextSession);
    assert.equal(draftSaveQueueRef.current, draftSaveQueue);
    await returnedOperation;
  });

  it("draft patch を先に返し、既存 queue の後で最新 current session を保存する", async () => {
    let releaseQueue = () => {};
    const initialQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    let latestCurrent = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "latest" });
    const saved = makeAuxiliarySession({ composerDraft: "next", updatedAt: "saved" });
    const requests: AuxiliarySession[] = [];

    const scheduled = scheduleAuxiliaryDraftSaveOperation({
      currentSession: makeAuxiliarySession({ composerDraft: "draft", updatedAt: "current" }),
      draft: "next",
      createTimestampLabel: (() => {
        let count = 0;
        return () => {
          count += 1;
          return `timestamp-${count}`;
        };
      })(),
      draftSaveQueue: initialQueue,
      getCurrentSession: () => latestCurrent,
      saveAuxiliarySession: async (request) => {
        requests.push(request);
        return saved;
      },
    });

    assert.equal(scheduled.nextSession.composerDraft, "next");
    assert.equal(scheduled.nextSession.updatedAt, "timestamp-1");
    latestCurrent = { ...latestCurrent, composerDraft: "next", updatedAt: "latest-before-save" };
    releaseQueue();

    assert.deepEqual(await scheduled.saveOperation, {
      request: {
        ...latestCurrent,
        updatedAt: "timestamp-2",
      },
      saved,
    });
    assert.deepEqual(requests, [{
      ...latestCurrent,
      updatedAt: "timestamp-2",
    }]);
    await scheduled.draftSaveQueue;
  });
});

describe("runScheduledAuxiliaryDraftSaveAndApply", () => {
  it("scheduled draft save の optimistic state と saved result を反映する", async () => {
    const currentSession = makeAuxiliarySession({ composerDraft: "before", updatedAt: "before" });
    const saved = makeAuxiliarySession({ composerDraft: "after", updatedAt: "saved" });
    const mutationRevision = { current: 2 };
    const activeSessionRef = { current: currentSession as AuxiliarySession | null };
    const draftSaveQueueRef = { current: Promise.resolve() };
    const appliedSessions: Array<AuxiliarySession | null> = [];
    let renderedSession: AuxiliarySession | null = currentSession;
    const requests: AuxiliarySession[] = [];

    const result = await runScheduledAuxiliaryDraftSaveAndApply({
      currentSession,
      draft: "after",
      createTimestampLabel: () => "request",
      draftSaveQueue: Promise.resolve(),
      getCurrentSession: () => activeSessionRef.current,
      saveAuxiliarySession: async (request) => {
        requests.push(request);
        return saved;
      },
      mutationRevision,
      activeSessionRef,
      draftSaveQueueRef,
      setActiveSession: (sessionOrUpdater) => {
        const nextSession = typeof sessionOrUpdater === "function"
          ? sessionOrUpdater(renderedSession)
          : sessionOrUpdater;
        renderedSession = nextSession;
        appliedSessions.push(nextSession);
      },
    });

    assert.deepEqual(result, {
      request: {
        ...currentSession,
        composerDraft: "after",
        updatedAt: "request",
      },
      saved,
    });
    assert.equal(mutationRevision.current, 3);
    assert.deepEqual(activeSessionRef.current, saved);
    assert.equal(activeSessionRef.current?.messages, currentSession.messages);
    assert.equal(
      activeSessionRef.current?.allowedAdditionalDirectories,
      currentSession.allowedAdditionalDirectories,
    );
    assert.deepEqual(requests, [{
      ...currentSession,
      composerDraft: "after",
      updatedAt: "request",
    }]);
    assert.deepEqual(appliedSessions, [{
      ...currentSession,
      composerDraft: "after",
      updatedAt: "request",
    }, saved]);
  });

  it("onError がある場合は save failure を通知して伝播しない", async () => {
    const error = new Error("save failed");
    const errors: unknown[] = [];

    assert.equal(
      await runScheduledAuxiliaryDraftSaveAndApply({
        currentSession: makeAuxiliarySession(),
        draft: "after",
        createTimestampLabel: () => "request",
        draftSaveQueue: Promise.resolve(),
        getCurrentSession: () => makeAuxiliarySession({ composerDraft: "after" }),
        saveAuxiliarySession: async () => {
          throw error;
        },
        mutationRevision: { current: 0 },
        activeSessionRef: { current: makeAuxiliarySession() },
        draftSaveQueueRef: { current: Promise.resolve() },
        setActiveSession: () => undefined,
        onError: (nextError) => {
          errors.push(nextError);
        },
      }),
      null,
    );
    assert.deepEqual(errors, [error]);
  });

  it("onError がない場合は save failure を伝播する", async () => {
    const error = new Error("save failed");

    await assert.rejects(
      runScheduledAuxiliaryDraftSaveAndApply({
        currentSession: makeAuxiliarySession(),
        draft: "after",
        createTimestampLabel: () => "request",
        draftSaveQueue: Promise.resolve(),
        getCurrentSession: () => makeAuxiliarySession({ composerDraft: "after" }),
        saveAuxiliarySession: async () => {
          throw error;
        },
        mutationRevision: { current: 0 },
        activeSessionRef: { current: makeAuxiliarySession() },
        draftSaveQueueRef: { current: Promise.resolve() },
        setActiveSession: () => undefined,
      }),
      error,
    );
  });
});

describe("runAuxiliaryDraftChangeAndSaveOperation", () => {
  it("draft change の先頭 UI state を反映し、保存前提がなければ save しない", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryDraftChangeAndSaveOperation({
        draft: "after",
        selectionStart: 3,
        clearBlockedFeedback: () => {
          events.push("feedback");
        },
        setComposerCaret: (caret) => {
          events.push(`caret:${caret}`);
        },
        currentSession: null,
        createTimestampLabel: () => "request",
        draftSaveQueue: Promise.resolve(),
        getCurrentSession: () => makeAuxiliarySession(),
        saveAuxiliarySession: async () => {
          events.push("save");
          return makeAuxiliarySession();
        },
        mutationRevision: { current: 0 },
        activeSessionRef: { current: null },
        draftSaveQueueRef: { current: Promise.resolve() },
        setActiveSession: () => {
          events.push("active");
        },
      }),
      null,
    );
    assert.deepEqual(events, ["feedback", "caret:3"]);
  });

  it("draft change operation は UI state 後に scheduled save と saved result を反映する", async () => {
    const currentSession = makeAuxiliarySession({ composerDraft: "before", updatedAt: "before" });
    const saved = makeAuxiliarySession({ composerDraft: "after", updatedAt: "saved" });
    const mutationRevision = { current: 2 };
    const activeSessionRef = { current: currentSession as AuxiliarySession | null };
    const draftSaveQueueRef = { current: Promise.resolve() };
    const events: string[] = [];
    let renderedSession: AuxiliarySession | null = currentSession;

    const result = await runAuxiliaryDraftChangeAndSaveOperation({
      draft: "after",
      selectionStart: 5,
      clearBlockedFeedback: () => {
        events.push("feedback");
      },
      setComposerCaret: (caret) => {
        events.push(`caret:${caret}`);
      },
      currentSession,
      createTimestampLabel: () => "request",
      draftSaveQueue: Promise.resolve(),
      getCurrentSession: () => activeSessionRef.current,
      saveAuxiliarySession: async (request) => {
        events.push(`save:${request.composerDraft}`);
        return saved;
      },
      mutationRevision,
      activeSessionRef,
      draftSaveQueueRef,
      setActiveSession: (sessionOrUpdater) => {
        renderedSession = typeof sessionOrUpdater === "function"
          ? sessionOrUpdater(renderedSession)
          : sessionOrUpdater;
        events.push(`active:${renderedSession?.composerDraft ?? "none"}`);
      },
    });

    assert.deepEqual(result, {
      request: {
        ...currentSession,
        composerDraft: "after",
        updatedAt: "request",
      },
      saved,
    });
    assert.equal(mutationRevision.current, 3);
    assert.deepEqual(activeSessionRef.current, saved);
    assert.equal(activeSessionRef.current?.messages, currentSession.messages);
    assert.equal(
      activeSessionRef.current?.allowedAdditionalDirectories,
      currentSession.allowedAdditionalDirectories,
    );
    assert.deepEqual(events, ["feedback", "caret:5", "active:after", "save:after", "active:after"]);
  });
});
