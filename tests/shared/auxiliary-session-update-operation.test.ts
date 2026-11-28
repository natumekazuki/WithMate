import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveOperation,
  enqueueAuxiliarySessionSaveWithQueue,
  resolveAuxiliarySessionRollbackSession,
  runGuardedAuxiliarySessionUpdate,
  runAuxiliarySessionUpdateOperation,
  syncActiveAuxiliarySessionRef,
  type AuxiliarySessionUpdateOperationResult,
} from "../../src/chat/auxiliary/auxiliary-session-update-operation.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

/** 共通の実行設定を持つ Auxiliary を作り、編集中と保存済みの値などケースの差分だけを上書きできるようにする。 */
function makeAuxiliarySession(
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    runState: "idle",
    title: "Auxiliary",
    provider: "copilot",
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write-network",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "thread-1",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** 保存の成功・失敗をテスト側で決められる Promise と、その解決・拒否関数を返す。 */
function createDeferredSave() {
  let resolve!: (session: AuxiliarySession) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AuxiliarySession>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, reject, resolve };
}

/** 次のタスクまで待ち、キューに積まれた保存の開始と保存完了を分けて観測する。 */
async function flushQueuedOperationStart(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Auxiliary の更新要求が、現在の選択・仮反映・保存・復元の境界を守ることを確認する。 */
describe("runAuxiliarySessionUpdateOperation", () => {
  /** 保存を始める前に新しい下書きを仮反映し、結果には仮の Session と保存済み値を別々に返す。 */
  it("pending session を保存前に反映して保存結果を返す", async () => {
    const active = makeAuxiliarySession({ composerDraft: "before" });
    const saved = makeAuxiliarySession({
      composerDraft: "after",
      updatedAt: "saved",
    });
    const events: string[] = [];

    assert.deepEqual(
      await runAuxiliarySessionUpdateOperation({
        activeSession: active,
        currentSession: active,
        /** 編集中の Session を基に、新しい下書きと保存前の更新時刻を作る。 */
        recipe: (current) => ({
          ...current,
          composerDraft: "after",
          updatedAt: "pending",
        }),
        /** 仮反映に使う下書きと時刻を、保存イベントの前に記録する。 */
        applyPendingSession: (session) => {
          events.push(`pending:${session.composerDraft}:${session.updatedAt}`);
        },
        /** 保存成功時に誤って復元を実行した場合を記録する。 */
        rollbackPendingSession: () => {
          events.push("rollback");
        },
        /** 永続化へ渡った仮の値を記録し、別の更新時刻を持つ保存済み値を返す。 */
        saveAuxiliarySession: async (session) => {
          events.push(`save:${session.composerDraft}:${session.updatedAt}`);
          return saved;
        },
      }),
      {
        nextSession: makeAuxiliarySession({
          composerDraft: "after",
          updatedAt: "pending",
        }),
        saved,
      },
    );
    assert.deepEqual(events, ["pending:after:pending", "save:after:pending"]);
  });

  /** 捕捉した編集対象と現在の対象が異なれば、仮反映と保存のどちらも始めず null を返す。 */
  it("編集対象が変わった場合は pending 反映も保存もしない", async () => {
    let applied = false;
    let saved = false;

    assert.equal(
      await runAuxiliarySessionUpdateOperation({
        activeSession: makeAuxiliarySession({ id: "aux-1" }),
        currentSession: makeAuxiliarySession({ id: "aux-2" }),
        /** 誤って更新へ進んだ場合に仮反映される下書きの値を作る。 */
        recipe: (current) => ({ ...current, composerDraft: "after" }),
        /** 対象変更を見落として表示へ反映した場合をフラグで検出する。 */
        applyPendingSession: () => {
          applied = true;
        },
        /** 対象違いのケースでは復元を操作せず、仮反映と保存の呼び出しだけを検証する。 */
        rollbackPendingSession: () => undefined,
        /** 対象変更後も保存が始まった場合をフラグで検出する。 */
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

  /** 保存に失敗したら、元のエラーと仮反映前後の値を復元へ渡し、元の例外を呼び出し元にも返す。 */
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
        /** 保存を試みる新しい下書きを生成する。 */
        recipe: (current) => ({ ...current, composerDraft: "after" }),
        /** このケースでは表示を操作せず、保存失敗後に送られる復元入力を観測する。 */
        applyPendingSession: () => undefined,
        /** 復元先・仮反映された値・失敗の原因をまとめて記録する。 */
        rollbackPendingSession: (input) => {
          rollbackInput = input;
        },
        /** 復元に渡るエラーが保存時のエラーと同じか検証できるよう、捕捉済みの例外を投げる。 */
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

  /** 一件目の保存が未完了でも二件目は仮反映後の値を基にし、一件目の保存応答では二件目の表示を戻さない。 */
  it("保存 pending 中の連続 update は直前の pending session を base にする", async () => {
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    const saveOperations: Array<{
      request: AuxiliarySession;
      reject: (error: unknown) => void;
      resolve: (session: AuxiliarySession) => void;
    }> = [];
    /** 共通の Session に変更を適用し、最後に仮反映したリビジョンだけが結果を更新する fixture を実行する。 */
    const update = async (
      recipe: (current: AuxiliarySession) => AuxiliarySession,
    ): Promise<AuxiliarySessionUpdateOperationResult> => {
      let operationRevision = updateRevision;
      const result = await runAuxiliarySessionUpdateOperation({
        activeSession: currentSession,
        currentSession,
        recipe,
        /** 仮反映のたびにリビジョンを進め、次の更新が使う値を置き換える。 */
        applyPendingSession: (session) => {
          operationRevision = updateRevision + 1;
          updateRevision = operationRevision;
          currentSession = session;
        },
        /** この保存が最新の更新である間だけ、仮反映前の値を復元する。 */
        rollbackPendingSession: ({ previousSession }) => {
          if (updateRevision === operationRevision) {
            currentSession = previousSession;
          }
        },
        /** 各保存の入力と完了手段を独立に保持し、応答順をテスト側で制御する。 */
        saveAuxiliarySession: (session) => {
          const deferred = createDeferredSave();
          saveOperations.push({
            request: session,
            reject: deferred.reject,
            resolve: deferred.resolve,
          });
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

    saveOperations[0].resolve(
      makeAuxiliarySession({
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write-network",
        updatedAt: "first-saved",
      }),
    );
    await firstUpdate;
    assert.equal(currentSession.updatedAt, "second-pending");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");

    saveOperations[1].resolve(
      makeAuxiliarySession({
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write",
        updatedAt: "second-saved",
      }),
    );
    await secondUpdate;
    assert.equal(currentSession.updatedAt, "second-saved");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");
  });

  /** 更新リビジョンが同じなら、保存中の再取得で表示オブジェクトが差し替わっても保存された承認値を採用する。 */
  it("保存 pending 中に refresh が旧 object を反映しても同じ update revision なら saved を反映する", async () => {
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    let operationRevision = updateRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      /** 再取得された元の値と区別できる承認方針と仮時刻を生成する。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 保存開始前に仮の承認方針を反映し、その更新リビジョンを記録する。 */
      applyPendingSession: (session) => {
        operationRevision = updateRevision + 1;
        updateRevision = operationRevision;
        currentSession = session;
      },
      /** 保存処理が有効なリビジョンである場合のみ、再取得とは別に復元を許す。 */
      rollbackPendingSession: ({ previousSession }) => {
        if (updateRevision === operationRevision) {
          currentSession = previousSession;
        }
      },
      /** 古い表示の再取得が済むまで、保存の返却を保留する。 */
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (result && updateRevision === operationRevision) {
        currentSession = result.saved;
      }
      return result;
    });

    assert.equal(currentSession.approvalMode, "on-request");
    currentSession = makeAuxiliarySession({
      approvalMode: "untrusted",
      updatedAt: "refresh-before-save",
    });

    deferred.resolve(
      makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }),
    );
    await update;

    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.updatedAt, "saved");
  });

  /** 仮反映後に現在の Auxiliary がなくなった場合、遅れて成功した保存で画面に復活させない。 */
  it("active session が外れた後の保存成功は session を復活させない", async () => {
    const activeSession = makeAuxiliarySession();
    let currentSession: AuxiliarySession | null = activeSession;
    let updateRevision = 0;
    let operationRevision = updateRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession,
      currentSession,
      /** 選択中に承認を変え、保存前と保存後を区別できる仮時刻を設定する。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 選択解除前の仮反映リビジョンと Session を記録する。 */
      applyPendingSession: (session) => {
        operationRevision = updateRevision + 1;
        updateRevision = operationRevision;
        currentSession = session;
      },
      /** 復元できるのはリビジョンと現在対象の ID が同じ場合だけとする。 */
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (
          updateRevision === operationRevision &&
          currentSession?.id === pendingSession.id
        ) {
          currentSession = previousSession;
        }
      },
      /** 選択を解除した後に保存を完了させるため、応答を保留する。 */
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (
        result &&
        updateRevision === operationRevision &&
        currentSession?.id === result.saved.id
      ) {
        currentSession = result.saved;
      }
      return result;
    });

    currentSession = null;
    deferred.resolve(
      makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }),
    );
    await update;

    assert.equal(currentSession, null);
  });

  /** 同じ Auxiliary でも、承認保存後に届いた実行中のローカル状態を、保存成功の応答で上書きしない。 */
  it("同じ session の後続 local mutation 後の保存成功は current を上書きしない", async () => {
    let currentSession = makeAuxiliarySession();
    let mutationRevision = 0;
    let operationRevision = mutationRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      /** 実行開始と独立した承認更新を、保留中として組み立てる。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 仮反映された値を適用し、後の実行開始との順序を示すリビジョンを保持する。 */
      applyPendingSession: (session) => {
        operationRevision = mutationRevision + 1;
        mutationRevision = operationRevision;
        currentSession = session;
      },
      /** 現在の ID と変更リビジョンが保存時の値に一致する場合だけ復元する。 */
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (
          mutationRevision === operationRevision &&
          currentSession.id === pendingSession.id
        ) {
          currentSession = previousSession;
        }
      },
      /** 後続のローカル変更後に成功を返せるよう、保存完了を保留する。 */
      saveAuxiliarySession: () => deferred.promise,
    }).then((result) => {
      if (
        result &&
        mutationRevision === operationRevision &&
        currentSession.id === result.saved.id
      ) {
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
    deferred.resolve(
      makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }),
    );
    await update;

    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running");
  });

  /** 同じ Auxiliary に新しい実行状態が入った後、古い承認保存の失敗は伝えるが、新しい表示状態は戻さない。 */
  it("同じ session の後続 local mutation 後の保存失敗は current を rollback しない", async () => {
    const error = new Error("save failed");
    let currentSession = makeAuxiliarySession();
    let mutationRevision = 0;
    let operationRevision = mutationRevision;
    const deferred = createDeferredSave();

    const update = runAuxiliarySessionUpdateOperation({
      activeSession: currentSession,
      currentSession,
      /** 失敗させる前に承認変更を仮反映できる値を作る。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 保存の前に更新リビジョンを記録し、後から入る実行状態までの順序を作る。 */
      applyPendingSession: (session) => {
        operationRevision = mutationRevision + 1;
        mutationRevision = operationRevision;
        currentSession = session;
      },
      /** 失敗した保存に復元の権限が残っている場合だけ、以前の状態へ戻す。 */
      rollbackPendingSession: ({ pendingSession, previousSession }) => {
        if (
          mutationRevision === operationRevision &&
          currentSession.id === pendingSession.id
        ) {
          currentSession = previousSession;
        }
      },
      /** 実行中への変更後に失敗できるよう、保存応答を遅延させる。 */
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

  /** 先に要求した保存が失敗しても後続更新の仮反映は維持され、後続保存の結果でのみ確定する。 */
  it("古い保存失敗は新しい pending session を rollback しない", async () => {
    const error = new Error("first save failed");
    let currentSession = makeAuxiliarySession();
    let updateRevision = 0;
    const saveOperations: Array<{
      request: AuxiliarySession;
      reject: (error: unknown) => void;
      resolve: (session: AuxiliarySession) => void;
    }> = [];
    /** 更新の開始時点から完了までリビジョンを追い、並行保存中の表示の結果を観測する。 */
    const update = async (
      recipe: (current: AuxiliarySession) => AuxiliarySession,
    ): Promise<AuxiliarySessionUpdateOperationResult> => {
      let operationRevision = updateRevision;
      const result = await runAuxiliarySessionUpdateOperation({
        activeSession: currentSession,
        currentSession,
        recipe,
        /** 後続更新を新しいリビジョンとして適用し、古い失敗と区別する。 */
        applyPendingSession: (session) => {
          operationRevision = updateRevision + 1;
          updateRevision = operationRevision;
          currentSession = session;
        },
        /** 失敗した保存がその時点でも最新の場合だけ、直前の値を復元する。 */
        rollbackPendingSession: ({ previousSession }) => {
          if (updateRevision === operationRevision) {
            currentSession = previousSession;
          }
        },
        /** 古い保存だけを失敗させ、新しい保存は成功できるよう、それぞれの応答を個別に保持する。 */
        saveAuxiliarySession: (session) => {
          const deferred = createDeferredSave();
          saveOperations.push({
            request: session,
            reject: deferred.reject,
            resolve: deferred.resolve,
          });
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

    saveOperations[1].resolve(
      makeAuxiliarySession({
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write",
        updatedAt: "second-saved",
      }),
    );
    await secondUpdate;
    assert.equal(currentSession.updatedAt, "second-saved");
    assert.equal(currentSession.approvalMode, "on-request");
    assert.equal(currentSession.codexSandboxMode, "workspace-write");
  });
});

/** 下書きと Session の保存キューを経由する更新で、表示対象と更新順を守ることを確認する。 */
describe("runGuardedAuxiliarySessionUpdate", () => {
  /** 現在の Auxiliary がなければ、保留中の下書き保存を待たずに null を返し、Session の保存は起こさない。 */
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
        /** 変更を適用できる表示対象が存在しない状態を返す。 */
        getCurrentSession: () => null,
        /** このケースでは仮反映に使う対象が存在せず、表示側の処理を行わない。 */
        applyActiveSession: () => undefined,
        draftSaveQueue,
        sessionSaveQueue: { current: Promise.resolve() },
        mutationRevision: { current: 0 },
        /** 現在の値があっても内容自体は変更しないレシピを渡す。 */
        recipe: (current) => current,
        /** 復元に使える保存済みの値もない状態にする。 */
        getAuxiliarySession: async () => null,
        /** 対象がないのに保存まで進んだ場合をフラグで検出する。 */
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

  /** 先行する下書き保存が終わるまで反映を開始せず、その後に仮状態と保存済み状態を順に適用する。 */
  it("draft queue 後に pending を反映し、session save queue 経由で保存結果を反映する", async () => {
    /** 下書き保存の待機を解除する関数を取得し、更新開始の前後を検証する。 */
    let releaseDraftQueue = () => {};
    const draftSaveQueue = {
      current: new Promise<void>((resolve) => {
        releaseDraftQueue = resolve;
      }),
    };
    const sessionSaveQueue = { current: Promise.resolve() };
    const mutationRevision = { current: 0 };
    let currentSession: AuxiliarySession | null = makeAuxiliarySession({
      approvalMode: "untrusted",
    });
    const events: string[] = [];
    const update = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      /** 仮反映や保存済み値を適用するときに、現在の Session を見直せるようにする。 */
      getCurrentSession: () => currentSession,
      /** 表示に適用された承認方針と更新時刻を時系列に記録する。 */
      applyActiveSession: (session) => {
        currentSession = session;
        events.push(`${session.approvalMode}:${session.updatedAt}`);
      },
      draftSaveQueue,
      sessionSaveQueue,
      mutationRevision,
      /** 下書き保存の解放後に適用する承認変更と仮時刻を設定する。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 成功する更新なので、復元用には何も提供しない。 */
      getAuxiliarySession: async () => null,
      /** 仮反映値を保存済みの時刻に更新して返し、二段階の反映を区別できるようにする。 */
      saveAuxiliarySession: async (session) => ({
        ...session,
        updatedAt: "saved",
      }),
    });

    assert.deepEqual(events, []);
    releaseDraftQueue();
    assert.deepEqual(await update, {
      nextSession: makeAuxiliarySession({
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      saved: makeAuxiliarySession({
        approvalMode: "on-request",
        updatedAt: "saved",
      }),
    });
    assert.deepEqual(events, ["on-request:pending", "on-request:saved"]);
    assert.equal(currentSession?.updatedAt, "saved");
    await sessionSaveQueue.current;
  });

  /** 保存失敗時は、対象とリビジョンが変わっていなければ仮反映前の値ではなく保存済みの Session へ復元する。 */
  it("保存失敗時は保存済み session を revision/id guard の範囲で rollback に使う", async () => {
    const error = new Error("save failed");
    const activeSession = makeAuxiliarySession({
      approvalMode: "untrusted",
      updatedAt: "previous",
    });
    let currentSession: AuxiliarySession | null = activeSession;
    const savedRollbackSession = makeAuxiliarySession({
      approvalMode: "on-request",
      updatedAt: "storage",
    });

    await assert.rejects(
      runGuardedAuxiliarySessionUpdate({
        activeSession,
        /** 仮反映中か復元済みかを区別できる現在の表示対象を返す。 */
        getCurrentSession: () => currentSession,
        /** 更新関数から渡された Session を、画面側で現在使っている値として採用する。 */
        applyActiveSession: (session) => {
          currentSession = session;
        },
        draftSaveQueue: { current: Promise.resolve() },
        sessionSaveQueue: { current: Promise.resolve() },
        mutationRevision: { current: 0 },
        /** 失敗後に置き換わる仮の承認値と時刻を設定する。 */
        recipe: (current) => ({
          ...current,
          approvalMode: "on-request",
          updatedAt: "pending",
        }),
        /** 仮反映前の値とは異なるストレージの状態を、復元候補として返す。 */
        getAuxiliarySession: async () => savedRollbackSession,
        /** 仮反映後の保存を失敗させ、呼び出し元へ伝わるエラーを固定する。 */
        saveAuxiliarySession: async () => {
          throw error;
        },
      }),
      error,
    );

    assert.equal(currentSession, savedRollbackSession);
  });

  /** 保存を待つ間に同じ Session の実行状態が進んだ場合、成功応答でも失敗時の復元でも新しい表示を上書きしない。 */
  it("後続 mutation 後の保存成功と保存失敗 rollback は current を上書きしない", async () => {
    const error = new Error("save failed");
    const mutationRevision = { current: 0 };
    let currentSession: AuxiliarySession | null = makeAuxiliarySession();
    const success = createDeferredSave();
    const successUpdate = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      /** 保存の完了時に実行中へ変化した表示を含め、現在の Session を返す。 */
      getCurrentSession: () => currentSession,
      /** 承認の仮反映と保存成功後の適用先を、同じ表示変数で観測する。 */
      applyActiveSession: (session) => {
        currentSession = session;
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision,
      /** 後続の実行開始とは独立した承認変更を仮時刻付きで作る。 */
      recipe: (current) => ({
        ...current,
        approvalMode: "on-request",
        updatedAt: "pending",
      }),
      /** 成功経路のため、復元用に保存済み値を読み込まない。 */
      getAuxiliarySession: async () => null,
      /** 新しい実行状態を反映した後で、旧リビジョンの保存を成功させる。 */
      saveAuxiliarySession: () => success.promise,
    });

    await flushQueuedOperationStart();
    mutationRevision.current += 1;
    currentSession = makeAuxiliarySession({
      approvalMode: "on-request",
      runState: "running",
      updatedAt: "running",
    });
    success.resolve(
      makeAuxiliarySession({ approvalMode: "on-request", updatedAt: "saved" }),
    );
    await successUpdate;
    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running");

    currentSession = makeAuxiliarySession({
      approvalMode: "on-request",
      updatedAt: "idle-before-failure",
    });
    const failure = createDeferredSave();
    const failureUpdate = runGuardedAuxiliarySessionUpdate({
      activeSession: currentSession,
      /** 二件目でも保存対象が画面に残ったまま、状態だけが進んだことを判定できるようにする。 */
      getCurrentSession: () => currentSession,
      /** 二件目の仮反映を適用し、遅い失敗で上書きされた場合も観測できるようにする。 */
      applyActiveSession: (session) => {
        currentSession = session;
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision,
      /** 承認変更に続く別の更新として、Sandbox と仮の更新時刻を作る。 */
      recipe: (current) => ({
        ...current,
        codexSandboxMode: "workspace-write",
        updatedAt: "pending-2",
      }),
      /** 古い復元が誤って適用された場合に判別できるストレージ上の値を返す。 */
      getAuxiliarySession: async () =>
        makeAuxiliarySession({ updatedAt: "storage" }),
      /** 新しい実行状態を反映した後で、旧リビジョンの保存を失敗させる。 */
      saveAuxiliarySession: () => failure.promise,
    });
    await flushQueuedOperationStart();
    mutationRevision.current += 1;
    currentSession = makeAuxiliarySession({
      approvalMode: "on-request",
      runState: "running",
      updatedAt: "running-2",
    });
    failure.reject(error);
    await assert.rejects(failureUpdate, error);
    assert.equal(currentSession.runState, "running");
    assert.equal(currentSession.updatedAt, "running-2");
  });
});

/** 画面側の状態管理と保存 API を結ぶ更新関数が、API の有無と現在の対象を尊重することを確認する。 */
describe("createGuardedActiveAuxiliarySessionUpdater", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "APIがないAuxiliary更新は保存と状態反映を開始しない"
  // oracle = { type = "contract", ref = "src/chat/auxiliary/auxiliary-session-update-operation.ts: createGuardedActiveAuxiliarySessionUpdater" }
  // fault = "利用不可のAPIでも状態だけを保存済みとして反映する"
  // observable = "返り値と状態ownerの呼出有無"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-update-unavailable"
  // lifecycle = "permanent"
  // @end-test-value
  /** 選択中の Session があってもアクセス API が得られなければ null を返し、状態を変更しない。 */
  it("API がない場合は guarded update を実行しない", async () => {
    const activeSession = makeAuxiliarySession();
    let saved = false;
    const updateActiveSession = createGuardedActiveAuxiliarySessionUpdater({
      activeSession,
      /** 呼び出し時に Auxiliary の API を取得できない状態を返す。 */
      getApi: () => null,
      /** API の有無以外は通常と同じように選択中の Session を返す。 */
      getCurrentSession: () => activeSession,
      /** API 不在なのに画面の状態更新が呼ばれた場合を記録する。 */
      setActiveSession: () => {
        saved = true;
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision: { current: 0 },
    });

    assert.equal(
      await updateActiveSession((current) => ({
        ...current,
        composerDraft: "after",
      })),
      null,
    );
    assert.equal(saved, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary更新は状態ownerを通じて変更中と保存済みのSessionを反映する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
  // fault = "変更中または保存完了のSessionをownerへ反映せず後続操作が古い状態を使う"
  // observable = "保存要求、適用Sessionの本文と時刻、後続参照のSession"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-guarded-update-owner"
  // lifecycle = "permanent"
  // @end-test-value
  /** 状態管理側に仮値と保存結果を順に反映し、仮の値を使って一回だけ保存することを確認する。 */
  it("guarded active updater は状態ownerを通して保存結果を反映する", async () => {
    const activeSession = makeAuxiliarySession({ composerDraft: "before" });
    const savedSession = makeAuxiliarySession({
      composerDraft: "after",
      updatedAt: "saved",
    });
    const activeSessionRef = {
      current: activeSession as AuxiliarySession | null,
    };
    const appliedSessions: AuxiliarySession[] = [];
    const requests: AuxiliarySession[] = [];
    const mutationRevision = { current: 0 };
    const updateActiveSession = createGuardedActiveAuxiliarySessionUpdater({
      activeSession,
      /** 更新時に使う読み取り・保存 API を同じ fixture から取得する。 */
      getApi: () => ({
        /** 保存が成功するケースでは復元用の値を返さない。 */
        getAuxiliarySession: async () => null,
        /** API に届いた仮の値を記録し、ストレージ応答として確定済みの値を返す。 */
        updateAuxiliarySession: async (session) => {
          requests.push(session);
          return savedSession;
        },
      }),
      /** 仮反映中も、画面側の状態管理が保持する最新の値を返す。 */
      getCurrentSession: () => activeSessionRef.current,
      /** 表示対象の現在値を更新し、仮反映と確定が呼ばれた順に記録する。 */
      setActiveSession: (session) => {
        activeSessionRef.current = session;
        appliedSessions.push(session);
      },
      draftSaveQueue: { current: Promise.resolve() },
      sessionSaveQueue: { current: Promise.resolve() },
      mutationRevision,
    });

    assert.deepEqual(
      await updateActiveSession((current) => ({
        ...current,
        composerDraft: "after",
        updatedAt: "pending",
      })),
      {
        nextSession: makeAuxiliarySession({
          composerDraft: "after",
          updatedAt: "pending",
        }),
        saved: savedSession,
      },
    );
    assert.equal(mutationRevision.current, 1);
    assert.deepEqual(requests, [
      makeAuxiliarySession({ composerDraft: "after", updatedAt: "pending" }),
    ]);
    assert.deepEqual(appliedSessions, [
      makeAuxiliarySession({ composerDraft: "after", updatedAt: "pending" }),
      savedSession,
    ]);
    assert.equal(activeSessionRef.current, savedSession);
  });
});

/** 画面が管理する参照を最新の選択対象と揃え、解除時も以前の対象を残さないことを確認する。 */
describe("syncActiveAuxiliarySessionRef", () => {
  /** 新しい選択値を参照へ設定し、選択解除では参照も null に戻す。 */
  it("active session ref を最新の active session に同期する", () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });
    const nextSession = makeAuxiliarySession({ updatedAt: "next" });
    const activeSessionRef = {
      current: previousSession as AuxiliarySession | null,
    };

    syncActiveAuxiliarySessionRef({
      activeSession: nextSession,
      activeSessionRef,
    });
    assert.equal(activeSessionRef.current, nextSession);

    syncActiveAuxiliarySessionRef({
      activeSession: null,
      activeSessionRef,
    });
    assert.equal(activeSessionRef.current, null);
  });
});

/** 保存失敗時に戻す値を、ストレージ読取の成功・不在・失敗に応じて区別する。 */
describe("resolveAuxiliarySessionRollbackSession", () => {
  /** 永続化された Session が得られたら、仮反映前に保持した値より優先する。 */
  it("保存済み session を取得できた場合は保存済み session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });
    const pendingSession = makeAuxiliarySession({ updatedAt: "pending" });
    const savedSession = makeAuxiliarySession({ updatedAt: "saved" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession,
        previousSession,
        /** 仮の値や更新前の値とは時刻の異なる保存済み Session を返す。 */
        getAuxiliarySession: async () => savedSession,
      }),
      savedSession,
    );
  });

  /** ストレージに対象がない場合は、仮反映の前に保持した Session へ戻す。 */
  it("保存済み session がない場合は previous session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession: makeAuxiliarySession({ updatedAt: "pending" }),
        previousSession,
        /** 保存済み Session が存在しない応答を再現する。 */
        getAuxiliarySession: async () => null,
      }),
      previousSession,
    );
  });

  /** ストレージの読取が拒否されても、仮反映前の値を代替として返す。 */
  it("保存済み session の取得に失敗した場合は previous session を返す", async () => {
    const previousSession = makeAuxiliarySession({ updatedAt: "previous" });

    assert.equal(
      await resolveAuxiliarySessionRollbackSession({
        pendingSession: makeAuxiliarySession({ updatedAt: "pending" }),
        previousSession,
        /** 保存済み値の読み取りで発生したエラーを再現する。 */
        getAuxiliarySession: async () => {
          throw new Error("load failed");
        },
      }),
      previousSession,
    );
  });
});

