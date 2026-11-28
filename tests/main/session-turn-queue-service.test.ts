import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  QueuedInputPreDispatchError,
  SessionTurnQueueService,
} from "../../src-electron/session/session-turn-queue-service.js";
import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueReceipt,
  SessionTurnQueueStore,
} from "../../src-shared/session/session-turn-queue.js";

const owner = { sessionId: "session", incarnationId: "incarnation" };
/** 要求IDを本文にも使い、同じ実行設定を持つ比較用の受付入力を作る。 */
function captured(id: string): SessionTurnQueueCapturedInput {
  return {
    request: {
      clientRequestId: id,
      userMessage: id,
      executionOptions: {
        model: "model",
        reasoningEffort: "medium",
        approvalMode: "on-request",
        codexSandboxMode: "workspace-write",
        codexSpeed: "standard",
        codexReviewer: "user",
        customAgentName: "",
      },
    },
    attachments: [],
    provider: "codex",
    workspacePath: "workspace",
  };
}
/** 保存やdispatchの完了を任意の時点まで止めるため、Promiseとその解決関数を対で返す。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** スケジュール済みのキュー処理に実行機会を渡す。 */
async function flush() {
  await setImmediate();
}

// @test-value v2
// kind = "contract"
// claim = "通常受付・外部commit済受付・取消・queue経由追加入力は各操作でonChangedを呼び、同じreceiptの不変accepted originを渡す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/966; docs/design/database-schema.md: receiptのUUID・送信側の読取" }
// fault = "各queue操作の通知が欠ける、ownerだけを通知し送信元を失う、または現在の編集入力から別actorを通知する"
// observable = "各操作前後のonChanged件数の増加と新規通知のowner/origin、queued Input完了後のreceipt状態"
// observation_boundary = "public-boundary"
// scope = "production queue serviceの通常受付・外部受付・取消・queued Send Input通知。storeとProviderはfixture"
// lifecycle = "permanent"
// impact = "受付済指示やその配送変化が送信元チャットへ反映されない"
// distinction = "Window routingとstorageのtestはqueue mutationから送信元originが渡る接続を検証しない"
// @end-test-value
/** 通常受付、外部コミット済み受付、取消、追加入力の通知で、保存された送信元の来歴を変えない。 */
test("queue changes retain accepted source origin for sender invalidation", async () => {
  const { store, rows } = boundary();
  const origin = {
    kind: "session" as const,
    actorKind: "main" as const,
    actorSessionId: "sender",
    actorIncarnationId: "sender-inc",
    actorTurnId: "7",
    operation: "send" as const,
    targetSessionId: owner.sessionId,
    targetIncarnationId: owner.incarnationId,
  };
  const notices: Array<{ owner: typeof owner; origin: unknown }> = [];
  const service = new SessionTurnQueueService({
    store,
    /** 次ターンを開始させず、実行中の追加送信経路だけを使用する。 */
    isRunInFlight: () => true,
    /** 実行中なのに新しいターンが開始されたら検証を失敗させる。 */
    dispatch: async () => {
      throw new Error("Unexpected dispatch");
    },
    /** 変更通知ごとに所有者と送信元を照合できるよう記録する。 */
    onChanged: (owner, origin) => notices.push({ owner, origin }),
    /** 追加入力を受理し、受付に対応する実行中ターンを返す。 */
    sendInput: async (receipt) => {
      await store.settle(owner, receipt.id, "completed");
    },
  });
  /** 直前から増えた通知がすべて同じownerと受付時のoriginを持つことを照合する。 */
  const assertNewSourceNotices = (before: number) => {
    const added = notices.slice(before);
    assert.ok(
      added.length > 0,
      "The operation must publish a new source invalidation.",
    );
    for (const notice of added) assert.deepEqual(notice, { owner, origin });
  };
  try {
    const beforeEnqueue = notices.length;
    const receipt = await service.enqueue(owner, {
      ...captured("first"),
      origin,
    });
    assertNewSourceNotices(beforeEnqueue);
    rows[0].accepted = structuredClone(rows[0].captured);
    rows[0].captured.origin = { ...origin, actorSessionId: "not-the-original" };
    const beforeCancel = notices.length;
    await service.cancelQueued(owner, receipt.id);
    assertNewSourceNotices(beforeCancel);
    const external = await store.enqueue(owner, {
      ...captured("external"),
      origin,
    });
    const beforeExternalAcceptance = notices.length;
    service.acceptCommittedReceipt(external);
    assertNewSourceNotices(beforeExternalAcceptance);
    const beforeQueuedInput = notices.length;
    const result = await service.sendQueuedInput(owner, external.id, "native");
    assert.equal(result.state, "completed");
    assertNewSourceNotices(beforeQueuedInput);
  } finally {
    await service.close();
  }
});

