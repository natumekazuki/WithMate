import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyScheduledAuxiliaryDraftSaveUiState,
  areStringArraysEqual,
  hasSameAuxiliaryDraftSaveContext,
  resolveAppliedAuxiliaryDraftSaveResult,
  resolveAuxiliaryDraftSaveOperationResult,
  resolveAuxiliaryDraftSaveResult,
  runAuxiliaryDraftPatchOperation,
  runAuxiliaryDraftSaveOperation,
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

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved), saved);
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

    assert.equal(next, saved);
    assert.equal(activeSessionRef.current, saved);
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
