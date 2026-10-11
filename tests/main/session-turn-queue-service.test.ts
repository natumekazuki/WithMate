import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { QueuedInputPreDispatchError, SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";

const owner = { sessionId: "session", incarnationId: "incarnation" };
function captured(id: string): SessionTurnQueueCapturedInput {
  return {
    request: { clientRequestId: id, userMessage: id, executionOptions: {
      catalogRevision: 1, model: "model", reasoningEffort: "medium", approvalMode: "on-request",
      codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
    } }, attachments: [], provider: "codex", workspacePath: "workspace",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { await setImmediate(); }
function boundary() {
  const rows: SessionTurnQueueReceipt[] = [];
  const update = (id: string, state: SessionTurnQueueReceipt["state"], reason?: string) => {
    const row = rows.find((entry) => entry.id === id)!;
    row.state = state;
    row.reason = reason ?? null;
    return structuredClone(row);
  };
  const store: SessionTurnQueueStore = {
    enqueue: async (owned, input) => {
      const row: SessionTurnQueueReceipt = {
        ...owned, id: input.request.clientRequestId, requestId: input.request.clientRequestId, sequence: rows.length + 1,
        state: "queued", captured: structuredClone(input), turnId: null, userMessageSeq: null, reason: null, releasedAt: null,
        createdAt: "now", updatedAt: "now",
      };
      rows.push(row);
      return structuredClone(row);
    },
    getReceipt: async (owned, requestId) => rows.find((row) => row.incarnationId === owned.incarnationId && row.requestId === requestId) ?? null,
    listActive: async () => rows.filter((row) => ["queued", "starting", "running", "interrupted"].includes(row.state)),
    listReceipts: async () => ({ receipts: structuredClone(rows), nextCursor: null }),
    listPendingOwners: async () => rows.length ? [owner] : [],
    claimNext: async (owned) => {
      const ownedRows = rows.filter((row) => row.incarnationId === owned.incarnationId && row.sessionId === owned.sessionId);
      if (ownedRows.some((row) => row.state === "starting" || row.state === "running" || (row.state === "interrupted" && row.releasedAt === null))) return null;
      const row = ownedRows.find((row) => row.state === "queued");
      return row ? update(row.id, "starting") : null;
    },
    claimForInput: async (_, id, inputTurnId) => {
      const row = rows.find((entry) => entry.id === id)!;
      assert.equal(row.state, "queued");
      row.inputTurnId = inputTurnId;
      return update(id, "starting");
    },
    restoreQueuedInput: async (_, id, inputTurnId) => {
      const row = rows.find((entry) => entry.id === id)!;
      assert.equal(row.inputTurnId, inputTurnId);
      row.inputTurnId = null;
      return update(id, "queued");
    },
    markStarted: async (_, id, input) => {
      Object.assign(rows.find((row) => row.id === id)!, input);
      return update(id, "running");
    },
    settle: async (_, id, state, reason) => update(id, state, reason),
    cancelQueued: async (_, id) => {
      assert.equal(rows.find((row) => row.id === id)!.state, "queued");
      return update(id, "canceled");
    },
    recoverInterrupted: async () => {
      const claimed = rows.filter((row) => row.state === "starting" || row.state === "running");
      claimed.forEach((row) => update(row.id, "interrupted"));
      return claimed.length;
    },
    releaseInterrupted: async (_, id) => {
      assert.equal(rows.find((row) => row.id === id)!.state, "interrupted");
      rows.find((row) => row.id === id)!.releasedAt = "now";
      return structuredClone(rows.find((row) => row.id === id)!);
    },
  };
  return { rows, store };
}

// @test-value v2
// kind = "contract"
// claim = "queued入力は未dispatch証明時だけqueuedへ戻り、dispatch結果不明は後続を保留し、commit返信喪失はcompletedへ収束する"
// oracle = { type = "contract", ref = "GitHub Issue #801: queued item current-turn input and unknown no replay" }
// fault = "結果不明入力をqueuedへ戻し重複送信するか、後続を自動開始する"
// observable = "receipt stateとprovider入力回数、後続dispatch回数"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService.sendQueuedInput"
// lifecycle = "permanent"
// impact = "外部操作の重複実行と未送信指示の消失を防ぐ"
// distinction = "storage遷移testではprovider失敗分類と自動drainの接続を確認できない"
// @end-test-value
test("queued inputはdispatch境界を区別し正本completedを優先する", async () => {
  for (const mode of ["preflight", "unknown", "committed"] as const) {
    const { store, rows } = boundary();
    let guarded = true;
    let dispatched = 0;
    let inputs = 0;
    const service = new SessionTurnQueueService({ store, isRunInFlight: async () => guarded,
      dispatch: async () => { dispatched += 1; return { state: "completed" }; },
      sendInput: async (receipt) => {
        inputs += 1;
        if (mode === "preflight") throw new QueuedInputPreDispatchError("not dispatched");
        if (mode === "committed") await store.settle(receipt, receipt.id, "completed");
        throw new Error("reply lost");
      },
    });
    await service.enqueue(owner, captured("input"));
    await service.enqueue(owner, captured("follower"));
    if (mode === "committed") assert.equal((await service.sendQueuedInput(owner, "input", "provider-turn")).state, "completed");
    else await assert.rejects(service.sendQueuedInput(owner, "input", "provider-turn"), mode === "preflight" ? /not dispatched/ : /reply lost/);
    assert.equal(rows[0]!.state, mode === "preflight" ? "queued" : mode === "unknown" ? "interrupted" : "completed");
    assert.equal(inputs, 1);
    if (mode === "unknown") {
      guarded = false;
      service.wake(owner.sessionId);
      await flush();
      assert.equal(dispatched, 0);
      assert.equal(rows[1]!.state, "queued");
    }
    await service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "input claim返信喪失はProvider未送信証明でqueuedへ戻り、restore失敗は明示解放可能なinterruptedとして保留する"
// oracle = { type = "contract", ref = "GitHub Issue #801: pre-provider queued input recovery and unknown no replay" }
// fault = "claim返信喪失をstartingへ固定するかProviderを送信し、restore不明を再実行する"
// observable = "receipt state、入力とrestore回数、明示解放前後のFIFO dispatch"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService.sendQueuedInput claim failure recovery"
// lifecycle = "permanent"
// impact = "未送信指示の回復不能と外部操作の重複を防ぐ"
// distinction = "storage単体testはserviceのclaim返信喪失とProvider非dispatchを検知しない"
// @end-test-value
test("queued input claim ACK喪失は未送信のまま回復する", async () => {
  for (const mode of ["restored", "restore-reply-lost", "restore-failed"] as const) {
    const { store, rows } = boundary();
    const claim = store.claimForInput;
    const restore = store.restoreQueuedInput;
    let restores = 0;
    let inputs = 0;
    let guarded = true;
    const dispatched: string[] = [];
    store.claimForInput = async (...args) => { await claim(...args); throw new Error("claim reply lost"); };
    store.restoreQueuedInput = async (...args) => {
      restores += 1;
      if (mode === "restore-failed") throw new Error("restore unavailable");
      const receipt = await restore(...args);
      if (mode === "restore-reply-lost") throw new Error("restore reply lost");
      return receipt;
    };
    const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded,
      sendInput: async () => { inputs += 1; },
      dispatch: async (receipt) => { dispatched.push(receipt.id); return { state: "completed" }; },
    });
    await service.enqueue(owner, captured("input"));
    await service.enqueue(owner, captured("follower"));
    await assert.rejects(service.sendQueuedInput(owner, "input", "provider-turn"), /claim reply lost/);
    assert.equal(inputs, 0);
    assert.equal(restores, 1);
    assert.equal(rows[0]!.state, mode === "restore-failed" ? "interrupted" : "queued");
    guarded = false;
    service.wake(owner.sessionId);
    await flush();
    if (mode === "restore-failed") {
      assert.deepEqual(dispatched, []);
      await service.releaseInterrupted(owner, "input");
      await flush();
      assert.deepEqual(dispatched, ["follower"]);
    } else assert.deepEqual(dispatched, ["input", "follower"]);
    await service.close();
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
test("FIFOは実guard解放まで後続を保留する", async () => {
  const { store, rows } = boundary();
  let guarded = true;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded, dispatch: async (receipt, started) => {
    ids.push(receipt.id);
    await started({ turnId: `turn-${receipt.id}`, userMessageSeq: receipt.sequence });
    guarded = true;
    return { state: "canceled" };
  } });
  await Promise.all([service.enqueue(owner, captured("first")), service.enqueue(owner, captured("second"))]);
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
// claim = "不明実行を再送せず後続を保留し、明示回復後もguardを尊重する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Persistence Expectations" }
// fault = "throwした要求を再実行するか、回復操作で生存guardを無視する"
// observable = "dispatch要求IDと回復前後のreceipt state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue uncertain outcome recovery"
// lifecycle = "permanent"
// impact = "結果不明の要求の自動再送で外部操作が重複する"
// distinction = "storeのstate遷移だけではserviceの自動dispatchを観測できない"
// @end-test-value
test("不明実行の後続は明示回復と実guard解放を待つ", async () => {
  const { store, rows } = boundary();
  const ids: string[] = [];
  let guarded = false;
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded, dispatch: async (receipt) => {
    ids.push(receipt.id);
    if (receipt.id === "first") throw new Error("unknown");
    return { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await flush();
  service.wake(owner.sessionId);
  await flush();
  assert.deepEqual(ids, ["first"]);
  assert.equal(rows[0]!.state, "interrupted");
  guarded = true;
  await service.releaseInterrupted(owner, "first");
  await flush();
  assert.deepEqual(ids, ["first"]);
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
test("queuedの取消は現在runを継続させる", async () => {
  const { store, rows } = boundary();
  const terminal = deferred<{ state: "completed" }>();
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id);
    return receipt.id === "first" ? terminal.promise : { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await service.enqueue(owner, captured("third"));
  await service.cancelQueued(owner, "second");
  assert.deepEqual(ids, ["first"]);
  terminal.resolve({ state: "completed" });
  await flush();
  assert.deepEqual(ids, ["first", "third"]);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "canceled", "completed"]);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "shutdownは受付と後続dispatchを止め、受付済み保存と現在runの終端保存を待つ"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md App Quit" }
// fault = "closeを保存完了前に返すかshutdown開始後に後続をdispatchする"
// observable = "close完了の時点、enqueue結果、dispatch ID、保存済みstate"
// observation_boundary = "component-behavior"
// scope = "Main durable queue shutdown persistence"
// lifecycle = "permanent"
// impact = "DB close後の遅延保存や未確定受付の喪失につながる"
// distinction = "型検査ではpending mutationとdispatchの非同期待機を検証できない"
// @end-test-value
test("closeは受付済みmutationと実行終端を待ち後続を開始しない", async () => {
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
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id);
    return terminal.promise;
  } });
  await service.enqueue(owner, captured("first"));
  await flush();
  const commit = deferred<void>();
  const enqueue = store.enqueue;
  store.enqueue = async (...args) => { await commit.promise; return enqueue(...args); };
  const accepted = service.enqueue(owner, captured("second"));
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  assert.throws(() => service.enqueue(owner, captured("third")), /shutting down/);
  terminal.resolve({ state: "completed" });
  await settling.promise;
  await flush();
  assert.equal(closed, false);
  commit.resolve();
  assert.equal((await accepted).state, "queued");
  await flush();
  assert.equal(closed, false);
  assert.equal(rows[0]!.state, "starting");
  terminalCommit.resolve();
  await closing;
  assert.deepEqual(ids, ["first"]);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "queued"]);
});

// @test-value v2
// kind = "contract"
// claim = "ACKは保存commit後だけ返しobserver例外は受理と後続dispatchを壊さない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Window Close" }
// fault = "保存前に受付ACKするか投影通知例外を保存失敗として扱う"
// observable = "enqueue完了時点と返却receipt、dispatch ID列"
// observation_boundary = "component-behavior"
// scope = "Main durable queue acceptance notification"
// lifecycle = "permanent"
// distinction = "store testではserviceのACKと投影例外境界を観測できない"
// @end-test-value
test("受理ACKはcommitを待ちobserver失敗でもdrainする", async () => {
  const { store } = boundary();
  const commit = deferred<void>();
  const enqueue = store.enqueue;
  store.enqueue = async (...args) => { await commit.promise; return enqueue(...args); };
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false,
    dispatch: async (receipt) => { ids.push(receipt.id); return { state: "completed" }; },
    onChanged: () => { throw new Error("observer"); },
  });
  let acknowledged = false;
  const accepting = service.enqueue(owner, captured("first")).then((receipt) => { acknowledged = true; return receipt; });
  await flush();
  assert.equal(acknowledged, false);
  assert.deepEqual(ids, []);
  commit.resolve();
  assert.equal((await accepting).id, "first");
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "restartは未claimのみを再開しclaim済み要求をinterruptedへ回収して後続を保留する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Persistence Expectations" }
// fault = "restart時にclaim済み要求を自動再実行するか後続を先行実行する"
// observable = "start後のdispatch ID列とreceipt state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue startup reconciliation"
// lifecycle = "permanent"
// impact = "crash直前に開始済みの外部操作を再実行してしまう"
// distinction = "store recoveryだけでは起動後のservice dispatch対象を保証できない"
// @end-test-value
test("startは未claimを再開しclaim済みは再実行しない", async () => {
  const { store, rows } = boundary();
  await store.enqueue(owner, captured("first"));
  const ids: string[] = [];
  const first = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id); return { state: "completed" };
  } });
  await first.start();
  await flush();
  assert.deepEqual(ids, ["first"]);
  await first.close();
  await store.enqueue(owner, captured("claimed"));
  await store.claimNext(owner);
  await store.enqueue(owner, captured("follower"));
  const second = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id); return { state: "completed" };
  } });
  await second.start();
  await flush();
  assert.deepEqual(ids, ["first"]);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "interrupted", "queued"]);
  await second.close();
});