/** 実サービスの受付、claim、回収を試せるメモリ上の保存境界を作り、保存行を観測できるようにする。 */
function boundary() {
  const rows: SessionTurnQueueReceipt[] = [];
  /** 対象受付行の状態と理由を更新し、保存行から分離した結果を返す。 */
  const update = (
    id: string,
    state: SessionTurnQueueReceipt["state"],
    reason?: string,
  ) => {
    const row = rows.find((entry) => entry.id === id)!;
    row.state = state;
    row.reason = reason ?? null;
    return structuredClone(row);
  };
  /** 受付に連番を割り振り、実行情報未確定のqueuedとして入力を保存する。 */
  const enqueue = async (
    owned: typeof owner,
    input: SessionTurnQueueCapturedInput,
  ): Promise<SessionTurnQueueReceipt> => {
    const row: SessionTurnQueueReceipt = {
      ...owned,
      id: input.request.clientRequestId,
      requestId: input.request.clientRequestId,
      sequence: rows.length + 1,
      queuePosition: rows.length + 1,
      state: "queued",
      captured: structuredClone(input),
      turnId: null,
      userMessageSeq: null,
      reason: null,
      releasedAt: null,
      createdAt: "now",
      updatedAt: "now",
    };
    rows.push(row);
    return structuredClone(row);
  };
  const store: SessionTurnQueueStore & { enqueue: typeof enqueue } = {
    /** この共通fixtureにない編集を呼んだテストは意図せず成功させない。 */
    updateQueued: async () => {
      throw new Error("Unexpected edit");
    },
    /** 並び替えが必要なケースには別実装が必要なため、ここでは失敗させる。 */
    reorderQueued: async () => {
      throw new Error("Unexpected reorder");
    },
    enqueue,
    /** 入力を受理し、指定があれば同じ保存操作の結果として先頭のclaimも返す。 */
    admit: async (owner, input, claim) => {
      const receipt = await enqueue(owner, input);
      const claimed = claim
        ? await store.claimNext(owner, claim.unreleasedSourceTurnIds)
        : null;
      return {
        receipt: claimed?.id === receipt.id ? claimed : receipt,
        claimed,
      };
    },
    /** 指定世代に属する受付をクライアント要求IDで照会する。 */
    getReceipt: async (owned, requestId) =>
      rows.find(
        (row) =>
          row.incarnationId === owned.incarnationId &&
          row.requestId === requestId,
      ) ?? null,
    /** 指定世代の永続受付IDを照会する。 */
    getReceiptById: async (owned, id) =>
      rows.find(
        (row) => row.incarnationId === owned.incarnationId && row.id === id,
      ) ?? null,
    /** 終端済みの行を除き、保留・実行中・中断した受付を返す。 */
    listActive: async () =>
      rows.filter((row) =>
        ["queued", "starting", "running", "interrupted"].includes(row.state),
      ),
    /** テスト用の履歴一覧をページ分割せず、保存配列と独立した値として返す。 */
    listReceipts: async () => ({
      receipts: structuredClone(rows),
      nextCursor: null,
    }),
    /** 保存行がある場合は起動時に点検する所有者を1件返す。 */
    listPendingOwners: async () => (rows.length ? [owner] : []),
    /** 同一所有者・世代に実行中または開始中がなければ、最初のqueuedをstartingへ移す。 */
    claimNext: async (owned) => {
      const ownedRows = rows.filter(
        (row) =>
          row.incarnationId === owned.incarnationId &&
          row.sessionId === owned.sessionId,
      );
      if (
        ownedRows.some(
          (row) => row.state === "starting" || row.state === "running",
        )
      )
        return null;
      const row = ownedRows.find((row) => row.state === "queued");
      return row ? update(row.id, "starting") : null;
    },
    /** queued受付だけを実行中ターンへの追加入力としてclaimし、対応ターンIDを残す。 */
    claimForInput: async (_, id, inputTurnId) => {
      const row = rows.find((entry) => entry.id === id)!;
      assert.equal(row.state, "queued");
      row.inputTurnId = inputTurnId;
      return update(id, "starting");
    },
    /** 追加入力としてclaimしたターンの一致を確認し、ターンへの関連づけを消してqueuedへ戻す。 */
    restoreQueuedInput: async (_, id, inputTurnId) => {
      const row = rows.find((entry) => entry.id === id)!;
      assert.equal(row.inputTurnId, inputTurnId);
      row.inputTurnId = null;
      return update(id, "queued");
    },
    /** 実行開始情報を受付へ反映し、runningに移す。 */
    markStarted: async (_, id, input) => {
      Object.assign(
        rows.find((row) => row.id === id)!,
        input,
      );
      return update(id, "running");
    },
    /** 保存済み受付を決着状態へ更新し、呼び出し元の理由も反映する。 */
    settle: async (_, id, state, reason) => update(id, state, reason),
    /** 未実行のqueued受付だけをcanceledへ移す。 */
    cancelQueued: async (_, id) => {
      assert.equal(rows.find((row) => row.id === id)!.state, "queued");
      return update(id, "canceled");
    },
    /** 起動回収で残ったclaim済みの追加入力はinterrupted、通常起動はfailedにする。 */
    recoverInterrupted: async () => {
      const claimed = rows.filter(
        (row) => row.state === "starting" || row.state === "running",
      );
      claimed.forEach((row) =>
        update(row.id, row.inputTurnId ? "interrupted" : "failed"),
      );
      return claimed.length;
    },
  };
  return { rows, store };
}

