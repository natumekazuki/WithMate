import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enqueueAuxiliarySessionSaveOperation,
  enqueueAuxiliarySessionSaveWithQueue,
  resolveAuxiliarySessionRollbackSession,
  runGuardedAuxiliarySessionUpdate,
  runAuxiliarySessionUpdateOperation,
  type AuxiliarySessionUpdateOperationResult,
} from "../../src/auxiliary-session-update-operation.js";
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
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

function createDeferredSave() {
  let resolve!: (session: AuxiliarySession) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AuxiliarySession>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushQueuedOperationStart(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("runAuxiliarySessionUpdateOperation", () => {
  it("pending session を保存前に反映して保存結果を返す", async () => {
    const active = makeAuxiliarySession({ composerDraft: "before" });
    const saved = makeAuxiliarySession({ composerDraft: "after", updatedAt: "saved" });
    const events: string[] = [];

    assert.deepEqual(
      await runAuxiliarySessionUpdateOperation({
        activeSession: active,
        currentSession: active,
        recipe: (current) => ({ ...current, composerDraft: "after", updatedAt: "pending" }),
        applyPendingSession: (session) => {
          events.push(`pending:${session.composerDraft}:${session.updatedAt}`);
        },
        rollbackPendingSession: () => {
          events.push("rollback");
        },
        saveAuxiliarySession: async (session) => {
          events.push(`save:${session.composerDraft}:${session.updatedAt}`);
          return saved;
        },
      }),
      {
        nextSession: makeAuxiliarySession({ composerDraft: "after", updatedAt: "pending" }),
        saved,
      },
    );
    assert.deepEqual(events, ["pending:after:pending", "save:after:pending"]);
  });

  it("編集対象が変わった場合は pending 反映も保存もしない", async () => {
    let applied = false;
    let saved = false;

    assert.equal(
      await runAuxiliarySessionUpdateOperation({
        activeSession: makeAuxiliarySession({ id: "aux-1" }),
        currentSession: makeAuxiliarySession({ id: "aux-2" }),
        recipe: (current) => ({ ...current, composerDraft: "after" }),
        applyPendingSession: () => {
          applied = true;
        },
        rollbackPendingSession: () => undefined,
        saveAuxiliarySession: async (session) => {
          saved = true;
          return session;
        },
      }),
      null,
    );
    assert.equal(applied, false);
    assert.equal(saved, false);
  });

  it("保存に失敗した場合は rollback して例外を伝播する", async () => {
    const error = new Error("save failed");
    const active = makeAuxiliarySession({ composerDraft: "before" });
    let rollbackInput: {
      error: unknown;
      pendingSession: AuxiliarySession;
      previousSession: AuxiliarySession;
    } | null = null;

    await assert.rejects(
      runAuxiliarySessionUpdateOperation({
        activeSession: active,
        currentSession: active,
        recipe: (current) => ({ ...current, composerDraft: "after" }),
        applyPendingSession: () => undefined,
        rollbackPendingSession: (input) => {
          rollbackInput = input;
        },
        saveAuxiliarySession: async () => {
          throw error;
        },
      }),
      error,
    );
    assert.deepEqual(rollbackInput, {
      error,
      pendingSession: makeAuxiliarySession({ composerDraft: "after" }),
      previousSession: active,
    });
  });

  it("保存 pending 中の連続 update は直前の pending session を base にする", async () => {
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    const saveOperations: Array<{
      request: AuxiliarySession;
      reject: (error: unknown) => void;
      resolve: (session: AuxiliarySession) => void;
    }> = [];
    const update = async (
      recipe: (current: AuxiliarySession) => AuxiliarySession,
    ): Promise<AuxiliarySessionUpdateOperationResult> => {
      let operationRevision = updateRevision;
      const result = await runAuxiliarySessionUpdateOperation({
        activeSession: currentSession,
        currentSession,
        recipe,
        applyPendingSession: (session) => {
          operationRevision = updateRevision + 1;
          updateRevision = operationRevision;
          currentSession = session;
        },
        rollbackPendingSession: ({ previousSession }) => {
          if (updateRevision === operationRevision) {
            currentSession = previousSession;
          }
        },
        saveAuxiliarySession: (session) => {
          const deferred = createDeferredSave();
          saveOperations.push({ request: session, reject: deferred.reject, resolve: deferred.resolve });
          return deferred.promise;
        },
      });
      if (result && updateRevision === operationRevision) {
        currentSession = result.saved;
      }
      return result;
    };

    const firstUpdate = update((current) => ({
      ...current,
      approvalMode: "on-request",
      updatedAt: "first-pending",
    }));
    assert.equal(currentSession.approvalMode, "on-request");

    const secondUpdate = update((current) => ({
      ...current,
      codexSandboxMode: "workspace-write",
      updatedAt: "second-pending",
    }));

    assert.equal(saveOperations.length, 2);
    assert.equal(saveOperations[1].request.approvalMode, "on-request");
    assert.equal(saveOperations[1].request.codexSandboxMode, "workspace-write");

    saveOperations[0].resolve(makeAuxiliarySession({
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write-network",
      updatedAt: "first-saved",
    }));
    await firstUpdate;
    assert.equal(currentSession.updatedAt, "second-pending");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");

    saveOperations[1].resolve(makeAuxiliarySession({
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
      updatedAt: "second-saved",
    }));
    await secondUpdate;
    assert.equal(currentSession.updatedAt, "second-saved");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");
  });

  it("保存 pending 中に refresh が旧 object を反映しても同じ update revision なら saved を反映する", async () => {
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    let operationRevision = updateRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      applyPendingSession: (session) => {
        operationRevision = updateRevision + 1;
        updateRevision = operationRevision;
        currentSession = session;
      },
      rollbackPendingSession: ({ previousSession }) => {
        if (updateRevision === operationRevision) {
          currentSession = previousSession;
        }
      },
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (result && updateRevision === operationRevision) {
        currentSession = result.saved;
      }
      return result;
    });

    assert.equal(currentSession.approvalMode, "on-request");
    currentSession = makeAuxiliarySession({ approvalMode: "untrusted", updatedAt: "refresh-before-save" });

    deferred.resolve(makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }));
    await update;

    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.updatedAt, "saved");
  });

  it("active session が外れた後の保存成功は session を復活させない", async () => {
    const activeSession = makeAuxiliarySession();
    let currentSession: AuxiliarySession | null = activeSession;
    let updateRevision = 0;
    let operationRevision = updateRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession,
      currentSession,
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      applyPendingSession: (session) => {
        operationRevision = updateRevision + 1;
        updateRevision = operationRevision;
        currentSession = session;
      },
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (updateRevision === operationRevision && currentSession?.id === pendingSession.id) {
          currentSession = previousSession;
        }
      },
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (result && updateRevision === operationRevision && currentSession?.id === result.saved.id) {
        currentSession = result.saved;
      }
      return result;
    });

    currentSession = null;
    deferred.resolve(makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }));
    await update;

    assert.equal(currentSession, null);
  });

  it("同じ session の後続 local mutation 後の保存成功は current を上書きしない", async () => {
    let currentSession = makeAuxiliarySession();
    let mutationRevision = 0;
    let operationRevision = mutationRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      applyPendingSession: (session) => {
        operationRevision = mutationRevision + 1;
        mutationRevision = operationRevision;
        currentSession = session;
      },
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (mutationRevision === operationRevision && currentSession.id === pendingSession.id) {
          currentSession = previousSession;
        }
      },
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (result && mutationRevision === operationRevision && currentSession.id === result.saved.id) {
        currentSession = result.saved;
      }
      return result;
    });

    mutationRevision += 1;
    currentSession = makeAuxiliarySession({
      approvalMode: "on-request",
      runState: "running",
      updatedAt: "running",
    });
    deferred.resolve(makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }));
    await update;

    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running");
  });

  it("同じ session の後続 local mutation 後の保存失敗は current を rollback しない", async () => {
    const error = new Error("save failed");
    let currentSession = makeAuxiliarySession();
    let mutationRevision = 0;
    let operationRevision = mutationRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      applyPendingSession: (session) => {
        operationRevision = mutationRevision + 1;
        mutationRevision = operationRevision;
        currentSession = session;
      },
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (mutationRevision === operationRevision && currentSession.id === pendingSession.id) {
          currentSession = previousSession;
        }
      },
      saveAuxiliarySession: () => deferred.promise,
    });

    mutationRevision += 1;
    currentSession = makeAuxiliarySession({
      approvalMode: "on-request",
      runState: "running",
      updatedAt: "running",
    });
    deferred.reject(error);
    await assert.rejects(update, error);

    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running");
  });

  it("古い保存失敗は新しい pending session を rollback しない", async () => {
    const error = new Error("first save failed");
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    const saveOperations: Array<{
      request: AuxiliarySession;
      reject: (error: unknown) => void;
      resolve: (session: AuxiliarySession) => void;
    }> = [];
    const update = async (
      recipe: (current: AuxiliarySession) => AuxiliarySession,
    ): Promise<AuxiliarySessionUpdateOperationResult> => {
      let operationRevision = updateRevision;
      const result = await runAuxiliarySessionUpdateOperation({
        activeSession: currentSession,
        currentSession,
        recipe,
        applyPendingSession: (session) => {
          operationRevision = updateRevision + 1;
          updateRevision = operationRevision;
          currentSession = session;
        },
        rollbackPendingSession: ({ previousSession }) => {
          if (updateRevision === operationRevision) {
            currentSession = previousSession;
          }
        },
        saveAuxiliarySession: (session) => {
          const deferred = createDeferredSave();
          saveOperations.push({ request: session, reject: deferred.reject, resolve: deferred.resolve });
          return deferred.promise;
        },
      });
      if (result && updateRevision === operationRevision) {
        currentSession = result.saved;
      }
      return result;
    };

    const firstUpdate = update((current) => ({
      ...current,
      approvalMode: "on-request",
      updatedAt: "first-pending",
    }));
    const secondUpdate = update((current) => ({
      ...current,
      codexSandboxMode: "workspace-write",
      updatedAt: "second-pending",
    }));

    saveOperations[0].reject(error);
    await assert.rejects(firstUpdate, error);
    assert.equal(currentSession.updatedAt, "second-pending");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");

    saveOperations[1].resolve(makeAuxiliarySession({
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
      updatedAt: "second-saved",
    }));
    await secondUpdate;
    assert.equal(currentSession.updatedAt, "second-saved");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");
  });
});