/** 個々の保存完了と別に、次の保存を並べるためのキューの継続を確認する。 */
describe("enqueueAuxiliarySessionSaveOperation", () => {
  /** 先行保存が完了するまで後続保存を開始せず、それぞれの結果を別の Promise から受け取れる。 */
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

  /** 先行保存のエラーはその要求へ返すが、キューは停止せず後続保存を開始する。 */
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

/** 保存を追加する呼び出しが、共有のキュー参照を最新の末尾へ進めることを確認する。 */
describe("enqueueAuxiliarySessionSaveWithQueue", () => {
  /** 追加するたびにキュー参照を更新し、先行保存が確定してから後続保存を実行する。 */
  it("queue ref を更新しながら保存 operation を queue 順に実行する", async () => {
    const queueRef = { current: Promise.resolve() };
    const events: string[] = [];
    const first = createDeferredSave();
    const second = createDeferredSave();

    const firstOperation = enqueueAuxiliarySessionSaveWithQueue(
      queueRef,
      () => {
        events.push("start:first");
        return first.promise;
      },
    );
    const queueAfterFirst = queueRef.current;
    const secondOperation = enqueueAuxiliarySessionSaveWithQueue(
      queueRef,
      () => {
        events.push("start:second");
        return second.promise;
      },
    );

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