// @test-value v2
// kind = "contract"
// claim = "外部transactionで保存済みのCoordination受付は実行中・queue編集中でも購読者へ通知し、保留解放後は再受付せず一度だけ配送する。通常receipt読取は再通知しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue、Queue Editing、通常AgentのSession操作" }
// fault = "外部受付を通知しない、編集中にdispatchする、再enqueueで受付を重複させる、または読取から再通知を繰り返す"
// observable = "通知時に取得可能なreceipt ID列、保留前後のdispatch ID列、保存receipt数"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueServiceの外部commit受付・receipt再確認とdrain"
// lifecycle = "permanent"
// impact = "受理済みCoordinationをQueueで確認・取消できない、編集中の予約が勝手に実行される、または外部操作が重複する"
// distinction = "storage testは保存後の購読通知とruntime/edit holdの接続を通らず、型検査も通知欠落を検出できない。二つのin-memory状態だけで確認する"
// @end-test-value
/** 外部トランザクションで保存済みの受付は即時通知し、キュー編集と実行ガードが解けた後に再受付せず一度だけ配送する。 */
test("外部commit受付は実行中とqueue編集中にも通知し既存受付を一度だけ配送する", async () => {
  for (const mode of ["running", "editing"] as const) {
    const { store, rows } = boundary();
    let guarded = true;
    const dispatched: string[] = [];
    const observed: string[][] = [];
    const service = new SessionTurnQueueService({
      store,
      /** 外部受理後も実ターンのガード状態を任意に保持・解除する。 */
      isRunInFlight: () => guarded,
      /** 通知された所有者を照合し、通知時に観測できた保存受付IDを記録する。 */
      onChanged: (notified) => {
        assert.deepEqual(notified, owner);
        observed.push(
          rows.filter((row) => row.state === "queued").map((row) => row.id),
        );
      },
      /** ガード解除後に渡された受付IDを配送順に保持する。 */
      dispatch: async (receipt) => {
        dispatched.push(receipt.id);
        return { state: "completed" };
      },
    });
    try {
      if (mode === "editing") {
        await service.enqueue(owner, captured("editable"));
        await service.waitForPending();
        await service.beginQueuedEdit(owner, "editable", async () => {});
        guarded = false;
      }
      const input = captured("coordination");
      input.coordination = {
        id: "consultation",
        operation: "deliver",
        actor: { kind: "user" },
      };
      const receipt = await store.enqueue(owner, input);
      observed.length = 0;
      service.acceptCommittedReceipt(receipt);
      await service.waitForPending();
      const expectedIds =
        mode === "editing" ? ["editable", "coordination"] : ["coordination"];
      assert.deepEqual(observed, [expectedIds]);
      assert.deepEqual(dispatched, []);
      service.reconcileKnownReceipt(receipt);
      await service.waitForPending();
      assert.deepEqual(
        observed,
        [expectedIds],
        "receipt reads do not invalidate subscribers",
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        expectedIds,
      );
      if (mode === "editing") await service.cancelQueuedEdit(owner, "editable");
      else {
        guarded = false;
        service.wake(owner.sessionId);
      }
      await service.waitForPending();
      assert.deepEqual(dispatched, expectedIds);
      assert.deepEqual(
        rows.map((row) => row.state),
        expectedIds.map(() => "completed"),
      );
    } finally {
      await service.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "queue lockの待機中に失効したactorの新規受付と取消を、lock取得後の認可で拒否する"
// oracle = { type = "contract", ref = "GitHub Issue #832: 非同期検証後の有効runtime binding確認" }
// fault = "queue lock待機前だけ認可して失効済みactorのmutationを保存する"
// observable = "受付行数、対象receipt状態、公開操作の失効reject"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueServiceの受付・取消lockとactor再検証"
// lifecycle = "permanent"
// distinction = "facadeのpreflight認可testではservice lock待機中の失効を再現しない"
// @end-test-value
/** 受付と取消が同じロックを待つ間に権限が失効したら、ロック取得時に再認可して両方を拒否する。 */
test("queue lock取得後にactorの受付と取消権限を再検証する", async () => {
  const { store, rows } = boundary();
  const held = deferred<void>();
  const entered = deferred<void>();
  const admit = store.admit;
  store.admit = async (...args) => {
    entered.resolve();
    await held.promise;
    return admit(...args);
  };
  let valid = true;
  /** ケースの有効フラグを読み、権限失効をbindingエラーとして通知する。 */
  const assertActor = () => {
    if (!valid) throw new Error("Actor binding expired");
  };
  const service = new SessionTurnQueueService({
    store,
    /** 権限検証中はターンを実行中とし、受付が即時開始されないようにする。 */
    isRunInFlight: () => true,
    /** このケースの配送は状態変更の検証対象外なので、呼ばれれば完了を返す。 */
    dispatch: async () => ({ state: "completed" }),
  });
  try {
    const first = service.enqueue(owner, captured("first"));
    await entered.promise;
    const second = service.enqueue(owner, captured("second"), assertActor);
    const canceled = service.cancelQueued(owner, "first", assertActor);
    const rejectedSecond = assert.rejects(second, /binding expired/);
    const rejectedCancel = assert.rejects(canceled, /binding expired/);
    valid = false;
    held.resolve();
    await first;
    await rejectedSecond;
    await rejectedCancel;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, "queued");
  } finally {
    held.resolve();
    await service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued入力の結果不明は元要求を再送せず、実行解放後には後続を進める。確定済みはcompletedを通知する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "不明入力の再送、実guardを無視した後続実行、実guard解放後の永久保留、または完了通知の欠落"
// observable = "receipt stateとprovider入力回数、後続dispatch回数、購読者が通知時に取得できるcompleted state"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService.sendQueuedInput"
// lifecycle = "permanent"
// impact = "外部操作の重複実行、未送信指示の消失、完了後の待機表示残留を防ぐ"
// distinction = "storage遷移testではprovider失敗分類、自動drain、購読者への通知の接続を確認できない"
// @end-test-value
/** 追加入力の結果不明を通常のdispatchと分け、保存正本の完了を優先しつつ後続は実ガード解除まで待たせる。 */
test("queued inputはdispatch境界を区別し正本completedを優先する", async () => {
  for (const mode of [
    "preflight",
    "unknown",
    "committed",
    "success",
  ] as const) {
    const { store, rows } = boundary();
    let guarded = true;
    let dispatched = 0;
    let inputs = 0;
    const observed: Array<SessionTurnQueueReceipt["state"]> = [];
    const service = new SessionTurnQueueService({
      store,
      /** 非同期の実行ガード読込にも対応する経路で、現在の状態を返す。 */
      isRunInFlight: async () => guarded,
      /** 通知を受け取ったタイミングで保存行の状態を観測する。 */
      onChanged: () => {
        if (rows[0]) observed.push(rows[0].state);
      },
      /** 後続の通常ターンが開始された回数を記録する。 */
      dispatch: async () => {
        dispatched += 1;
        return { state: "completed" };
      },
      /** 対象ケースの保存済み終端または入力送信の結果不明を再現する。 */
      sendInput: async (receipt) => {
        inputs += 1;
        if (mode === "preflight")
          throw new QueuedInputPreDispatchError("not dispatched");
        if (mode === "committed" || mode === "success")
          await store.settle(receipt, receipt.id, "completed");
        if (mode === "success") return;
        throw new Error("reply lost");
      },
    });
    await service.enqueue(owner, captured("input"));
    await service.enqueue(owner, captured("follower"));
    if (mode === "committed" || mode === "success") {
      assert.equal(
        (await service.sendQueuedInput(owner, "input", "provider-turn")).state,
        "completed",
      );
      assert.equal(observed.at(-1), "completed");
    } else
      await assert.rejects(
        service.sendQueuedInput(owner, "input", "provider-turn"),
        mode === "preflight" ? /not dispatched/ : /reply lost/,
      );
    assert.equal(
      rows[0]!.state,
      mode === "preflight"
        ? "queued"
        : mode === "unknown"
          ? "interrupted"
          : "completed",
    );
    assert.equal(inputs, 1);
    if (mode === "unknown") {
      service.wake(owner.sessionId);
      await service.waitForPending();
      assert.equal(dispatched, 0);
      assert.equal(rows[1]!.state, "queued");
      guarded = false;
      service.wake(owner.sessionId);
      await service.waitForPending();
      assert.equal(dispatched, 1);
      assert.equal(rows[1]!.state, "completed");
      assert.equal(rows[0]!.state, "interrupted");
    }
    await service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "input claim返信喪失と準備拒否は未送信のままqueuedへ戻る。restoreが確認できずinterruptedを確定した場合は元の入力を再送せず後続を進める"
// oracle = { type = "contract", ref = "GitHub Issue #801: pre-provider queued input recovery and unknown no replay" }
// fault = "claim返信喪失をstartingへ固定するかProviderを送信し、restore不明を再実行する"
// observable = "receipt state、入力とrestore回数、実guard解放後のFIFO dispatch"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService.sendQueuedInput pre-provider recovery"
// lifecycle = "permanent"
// impact = "未送信指示の回復不能と外部操作の重複を防ぐ"
// distinction = "storage単体testはserviceのclaim返信喪失とProvider非dispatchを検知しない"
// @end-test-value
/** claim応答喪失や送信前拒否では未送信の受付を戻し、確認できないまま中断した場合は元の入力を再送しない。 */
test("queued inputのclaim ACK喪失と準備拒否は未送信のまま回復する", async () => {
  for (const origin of ["claim", "preflight"] as const) {
    for (const mode of [
      "restored",
      "restore-reply-lost",
      "restore-failed",
    ] as const) {
      const { store, rows } = boundary();
      const claim = store.claimForInput;
      const restore = store.restoreQueuedInput;
      let restores = 0;
      let inputs = 0;
      let guarded = true;
      const dispatched: string[] = [];
      if (origin === "claim")
        store.claimForInput = async (...args) => {
          await claim(...args);
          throw new Error("claim reply lost");
        };
      store.restoreQueuedInput = async (...args) => {
        restores += 1;
        if (mode === "restore-failed") throw new Error("restore unavailable");
        const receipt = await restore(...args);
        if (mode === "restore-reply-lost")
          throw new Error("restore reply lost");
        return receipt;
      };
      const service = new SessionTurnQueueService({
        store,
        /** 回復処理中も実行ガードが掛かっている状態を維持する。 */
        isRunInFlight: () => guarded,
        /** 送信準備到達を数え、Providerに送信する前の拒否を返す。 */
        sendInput: async () => {
          inputs += 1;
          throw new QueuedInputPreDispatchError("not dispatched");
        },
        /** 回復後に開始された通常要求だけを順序付きで記録する。 */
        dispatch: async (receipt) => {
          dispatched.push(receipt.id);
          return { state: "completed" };
        },
      });
      await service.enqueue(owner, captured("input"));
      await service.enqueue(owner, captured("follower"));
      await assert.rejects(
        service.sendQueuedInput(owner, "input", "provider-turn"),
        origin === "claim" ? /claim reply lost/ : /not dispatched/,
      );
      assert.equal(inputs, origin === "claim" ? 0 : 1);
      assert.equal(restores, 1);
      assert.equal(
        rows[0]!.state,
        mode === "restore-failed" ? "interrupted" : "queued",
      );
      guarded = false;
      service.wake(owner.sessionId);
      await flush();
      assert.deepEqual(
        dispatched,
        mode === "restore-failed" ? ["follower"] : ["input", "follower"],
      );
      await service.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "FIFOの後続はterminal応答だけでは開始せず、実guard解放のwake後に開始する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Run Cancel" }
// fault = "取消やterminal応答をguard解放と誤認して同一Sessionを二重実行する"
// observable = "dispatchに渡されたreceipt IDの順序と保存されたterminal state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue dispatch and guard"
// lifecycle = "permanent"
// impact = "旧providerが生存中の次turn開始で履歴と実行が競合する"
// distinction = "型検査やstore testではruntime guardと非同期terminalの分離を検知できない"
// @end-test-value
/** 終端の保存だけでは後続を出さず、実ガードの解放通知後にFIFO順で開始する。 */
test("FIFOは実guard解放まで後続を保留する", async () => {
  const { store, rows } = boundary();
  let guarded = true;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({
    store,
    /** 終端応答とは別に、実ターンがまだ生存しているかを返す。 */
    isRunInFlight: () => guarded,
    /** 先頭の開始状態と終端を分け、後続の配送順を記録する。 */
    dispatch: async (receipt, started) => {
      ids.push(receipt.id);
      await started({
        turnId: `turn-${receipt.id}`,
        userMessageSeq: receipt.sequence,
      });
      guarded = true;
      return { state: "canceled" };
    },
  });
  await Promise.all([
    service.enqueue(owner, captured("first")),
    service.enqueue(owner, captured("second")),
  ]);
  await flush();
  assert.deepEqual(ids, []);
  guarded = false;
  service.wake(owner.sessionId);
  await flush();
  assert.deepEqual(ids, ["first"]);
  assert.equal(rows[0]!.state, "canceled");
  assert.equal(rows[0]!.turnId, "turn-first");
  guarded = false;
  service.wake(owner.sessionId);
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "queued個別取消は現在runに転送せず、FIFOから取消項目だけを除く"
// oracle = { type = "contract", ref = "src-shared/session/session-turn-queue.ts SessionTurnQueueStore.cancelQueued" }
// fault = "queuedの取消を実行中providerへ転送するか取消済み要求をdispatchする"
// observable = "dispatchされたID、現在runのterminal state、取消receipt state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue individual cancellation"
// lifecycle = "permanent"
// distinction = "store testだけでは現在dispatchの非干渉と次dispatch対象を確認できない"
// @end-test-value
/** 保留中の個別項目を取り消しても実行中の項目に転送せず、後続で取消対象だけを飛ばす。 */
test("queuedの取消は現在runを継続させる", async () => {
  const { store, rows } = boundary();
  const terminal = deferred<{ state: "completed" }>();
  const ids: string[] = [];
  const service = new SessionTurnQueueService({
    store,
    /** このケースはサービス自身の実行順序だけを検証し、外部の実行ガードは設けない。 */
    isRunInFlight: () => false,
    /** 配送IDを保持し、先頭の完了だけを保留して後続の取消を試せるようにする。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return receipt.id === "first" ? terminal.promise : { state: "completed" };
    },
  });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await service.enqueue(owner, captured("third"));
  await service.cancelQueued(owner, "second");
  assert.deepEqual(ids, ["first"]);
  terminal.resolve({ state: "completed" });
  await flush();
  assert.deepEqual(ids, ["first", "third"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "canceled", "completed"],
  );
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "shutdownは受付と後続dispatchを止め、受付済み保存と現在runの終端保存を待つ"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md App Quit" }
// fault = "closeを保存完了前に返すかshutdown開始後に後続をdispatchする"
// observable = "受付と終端のどちらか一方だけ保存中のclose完了状態、enqueue結果、dispatch ID、保存済みstate"
// observation_boundary = "component-behavior"
// scope = "Main durable queue shutdown persistence"
// lifecycle = "permanent"
// impact = "DB close後の遅延保存や未確定受付の喪失につながる"
// distinction = "型検査ではpending mutationとdispatchの非同期待機を検証できない"
// @end-test-value
/** 永久closeは新規受付と後続開始を止め、受付済み保存と実行中の終端保存を両方待つ。 */
test("closeは受付済みmutationと実行終端を待ち後続を開始しない", async () => {
  for (const firstCommit of ["admission", "terminal"]) {
    const { store, rows } = boundary();
    const terminal = deferred<{ state: "completed" }>();
    const terminalCommit = deferred<void>();
    const settling = deferred<void>();
    const settle = store.settle;
    store.settle = async (...args) => {
      settling.resolve();
      await terminalCommit.promise;
      return settle(...args);
    };
    const ids: string[] = [];
    const service = new SessionTurnQueueService({
      store,
      /** shutdown前に先頭要求を開始できるよう外部ガードなしとする。 */
      isRunInFlight: () => false,
      /** 先頭の実行を任意の時点まで保留し、後続が配送されないことをIDで照合する。 */
      dispatch: async (receipt) => {
        ids.push(receipt.id);
        return terminal.promise;
      },
    });
    await service.enqueue(owner, captured("first"));
    const commit = deferred<void>();
    const admit = store.admit;
    store.admit = async (...args) => {
      await commit.promise;
      return admit(...args);
    };
    const accepted = service.enqueue(owner, captured("second"));
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    try {
      assert.throws(
        () => service.enqueue(owner, captured("third")),
        /shutting down/,
      );
      terminal.resolve({ state: "completed" });
      await settling.promise;
      if (firstCommit === "admission") {
        commit.resolve();
        assert.equal((await accepted).state, "queued");
        assert.equal(rows[0]!.state, "starting");
      } else {
        terminalCommit.resolve();
      }
      await flush();
      if (firstCommit === "terminal")
        assert.deepEqual(
          rows.map((row) => row.state),
          ["completed"],
        );
      assert.equal(
        closed,
        false,
        `close returned after only the ${firstCommit} commit`,
      );
    } finally {
      terminal.resolve({ state: "completed" });
      terminalCommit.resolve();
      commit.resolve();
      await closing;
    }
    assert.equal((await accepted).state, "queued");
    assert.deepEqual(ids, ["first"]);
    assert.deepEqual(
      rows.map((row) => row.state),
      ["completed", "queued"],
    );
  }
});

// @test-value v2
// kind = "contract"
// claim = "ACKは保存commit後だけ返しobserver例外は受理と後続dispatchを壊さない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-window-close; docs/design/electron-session-store.md#turn-queue" }
// fault = "保存前に受付ACKするか投影通知例外を保存失敗として扱う"
// observable = "保存待ちとACK時の通知回数、返却receipt、dispatch ID列"
// observation_boundary = "component-behavior"
// scope = "Main durable queue acceptance notification"
// lifecycle = "permanent"
// distinction = "store testではserviceのACKと投影例外境界を観測できない"
// @end-test-value
/** 受付の応答を保存コミットより早く返さず、購読者が例外を投げても後続配送を止めない。 */
test("受理ACKはcommitを待ちobserver失敗でもdrainする", async () => {
  const { store } = boundary();
  const commit = deferred<void>();
  const admit = store.admit;
  store.admit = async (...args) => {
    await commit.promise;
    return admit(...args);
  };
  const ids: string[] = [];
  let notifications = 0;
  const service = new SessionTurnQueueService({
    store,
    /** 保存コミット以外には受付を待たせる実行ガードを設けない。 */
    isRunInFlight: () => false,
    /** 購読者の例外後も配送された受付IDを順に数える。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
    /** 受付通知の回数を記録し、その後に購読者の例外を模擬する。 */
    onChanged: () => {
      notifications += 1;
      throw new Error("observer");
    },
  });
  let acknowledged = false;
  const accepting = service
    .enqueue(owner, captured("first"))
    .then((receipt) => {
      acknowledged = true;
      return receipt;
    });
  await flush();
  assert.equal(acknowledged, false);
  assert.deepEqual(ids, []);
  assert.equal(notifications, 0);
  commit.resolve();
  assert.equal((await accepting).id, "first");
  assert.ok(notifications > 0);
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "起動時は保存回収とSession一覧更新を待ち、失敗元を実行せず後続を自動開始する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#persistence-expectations" }
// fault = "起動時に回収やSession一覧更新より先にclaimする、失敗元を再実行する、または後続を永久に保留する"
// observable = "start時の一覧更新ゲート前後のdispatch ID列とreceipt state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue startup reconciliation"
// lifecycle = "permanent"
// impact = "crash直前に開始済みの外部操作を再実行してしまう"
// distinction = "store recoveryだけでは起動後のservice dispatch対象を保証できない"
// @end-test-value
/** 起動時の回収・一覧更新が済んでから未claimを再開し、claim済みだった入力を再実行しない。 */
test("startは未claimを再開しclaim済みは再実行しない", async () => {
  const { store, rows } = boundary();
  await store.enqueue(owner, captured("first"));
  const ids: string[] = [];
  const first = new SessionTurnQueueService({
    store,
    /** 最初の起動で既存の未claimを止める外部ガードを設けない。 */
    isRunInFlight: () => false,
    /** 初回起動から自動開始した受付のIDを共通記録へ追加する。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
  });
  await first.start();
  await flush();
  assert.deepEqual(ids, ["first"]);
  await first.close();
  await store.enqueue(owner, captured("claimed"));
  await store.claimNext(owner);
  await store.enqueue(owner, captured("follower"));
  const second = new SessionTurnQueueService({
    store,
    /** 再起動時はガードではなく回収に伴う一覧更新だけが後続を待たせる。 */
    isRunInFlight: () => false,
    /** 再起動で回収済みの旧要求が再配送されないかを、初回と同じID列に記録する。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
  });
  const refreshEntered = deferred<void>();
  const refreshComplete = deferred<void>();
  const starting = second.start(async () => {
    refreshEntered.resolve();
    await refreshComplete.promise;
  });
  await refreshEntered.promise;
  assert.deepEqual(ids, ["first"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "failed", "queued"],
  );
  refreshComplete.resolve();
  await starting;
  await second.waitForPending();
  assert.deepEqual(ids, ["first", "follower"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "failed", "completed"],
  );
  await second.close();
});

// @test-value v2
// kind = "contract"
// claim = "terminal保存返信と正本照会が不明な間は後続を保留し、後の正本確認で元要求を再実行せず実guard解放後に後続を進める"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Decision" }
// fault = "結果不明で後続を開始する、正本確認後も保留し続ける、確認済み要求を再実行する、または実guardを無視する"
// observable = "保存返信失敗中・正本確認後・guard解放後のdispatch ID列とreceipt state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue unknown terminal commit"
// lifecycle = "permanent"
// impact = "保存結果不明を成功扱いして次の外部操作を開始する"
// distinction = "SQLite testでは非同期Worker返信喪失後のservice保留を再現できない"
// @end-test-value
/** 終端書き込みと正本照会が不明な間は配送を止め、確認後も元を再実行せず実ガードの解除を待つ。 */
test("terminal保存返信が不明なら後続を保留し後の正本確認で回復する", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  store.settle = async (...args) => {
    await settle(...args);
    throw new Error("commit reply lost");
  };
  const getReceipt = store.getReceipt;
  let readFails = true;
  store.getReceipt = async (...args) => {
    if (readFails) throw new Error("canonical read unavailable");
    return getReceipt(...args);
  };
  const ids: string[] = [];
  let guarded = false;
  const service = new SessionTurnQueueService({
    store,
    /** 永続状態の確定後も外部の実行が続く条件を再現する。 */
    isRunInFlight: () => guarded,
    /** 曖昧な終端保存を戻った後に同じ受付が再実行されたかをID列へ残す。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
  });
  await service.enqueue(owner, captured("first"));
  await flush();
  await service.enqueue(owner, captured("second"));
  service.wake(owner.sessionId);
  await flush();
  assert.deepEqual(ids, ["first"]);
  assert.equal(rows[1]!.state, "queued");
  readFails = false;
  guarded = true;
  const terminal = await store.getReceipt(owner, "first");
  assert.equal(terminal?.state, "completed");
  service.reconcileKnownReceipt(terminal!);
  service.reconcileKnownReceipt(terminal!);
  await service.waitForPending();
  assert.deepEqual(
    ids,
    ["first"],
    "canonical completion does not release the runtime guard",
  );
  guarded = false;
  service.wake(owner.sessionId);
  await service.waitForPending();
  assert.deepEqual(ids, ["first", "second"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "completed"],
  );
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "quit中止で受付と未claimキューを再開し、永久close後には再開しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md App Quit" }
// fault = "quit取消後にもキューを停止したままにするかDB終了後に再受付する"
// observable = "resume後のdispatch ID列とclose後の受付拒否"
// observation_boundary = "component-behavior"
// scope = "Main durable queue reversible shutdown"
// lifecycle = "permanent"
// distinction = "型検査とstore testでは停止を取り消すservice lifecycleを確認できない"
// @end-test-value
/** quitを取り消したときは受付と未claimキューを再開し、永久closeを経た後は再び受付しない。 */
test("quit中止のresumeはキューを再開するがcloseは永久停止する", async () => {
  const { store } = boundary();
  let guarded = true;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({
    store,
    /** quit取消後のガード解除を任意の時点で再現する。 */
    isRunInFlight: () => guarded,
    /** resume前後に始まる要求を記録し、それぞれを完了させる。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
  });
  await service.enqueue(owner, captured("first"));
  await flush();
  service.beginShutdown();
  await service.waitForPending();
  guarded = false;
  service.wake(owner.sessionId);
  assert.throws(
    () => service.enqueue(owner, captured("second")),
    /shutting down/,
  );
  await flush();
  assert.deepEqual(ids, []);
  service.resume();
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  await service.close();
  service.resume();
  assert.throws(
    () => service.enqueue(owner, captured("third")),
    /shutting down/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "保存返信喪失はcanonical終端の照会でのみ解決しmutationとproviderを再実行しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Decision" }
// fault = "結果確認のため保存mutationや実行を再試行して外部作用を重複する"
// observable = "dispatch ID列とsettle呼出し数、後続の完了state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue canonical terminal reconciliation"
// lifecycle = "permanent"
// impact = "commit結果不明の自動mutation retryは別作用の重複や状態不一致につながる"
// distinction = "実Workerでは再現困難なcommit済み応答喪失をservice境界で検証する"
// @end-test-value
/** 保存応答の喪失は正本の終端照会で解決し、終端変異やProvider呼び出しを再実行しない。 */
test("保存返信喪失は正本の終端照会で解決し再実行しない", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  let settles = 0;
  store.settle = async (...args) => {
    settles += 1;
    await settle(...args);
    throw new Error("reply lost");
  };
  const ids: string[] = [];
  const service = new SessionTurnQueueService({
    store,
    /** 保存応答の回復以外の要因で後続が止まらないようガードなしとする。 */
    isRunInFlight: () => false,
    /** 正本照会で回復する前後に実行した受付を同じ記録へ追加する。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      return { state: "completed" };
    },
  });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  assert.equal(settles, 2);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "completed"],
  );
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "旧incarnationのclaim/dispatch/terminal照会失敗は同ID再作成後のキューを保留せず実guardは維持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Delete" }
// fault = "遅延した旧owner失敗をsessionIdだけでblockedに記録し新ownerのFIFO進行を停止する"
// observable = "再作成ownerの受付receiptとguard解放前後のdispatch ID列・完了state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue incarnation fencing"
// lifecycle = "permanent"
// impact = "削除後に同IDで再作成したSessionが旧実行結果に汚染され受付済み要求を実行できなくなる"
// distinction = "store owner検証と型検査ではservice内のawait後に遅延errorが別ownerを保留する競合を検知できない"
// @end-test-value
/** 古い世代のclaim・dispatch・照会が遅れて失敗しても、新世代の受付に引き継がず実ガードだけを維持する。 */
test("旧ownerの遅延失敗は再作成ownerを保留しない", async () => {
  for (const stage of ["claim", "dispatch", "terminal-read"] as const) {
    const { store, rows } = boundary();
    const started = deferred<void>();
    const finish = deferred<void>();
    const replacement = { ...owner, incarnationId: "replacement" };
    const claim = store.claimNext;
    const settle = store.settle;
    if (stage === "claim") {
      store.claimNext = async (owned) => {
        if (owned.incarnationId !== owner.incarnationId) return claim(owned);
        started.resolve();
        await finish.promise;
        throw new Error("old claim reply lost");
      };
    }
    if (stage === "terminal-read") {
      store.settle = async (...args) => {
        if (args[0].incarnationId === owner.incarnationId)
          throw new Error("old terminal reply lost");
        return settle(...args);
      };
      store.getReceipt = async () => {
        started.resolve();
        await finish.promise;
        throw new Error("old canonical read failed");
      };
    }
    let guarded = false;
    const ids: string[] = [];
    const service = new SessionTurnQueueService({
      store,
      /** 対象世代が変わった場合も本物の実行ガード状態を返す。 */
      isRunInFlight: () => guarded,
      /** 旧世代のdispatchだけを遅延失敗させ、新世代が同じ失敗経路に入らないことを観測する。 */
      dispatch: async (receipt) => {
        ids.push(receipt.id);
        if (
          receipt.incarnationId === owner.incarnationId &&
          stage === "dispatch"
        ) {
          started.resolve();
          await finish.promise;
          throw new Error("old dispatch unknown");
        }
        return { state: "completed" };
      },
    });
    if (stage === "claim")
      service.acceptCommittedReceipt(
        await store.enqueue(owner, captured("old-request")),
      );
    else await service.enqueue(owner, captured("old-request"));
    await started.promise;
    guarded = true;
    const accepting = service.enqueue(replacement, captured("new-request"));
    // claim は応答まで短時間の Session ロックを保持する。他の失敗箇所の待機は
    // そのロックの外にあり、新しい所有者での受付が完了した後に終了できる。
    if (stage === "claim") finish.resolve();
    assert.equal((await accepting).incarnationId, replacement.incarnationId);
    if (stage !== "claim") finish.resolve();
    await service.waitForPending();
    assert.deepEqual(ids, stage === "claim" ? [] : ["old-request"]);
    guarded = false;
    service.wake(owner.sessionId);
    await service.waitForPending();
    assert.deepEqual(
      ids,
      stage === "claim" ? ["new-request"] : ["old-request", "new-request"],
    );
    assert.equal(
      rows.find((row) => row.id === "new-request")!.state,
      "completed",
    );
    await service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "dispatch返信喪失後もcanonical terminalが確認できれば再実行せず収束し実guard解放後にFIFOを進める"
// oracle = { type = "contract", ref = "src-shared/session/session-turn-queue.ts SessionTurnQueueStore.settle; docs/design/session-run-lifecycle.md Session Run Cancel" }
// fault = "確認済みterminalをinterruptedへ退行/永久保留するか実guardを無視して後続を開始する"
// observable = "canonical receipt stateとdispatch ID列、guard解放前後の後続状態"
// observation_boundary = "component-behavior"
// scope = "Main durable queue dispatch lost reply canonical terminal convergence"
// lifecycle = "permanent"
// impact = "外部操作の重複と保存済み完了要求による後続の不要な保留を防ぐ"
// distinction = "runtime/store単独ではdispatch throw後のcanonical terminal返却とserviceのguard判定の結合を確認できない"
// @end-test-value
/** dispatch応答を失っても保存済み終端を優先し、元の再実行を省いて実ガード解除後にFIFOを進める。 */
test("dispatch返信喪失はcanonical terminalへ収束し実guardを維持する", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  store.settle = async (...args) => {
    const current = rows.find((row) => row.id === args[1])!;
    if (["completed", "failed", "canceled"].includes(current.state))
      return structuredClone(current);
    return settle(...args);
  };
  let guarded = false;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({
    store,
    /** 保存結果の確認で上書きされない外部ガードの状態を返す。 */
    isRunInFlight: () => guarded,
    /** 先頭の正本を終端へ進めてから応答喪失を再現し、後続が渡った時点もIDで記録する。 */
    dispatch: async (receipt) => {
      ids.push(receipt.id);
      if (receipt.id === "first") {
        await settle(receipt, receipt.id, "completed");
        guarded = true;
        throw new Error("terminal reply lost");
      }
      return { state: "completed" };
    },
  });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await service.waitForPending();
  assert.deepEqual(ids, ["first"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "queued"],
  );
  guarded = false;
  service.wake(owner.sessionId);
  await service.waitForPending();
  assert.deepEqual(ids, ["first", "second"]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ["completed", "completed"],
  );
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "同一の不明受付を正本確認できた場合にだけ、その結果を変更せず後続FIFOと新規入力を進める"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "実guard中や照会／回収保存の結果不明時に次の入力を開始する、全件回収する、不明受付を再実行する、または証拠確認後も後続を止める"
// observable = "不明受付の再読込、回収引数のowner/incarnation/receipt ID、確認前後のdispatch ID列"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueServiceの不明な通常dispatch後の稼働中の正本照合"
// lifecycle = "permanent"
// @end-test-value
/** 稼働中の照合が不明なら停止し、永続したinterruptedが確認できてから元を再送せず後続と新規入力を開始する。 */
test("稼働中の照合不明は止め、永続したinterruptedの確認後は元入力を再送せず進める", async () => {
  for (const fault of ["read", "write"] as const) {
    const { store, rows } = boundary();
    const dispatches: string[] = [];
    const recoveries: Array<Parameters<typeof store.recoverInterrupted>[0]> =
      [];
    const getReceipt = store.getReceipt;
    let guarded = false;
    let unavailable = false;
    store.getReceipt = async (...args) => {
      if (fault === "read" && unavailable)
        throw new Error("Cannot read the saved receipt.");
      return getReceipt(...args);
    };
    store.recoverInterrupted = async (target) => {
      recoveries.push(target);
      if (fault === "write" && unavailable)
        throw new Error("Recovery reply lost.");
      return 0; // 中断されたこの受付記録に対応する Turn は特定できない。
    };
    const service = new SessionTurnQueueService({
      store,
      /** 元のdispatch後に実行ガードが上がる状態を返す。 */
      isRunInFlight: () => guarded,
      /** 最初の配送だけ応答を失わせ、確認復旧前後の実行IDを順に観測する。 */
      dispatch: async (receipt) => {
        dispatches.push(receipt.id);
        if (receipt.id === "first") {
          guarded = true;
          throw new Error("Dispatch reply lost.");
        }
        return { state: "completed" };
      },
    });
    try {
      await service.enqueue(owner, captured("first"));
      await service.waitForPending();
      const interrupted = structuredClone(rows[0]!);
      assert.equal(interrupted.state, "interrupted");
      await service.enqueue(owner, captured("second"));
      await service.waitForPending();
      assert.equal(recoveries.length, 0);
      assert.deepEqual(dispatches, ["first"]);
      unavailable = true;
      guarded = false;
      service.wake(owner.sessionId);
      await service.waitForPending();
      assert.deepEqual(dispatches, ["first"]);
      assert.equal(rows[1]?.state, "queued");
      unavailable = false;
      await service.enqueue(owner, captured("new"));
      await service.waitForPending();
      assert.deepEqual(dispatches, ["first", "second", "new"]);
      assert.deepEqual(
        recoveries,
        Array(fault === "read" ? 1 : 2).fill({ ...owner, receiptId: "first" }),
      );
      assert.deepEqual(await store.getReceipt(owner, "first"), interrupted);
    } finally {
      await service.close();
    }
  }
});