describe("runGuardedAuxiliarySessionUpdate", () => {
  it("active session がない場合は draft queue を待たずに何もしない", async () => {
    let draftQueueWaited = false;
    const draftSaveQueue = {
      current: new Promise<void>((resolve) => {
        setTimeout(() => {
          draftQueueWaited = true;
          resolve();
        }, 20);
      }),
    };
    let saved = false;

    assert.equal(
      await runGuardedAuxiliarySessionUpdate({
        activeSession: null,
        getCurrentSession: () => null,
        applyActiveSession: () => undefined,
        draftSaveQueue,
        sessionSaveQueue: { current: Promise.resolve() },
        mutationRevision: { current: 0 },
        recipe: (current) => current,
        getAuxiliarySession: async () => null,
        saveAuxiliarySession: async (session) => {
          saved = true;
          return session;
        },
      }),
      null,
    );
    assert.equal(saved, false);
    assert.equal(draftQueueWaited, false);
  });

  it("draft queue 後に pending を反映し、session save queue 経由で保存結果を反映する", async () => {
    let releaseDraftQueue = () => {};
    const draftSaveQueue = {
      current: new Promise<void>((resolve) => {
        releaseDraftQueue = resolve;
      }),
    };
    const sessionSaveQueue = { current: Promise.resolve() };
    const mutationRevision = { current: 0 };
    let currentSession: AuxiliarySession | null = makeAuxiliarySession({ approvalMode: "untrusted" });
    const events: string[] = [];
    const update = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      getCurrentSession: () => currentSession,
      applyActiveSession: (session) => {
        currentSession = session;
        events.push(`${session.approvalMode}:${session.updatedAt}`);
      },
      draftSaveQueue,
      sessionSaveQueue,
      mutationRevision,
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      getAuxiliarySession: async () => null,
      saveAuxiliarySession: async (session) => ({
        ...session,
        updatedAt: "saved",
      }),
    });

    assert.deepEqual(events, []);
    releaseDraftQueue();
    assert.deepEqual(await update, {
      nextSession: makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "pending" }),
      saved: makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }),
    });
    assert.deepEqual(events, ["on-request:pending", "on-request:saved"]);
    assert.equal(currentSession?.updatedAt, "saved");
    await sessionSaveQueue.current;
  });

  it("保存失敗時は保存済み session を revision/id guard の範囲で rollback に使う", async () => {
    const error = new Error("save failed");
    const activeSession = makeAuxiliarySession({ approvalMode: "untrusted", updatedAt: "previous" });
    let currentSession: AuxiliarySession | null = activeSession;
    const savedRollbackSession = makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "storage" });

    await assert.rejects(
      runGuardedAuxiliarySessionUpdate({
        activeSession,
        getCurrentSession: () => currentSession,
        applyActiveSession: (session) => {
          currentSession = session;
        },
        draftSaveQueue: { current: Promise.resolve() },
        sessionSaveQueue: { current: Promise.resolve() },
        mutationRevision: { current: 0 },
        recipe: (current) => ({
          ...current,
          approvalMode: "on-request",
          updatedAt: "pending",
        }),
        getAuxiliarySession: async () => savedRollbackSession,
        saveAuxiliarySession: async () => {
          throw error;
        },
      }),
      error,
    );

    assert.equal(currentSession, savedRollbackSession);
  });

  it("後続 mutation 後の保存成功と保存失敗 rollback は current を上書きしない", async () => {
    const error = new Error("save failed");
    const mutationRevision = { current: 0 };
    let currentSession: AuxiliarySession | null = makeAuxiliarySession();
    const success = createDeferredSave();
    const successUpdate = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      getCurrentSession: () => currentSession,
      applyActiveSession: (session) => {
        currentSession = session;
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision,
      recipe: (current) => ({ ...current, approvalMode: "on-request", updatedAt: "pending" }),
      getAuxiliarySession: async () => null,
      saveAuxiliarySession: () => success.promise,
    });

    await flushQueuedOperationStart();
    mutationRevision.current += 1;
    currentSession = makeAuxiliarySession({ approvalMode: "on-request", runState: "running", updatedAt: "running" });
    success.resolve(makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }));
    await successUpdate;
    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running");

    currentSession = makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "idle-before-failure" });
    const failure = createDeferredSave();
    const failureUpdate = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      getCurrentSession: () => currentSession,
      applyActiveSession: (session) => {
        currentSession = session;
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision,
      recipe: (current) => ({ ...current, codexSandboxMode: "workspace-write", updatedAt: "pending-2" }),
      getAuxiliarySession: async () => makeAuxiliarySession({ updatedAt: "storage" }),
      saveAuxiliarySession: () => failure.promise,
    });
    await flushQueuedOperationStart();
    mutationRevision.current += 1;
    currentSession = makeAuxiliarySession({ approvalMode: "on-request", runState: "running", updatedAt: "running-2" });
    failure.reject(error);
    await assert.rejects(failureUpdate, error);
    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running-2");
  });
});