// @test-value v2
// kind = "contract"
// claim = "terminal保存返信が不明で正本照会も失敗したとき同process内のwakeや追加受付で後続を実行しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Decision" }
// fault = "terminal保存返信喪失後、正本照会も失敗したのに確認済み終端と推定して次要求を実行する"
// observable = "保存返信失敗後のdispatch ID列と追加受付のqueued state"
// observation_boundary = "component-behavior"
// scope = "Main durable queue unknown terminal commit"
// lifecycle = "permanent"
// impact = "保存結果不明を成功扱いして次の外部操作を開始する"
// distinction = "SQLite testでは非同期Worker返信喪失後のservice保留を再現できない"
// @end-test-value
test("terminal保存返信が不明なら追加受付も後続dispatchしない", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  store.settle = async (...args) => { await settle(...args); throw new Error("commit reply lost"); };
  store.getReceipt = async () => { throw new Error("canonical read unavailable"); };
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id); return { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await flush();
  await service.enqueue(owner, captured("second"));
  service.wake(owner.sessionId);
  await flush();
  assert.deepEqual(ids, ["first"]);
  assert.equal(rows[1]!.state, "queued");
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
test("quit中止のresumeはキューを再開するがcloseは永久停止する", async () => {
  const { store } = boundary();
  let guarded = true;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded, dispatch: async (receipt) => {
    ids.push(receipt.id); return { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await flush();
  service.beginShutdown();
  await service.waitForPending();
  guarded = false;
  service.wake(owner.sessionId);
  assert.throws(() => service.enqueue(owner, captured("second")), /shutting down/);
  await flush();
  assert.deepEqual(ids, []);
  service.resume();
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  await service.close();
  service.resume();
  assert.throws(() => service.enqueue(owner, captured("third")), /shutting down/);
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
test("保存返信喪失は正本の終端照会で解決し再実行しない", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  let settles = 0;
  store.settle = async (...args) => { settles += 1; await settle(...args); throw new Error("reply lost"); };
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: async (receipt) => {
    ids.push(receipt.id); return { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await flush();
  assert.deepEqual(ids, ["first", "second"]);
  assert.equal(settles, 2);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "completed"]);
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
        if (args[0].incarnationId === owner.incarnationId) throw new Error("old terminal reply lost");
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
    const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded, dispatch: async (receipt) => {
      ids.push(receipt.id);
      if (receipt.incarnationId === owner.incarnationId && stage === "dispatch") {
        started.resolve();
        await finish.promise;
        throw new Error("old dispatch unknown");
      }
      return { state: "completed" };
    } });
    await service.enqueue(owner, captured("old-request"));
    await started.promise;
    guarded = true;
    const accepting = service.enqueue(replacement, captured("new-request"));
    // A claim holds the short Session lock until its reply; other failure gates
    // are outside that lock and can complete strictly after new-owner acceptance.
    if (stage === "claim") finish.resolve();
    assert.equal((await accepting).incarnationId, replacement.incarnationId);
    if (stage !== "claim") finish.resolve();
    await service.waitForPending();
    assert.deepEqual(ids, stage === "claim" ? [] : ["old-request"]);
    guarded = false;
    service.wake(owner.sessionId);
    await service.waitForPending();
    assert.deepEqual(ids, stage === "claim" ? ["new-request"] : ["old-request", "new-request"]);
    assert.equal(rows.find((row) => row.id === "new-request")!.state, "completed");
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
test("dispatch返信喪失はcanonical terminalへ収束し実guardを維持する", async () => {
  const { store, rows } = boundary();
  const settle = store.settle;
  store.settle = async (...args) => {
    const current = rows.find((row) => row.id === args[1])!;
    if (["completed", "failed", "canceled"].includes(current.state)) return structuredClone(current);
    return settle(...args);
  };
  let guarded = false;
  const ids: string[] = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => guarded, dispatch: async (receipt) => {
    ids.push(receipt.id);
    if (receipt.id === "first") {
      await settle(receipt, receipt.id, "completed");
      guarded = true;
      throw new Error("terminal reply lost");
    }
    return { state: "completed" };
  } });
  await service.enqueue(owner, captured("first"));
  await service.enqueue(owner, captured("second"));
  await service.waitForPending();
  assert.deepEqual(ids, ["first"]);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "queued"]);
  guarded = false;
  service.wake(owner.sessionId);
  await service.waitForPending();
  assert.deepEqual(ids, ["first", "second"]);
  assert.deepEqual(rows.map((row) => row.state), ["completed", "completed"]);
  await service.close();
});