describe("resolveAuxiliarySessionRollbackSession", () => {
  it("保存済み session を取得できた場合は保存済み session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });
    const pendingSession = makeAuxiliarySession({ updatedAt: "pending" });
    const savedSession = makeAuxiliarySession({ updatedAt: "saved" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession,
        previousSession,
        getAuxiliarySession: async () => savedSession,
      }),
      savedSession,
    );
  });

  it("保存済み session がない場合は previous session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession: makeAuxiliarySession({ updatedAt: "pending" }),
        previousSession,
        getAuxiliarySession: async () => null,
      }),
      previousSession,
    );
  });

  it("保存済み session の取得に失敗した場合は previous session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession: makeAuxiliarySession({ updatedAt: "pending" }),
        previousSession,
        getAuxiliarySession: async () => {
          throw new Error("load failed");
        },
      }),
      previousSession,
    );
  });
});

describe("enqueueAuxiliarySessionSaveOperation", () => {
  it("保存 operation を queue 順に実行する", async () => {
    let queue = Promise.resolve();
    const events: string[] = [];
    const first = createDeferredSave();
    const second = createDeferredSave();

    const firstSave = enqueueAuxiliarySessionSaveOperation(queue, () => {
      events.push("start:first");
      return first.promise;
    });
    queue = firstSave.queue;
    const secondSave = enqueueAuxiliarySessionSaveOperation(queue, () => {
      events.push("start:second");
      return second.promise;
    });
    queue = secondSave.queue;

    await flushQueuedOperationStart();
    assert.deepEqual(events, ["start:first"]);

    first.resolve(makeAuxiliarySession({ updatedAt: "first" }));
    assert.equal((await firstSave.operation).updatedAt, "first");
    await flushQueuedOperationStart();
    assert.deepEqual(events, ["start:first", "start:second"]);

    second.resolve(makeAuxiliarySession({ updatedAt: "second" }));
    assert.equal((await secondSave.operation).updatedAt, "second");
    await queue;
  });

  it("前の保存が失敗しても次の保存を実行する", async () => {
    let queue = Promise.resolve();
    const events: string[] = [];
    const first = createDeferredSave();
    const second = createDeferredSave();

    const firstSave = enqueueAuxiliarySessionSaveOperation(queue, () => {
      events.push("start:first");
      return first.promise;
    });
    queue = firstSave.queue;
    const secondSave = enqueueAuxiliarySessionSaveOperation(queue, () => {
      events.push("start:second");
      return second.promise;
    });
    queue = secondSave.queue;

    const error = new Error("first failed");
    await flushQueuedOperationStart();
    first.reject(error);
    await assert.rejects(firstSave.operation, error);
    await flushQueuedOperationStart();
    assert.deepEqual(events, ["start:first", "start:second"]);

    second.resolve(makeAuxiliarySession({ updatedAt: "second" }));
    assert.equal((await secondSave.operation).updatedAt, "second");
    await queue;
  });
});

describe("enqueueAuxiliarySessionSaveWithQueue", () => {
  it("queue ref を更新しながら保存 operation を queue 順に実行する", async () => {
    const queueRef = { current: Promise.resolve() };
    const events: string[] = [];
    const first = createDeferredSave();
    const second = createDeferredSave();

    const firstOperation = enqueueAuxiliarySessionSaveWithQueue(queueRef, () => {
      events.push("start:first");
      return first.promise;
    });
    const queueAfterFirst = queueRef.current;
    const secondOperation = enqueueAuxiliarySessionSaveWithQueue(queueRef, () => {
      events.push("start:second");
      return second.promise;
    });

    assert.notEqual(queueRef.current, queueAfterFirst);
    await flushQueuedOperationStart();
    assert.deepEqual(events, ["start:first"]);

    first.resolve(makeAuxiliarySession({ updatedAt: "first" }));
    assert.equal((await firstOperation).updatedAt, "first");
    await flushQueuedOperationStart();
    assert.deepEqual(events, ["start:first", "start:second"]);

    second.resolve(makeAuxiliarySession({ updatedAt: "second" }));
    assert.equal((await secondOperation).updatedAt, "second");
    await queueRef.current;
  });
});
