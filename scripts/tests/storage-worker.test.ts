import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { StorageWorkerClient, StorageWorkerGenerationError, StorageWorkerRemoteError } from "../../src-electron/storage-worker-client.js";
import { MemoryV6FileQuotaExceededError } from "../../src-electron/memory-v6-storage.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage-worker-bundle.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { createPersistentStoreLifecycleService } from "../../src-electron/persistent-store-lifecycle-service.js";

function createFixtureWorkerUrl(): URL {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    setTimeout(() => parentPort.postMessage({ type: "ready", generationId: workerData.generationId }), 10);
    parentPort.on("message", (message) => {
      if (message.type === "shutdown") {
        parentPort.postMessage({ type: "shutdown-complete", requestId: message.requestId, generationId: workerData.generationId });
        parentPort.close();
        return;
      }
      if (message.command === "echo") {
        parentPort.postMessage({ type: "started", requestId: message.context.requestId, generationId: workerData.generationId, queueWaitMs: 0.1 });
        parentPort.postMessage({ type: "result", requestId: message.context.requestId, generationId: workerData.generationId, value: message.payload });
      } else if (message.command === "hang") {
        return;
      } else if (message.command === "exit") {
        process.exit(1);
      } else if (message.command === "bad-frame") {
        parentPort.postMessage({ type: "result", generationId: workerData.generationId, value: "missing-request-id" });
      } else if (message.command === "typed-error") {
        parentPort.postMessage({ type: "error", requestId: message.context.requestId, generationId: workerData.generationId, name: "MemoryV6FileQuotaExceededError", code: "MEMORY_V6_FILE_QUOTA_EXCEEDED", message: "Memory V6 file quota would be exceeded.", details: { quotaBytes: 10, usedBytes: 8, incomingBytes: 5 } });
      } else {
        parentPort.postMessage({ type: "error", requestId: message.context.requestId, generationId: workerData.generationId, name: "CommandError", message: "not allowed" });
      }
    });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

// @test-value v2
// kind = "contract"
// claim = "Storage worker は許可されたMemoryドメイン例外の型と詳細をtransport越しに復元する"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "quota競合が汎用RemoteErrorとなり、HTTP層が正しいエラー分類や残量詳細を失う"
// observable = "worker callの拒否エラーのinstanceofとquota詳細"
// observation_boundary = "public-boundary"
// scope = "storage-worker-domain-errors"
// lifecycle = "permanent"
// impact = "Memory file quota応答とretry判断がWorker境界の前後で同一契約になる"
// distinction = "型検査では確認できないtransportのエラー型・詳細復元を実動作で確認する"
// @end-test-value
test("storage worker rehydrates allowlisted memory domain errors", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), { type: "module", workerData: {} });
  try {
    await assert.rejects(() => client.call("typed-error", null), (error: unknown) => {
      assert.ok(error instanceof MemoryV6FileQuotaExceededError);
      assert.equal(error.quotaBytes, 10);
      assert.equal(error.usedBytes, 8);
      assert.equal(error.incomingBytes, 5);
      return true;
    });
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Storage worker client は ready 前の要求を保持し、generation を維持して応答を返す"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "ready 前の要求を破棄するか、別 generation の応答を現在の要求として適用する"
// observable = "ready前に発行したworker呼出しの戻り値"
// observation_boundary = "public-boundary"
// scope = "storage-worker-transport"
// lifecycle = "permanent"
// impact = "Main の非同期 caller が起動直後の storage 要求を失わず、旧 Worker の応答を誤適用しない"
// distinction = "typecheck では確認できない Worker 起動と要求キューの実動作を確認する"
// @end-test-value
test("storage worker client queues calls until ready and returns queued work", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), {
    type: "module",
    workerData: {},
  });
  try {
    const result = await client.call<{ value: number }>("echo", { value: 3 });
    assert.deepEqual(result, { value: 3 });
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "regression"
// claim = "Storage worker の異常終了で送信済みmutationを成功扱いせず、後続要求を閉じる"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "送信済み書込みの結果を失った後も成功扱いするか、停止済みWorkerへ後続要求を送り未解決Promiseを残す"
// observable = "送信済みmutationの拒否エラーと異常終了後の新規callの拒否"
// observation_boundary = "public-boundary"
// scope = "storage-worker-fault"
// lifecycle = "permanent"
// impact = "不明なcommit結果を自動再実行せず、旧generationへの書込みを防ぐ"
// distinction = "build や型検査では確認できない Worker exit 後のPromise settlementを確認する"
// @end-test-value
test("storage worker client rejects sent mutations after worker exit", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), {
    type: "module",
    workerData: {},
  });
  await client.call("echo", { ready: true });
  try {
    const pending = client.call("exit", null, { mutation: true });
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "StorageWorkerUnknownOutcomeError");
    await assert.rejects(() => client.call("echo", null), StorageWorkerGenerationError);
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Storage workerの読み取り結果不明はunknown writeと区別される"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "読み取りの未完了をmutationと同じunknown outcomeへ誤分類する"
// observable = "Worker exit後のread拒否エラー名"
// observation_boundary = "public-boundary"
// scope = "storage-worker-fault"
// lifecycle = "permanent"
// impact = "read callerが不要な書込み再試行禁止状態にならない"
// distinction = "型検査では送信済みreadとmutationのfault分類を確認できない"
// @end-test-value
test("storage worker client keeps interrupted reads distinct from unknown writes", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), { type: "module", workerData: {} });
  await client.call("echo", { ready: true });
  try {
    const pending = client.call("exit", null);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name !== "StorageWorkerUnknownOutcomeError");
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Storage worker diagnosticは単一requestのstageとrequestIdを一貫して通知する"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "diagnosticのstageを欠落させるか、異なるrequestIdのイベントを混ぜる"
// observable = "単一requestのqueued/started/completedとrequestId"
// observation_boundary = "public-boundary"
// scope = "storage-worker-diagnostics"
// lifecycle = "permanent"
// impact = "呼び出し単位のWorker処理状態を追跡できる"
// distinction = "buildではdiagnostic stageとrequest correlationを確認できない"
// @end-test-value
test("storage worker diagnostics report request correlation and worker timings", async () => {
  const events: Array<{ stage: string; requestId?: string; waitMs?: number; holdMs?: number }> = [];
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), {
    type: "module",
    workerData: {},
    diagnosticSink: (event) => events.push(event),
  });
  try {
    await client.call("echo", { diagnostics: true }, { operation: "session.getSession" });
    const ownEvents = events.filter((event) => event.requestId);
    assert.deepEqual(ownEvents.map((event) => event.stage), ["queued", "started", "completed"]);
    assert.equal(new Set(ownEvents.map((event) => event.requestId)).size, 1);
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Storage worker client の close 後は旧 generation への新規要求を拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "close 後の caller が停止済み Worker へ要求を送り、未解決 Promise または旧 DB への書込みを残す"
// observable = "close 後の call が返すエラー"
// observation_boundary = "public-boundary"
// scope = "storage-worker-generation"
// lifecycle = "permanent"
// impact = "reset/reopen 後に旧 storage generation へ保存しない"
// distinction = "型検査や build では確認できない close 後の公開API拒否を確認する"
// @end-test-value
test("storage worker client rejects calls after generation close", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), {
    type: "module",
    workerData: {},
  });
  await client.close();
  await assert.rejects(() => client.call("echo", null), StorageWorkerGenerationError);
});

// @test-value v2
// kind = "regression"
// claim = "Storage worker へのstructured clone失敗を未送信DataCloneErrorとして解決し、Workerを継続利用できる"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "postMessageのclone例外後にPromiseが残るか、Worker全体を不要に停止する"
// observable = "clone失敗したmutationのDataCloneErrorと後続echoの成功"
// observation_boundary = "public-boundary"
// scope = "storage-worker-transport"
// lifecycle = "permanent"
// impact = "送信されていない要求だけを解放し、同じWorkerの後続要求を維持する"
// distinction = "実Workerへのstructured clone境界を通らない型検査では検出できない"
// @end-test-value
test("storage worker client settles structured clone failures without leaking pending work", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), { type: "module", workerData: {} });
  try {
    await client.call("echo", null);
    await assert.rejects(
      client.call("echo", () => undefined, { mutation: true }),
      (error: unknown) => error instanceof Error && error.name === "DataCloneError",
    );
    assert.deepEqual(await client.call("echo", { afterCloneError: true }), { afterCloneError: true });
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "読み取り要求の未許可commandはnot-executedとして返し、unknown outcomeを付けない"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "全てのWorker例外をunknown扱いして読み取りcallerへ誤った再実行禁止を伝える"
// observable = "未許可commandのStorageWorkerRemoteErrorとoutcome"
// observation_boundary = "public-boundary"
// scope = "storage-worker-dispatch"
// lifecycle = "permanent"
// impact = "実行されていない読み取りの失敗を正確に分類する"
// distinction = "entryのmutation分類は静的なdispatch確認だけでは検出できない"
// @end-test-value
test("storage worker classifies non-mutation command failures as not-executed", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), { type: "module", workerData: {} });
  try {
    await assert.rejects(
      client.call("not-allowed", null),
      (error: unknown) => {
        assert.ok(error instanceof StorageWorkerRemoteError);
        assert.equal(error.outcome, "not-executed");
        assert.equal(error.code, "STORAGE_WORKER_COMMAND_FAILED");
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "regression"
// claim = "不正なWorker frameはpendingを残さずWorker generationをfaultにする"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "requestId欠落のresultを受理して要求を未解決のまま残す"
// observable = "不正frame要求の拒否と後続要求のgeneration拒否"
// observation_boundary = "public-boundary"
// scope = "storage-worker-transport-validation"
// lifecycle = "permanent"
// impact = "Worker応答の不正な相関をDB callerへ適用せず、旧generationを閉じる"
// distinction = "型検査ではruntime message validationとpending解放を確認できない"
// @end-test-value
test("storage worker faults on malformed response frames", async () => {
  const client = new StorageWorkerClient(createFixtureWorkerUrl(), { type: "module", workerData: {} });
  try {
    await assert.rejects(client.call("bad-frame", null), Error);
    await assert.rejects(() => client.call("echo", null), StorageWorkerGenerationError);
  } finally {
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Character/MateのFS相当commandはresource laneで直列化し、Settings相当commandを待たせない"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "resource commandを全Worker tailへ置いて無関係な短いDB処理を待たせるか、同一laneを並列実行する"
// observable = "lane待機中のshort commandの完了と同一Mate laneの開始順"
// observation_boundary = "public-boundary"
// scope = "storage-worker-resource-lanes"
// lifecycle = "permanent"
// impact = "外部FS待ちを含むCharacter/Mate処理中も無関係なDB処理を進め、同じstoreの変更は直列化する"
// distinction = "通常のWorker call testではresource lane選択とlane間並行を確認できない"
// @end-test-value
test("storage worker resource lanes isolate unrelated work and serialize each resource", async () => {
  const laneReleaseBuffer = new SharedArrayBuffer(4);
  const client = new StorageWorkerClient(new URL("../../src-electron/storage-worker-entry.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData: {
      handlerModule: new URL("./storage-worker-lane-handler.ts", import.meta.url).href,
      laneReleaseBuffer,
    },
  });
  try {
    const characterWait = client.call("store.call", { store: "character", method: "wait", args: [] }, { mutation: true });
    const unrelated = await client.call<{ started: number; completed: number }>(
      "store.call",
      { store: "settings", method: "short", args: [] },
    );
    assert.deepEqual(unrelated, { started: 1, completed: 0 });

    const firstMate = client.call("store.call", { store: "mate", method: "wait", args: [] }, { mutation: true });
    const secondMate = client.call("store.call", { store: "mate", method: "wait", args: [] }, { mutation: true });
    await client.call("release", { store: "character" }, { mutation: false });
    const characterResult = await characterWait;
    assert.deepEqual(characterResult, { started: 2, completed: 1 });
    await client.call("release", { store: "mate" }, { mutation: false });
    const firstMateResult = await firstMate;
    assert.deepEqual(firstMateResult, { started: 2, completed: 2 });
    const state = await client.call<{ started: number; completed: number }>("state", null);
    assert.deepEqual(state, { started: 3, completed: 2 });

    Atomics.store(new Int32Array(laneReleaseBuffer), 0, 1);
    Atomics.notify(new Int32Array(laneReleaseBuffer), 0);
    assert.deepEqual(await secondMate, { started: 3, completed: 3 });
  } finally {
    Atomics.store(new Int32Array(laneReleaseBuffer), 0, 1);
    Atomics.notify(new Int32Array(laneReleaseBuffer), 0);
    await client.call("release", { store: "character" }).catch(() => undefined);
    await client.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "shutdownはresource laneをdrainするまで完了せず、shutdown中の後続requestは明示的に拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "shutdown-completeをlane処理より先に送るか、shutdown中のrequestをpendingのまま残す"
// observable = "shutdown中のlate call error、lane result、shutdown-complete、worker exit"
// observation_boundary = "public-boundary"
// scope = "storage-worker-shutdown-drain"
// lifecycle = "permanent"
// impact = "外部FS待ちのresource処理を切断せず、shutdown後のrequestを孤児化しない"
// distinction = "client.closeはshutdown後の新規callを受け付けないため、entryの生Worker境界を直接検証する"
// @end-test-value
test("storage worker entry drains a pending resource lane before shutdown", { timeout: 10_000 }, async () => {
  const laneReleaseBuffer = new SharedArrayBuffer(4);
  const generationId = randomUUID();
  const waitRequestId = randomUUID();
  const shutdownRequestId = randomUUID();
  const lateRequestId = randomUUID();
  const worker = new Worker(new URL("../../src-electron/storage-worker-entry.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData: {
      generationId,
      handlerModule: new URL("./storage-worker-lane-handler.ts", import.meta.url).href,
      laneReleaseBuffer,
    },
  });
  const messages: unknown[] = [];
  const messageQueue: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  const onMessage = (message: unknown): void => {
    messages.push(message);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messageQueue.push(message);
  };
  worker.on("message", onMessage);
  const nextMessage = (): Promise<unknown> => {
    const queued = messageQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  const exitPromise = new Promise<number>((resolve) => worker.once("exit", resolve));
  try {
    assert.equal((await nextMessage() as { type: string }).type, "ready");
    worker.postMessage({
      type: "call",
      context: { requestId: waitRequestId, generationId },
      command: "store.call",
      payload: { store: "mate", method: "wait", args: [] },
      mutation: true,
    });
    assert.equal((await nextMessage() as { type: string; requestId: string }).type, "started");

    worker.postMessage({ type: "shutdown", requestId: shutdownRequestId });
    worker.postMessage({
      type: "call",
      context: { requestId: lateRequestId, generationId },
      command: "echo",
      payload: null,
      mutation: false,
    });
    const lateError = await nextMessage() as { type: string; requestId: string; message: string };
    assert.equal(lateError.type, "error");
    assert.equal(lateError.requestId, lateRequestId);
    assert.match(lateError.message, /shutting down/);
    assert.equal(messages.some((message) => (message as { type?: string }).type === "shutdown-complete"), false);

    Atomics.store(new Int32Array(laneReleaseBuffer), 0, 1);
    Atomics.notify(new Int32Array(laneReleaseBuffer), 0);
    const laneResult = await nextMessage() as { type: string; requestId: string };
    assert.equal(laneResult.type, "result");
    assert.equal(laneResult.requestId, waitRequestId);
    const shutdownComplete = await nextMessage() as { type: string; requestId: string };
    assert.equal(shutdownComplete.type, "shutdown-complete");
    assert.equal(shutdownComplete.requestId, shutdownRequestId);
    assert.equal(await exitPromise, 0);
  } finally {
    worker.off("message", onMessage);
    if (worker.threadId !== -1) await worker.terminate();
  }
});

// @test-value v2
// kind = "contract"
// claim = "V6 storage worker は実DBを所有し、typed store commandを通して初期catalogとSessionを返す"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "V6 storageをMainで同期生成するか、Worker初期化後にcatalog/session取得ができずbundleが不完全になる"
// observable = "bundle.initializeのactiveModelCatalogとstores.session.listSessionsの戻り値"
// observation_boundary = "public-boundary"
// scope = "v6-storage-worker-bundle"
// lifecycle = "permanent"
// impact = "V6の同期SQLite所有権をWorkerへ移す際に、既存DBの初期化と限定store APIを維持する"
// distinction = "transport単体testでは確認できない実V6 schemaと全store生成の接続を確認する"
// @end-test-value
test("V6 storage worker bundle initializes against a temporary database", async () => {
  const userDataPath = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "withmate-storage-worker-"));
  let bundle: ReturnType<typeof createV6StorageWorkerBundle> | null = null;
  try {
    await mkdir(join(userDataPath, "characters"), { recursive: true });
    const bootstrap = await createOrVerifyV6FreshDatabase(userDataPath);
    bundle = createV6StorageWorkerBundle({
      dbPath: bootstrap.dbPath,
      bundledModelCatalogPath: join(process.cwd(), "public", "model-catalog.json"),
      userDataPath,
      workerUrl: new URL("../../src-electron/storage-worker-entry.ts", import.meta.url),
      handlerModule: new URL("../../src-electron/storage-worker-bundle.ts", import.meta.url),
      workerOptions: { execArgv: ["--import", "tsx"] },
    });
    const initial = await bundle.initialize() as { activeModelCatalog: { revision: number }; sessions: unknown[] };
    assert.ok(initial.activeModelCatalog.revision > 0);
    assert.deepEqual(initial.sessions, []);
    assert.deepEqual(await bundle.stores.session.listSessions(), []);
    await bundle.stores.prompt.createPromptTemplate({ name: "worker-test", prompt: "persisted" });
    await bundle.client.close();
    bundle = null;

    const reopened = createV6StorageWorkerBundle({
      dbPath: bootstrap.dbPath,
      bundledModelCatalogPath: join(process.cwd(), "public", "model-catalog.json"),
      userDataPath,
      workerUrl: new URL("../../src-electron/storage-worker-entry.ts", import.meta.url),
      handlerModule: new URL("../../src-electron/storage-worker-bundle.ts", import.meta.url),
      workerOptions: { execArgv: ["--import", "tsx"] },
    });
    try {
      assert.equal((await reopened.stores.prompt.listPromptTemplates()).length, 1);
    } finally {
      await reopened.client.close();
    }
  } finally {
    if (bundle) await bundle.client.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "PersistentStoreLifecycleService のV6 initialize/close/reopenは実Worker bundleを所有する"
// oracle = { type = "contract", ref = "docs/plans/20260919-session-operation-boundaries/plan.md#実装単位と完了条件" }
// fault = "V6 lifecycleがMain同期storageを生成するか、close後にWorkerを閉じず再open時にDB接続が競合する"
// observable = "bundle.storageWorkerの存在、Worker経由のSession読み取り、close後の旧store拒否と再initialize"
// observation_boundary = "public-boundary"
// scope = "persistent-store-worker-lifecycle"
// lifecycle = "permanent"
// impact = "DB ownerのgenerationをlifecycleのrecreate/closeへ接続し、旧Workerを残さない"
// distinction = "bundle単体では確認できないPersistentStoreLifecycleServiceとの実接続を確認する"
// @end-test-value
test("V6 persistent store lifecycle uses the storage worker across close and reopen", async () => {
  const userDataPath = await mkdtemp(join(process.env.TEMP ?? process.cwd(), "withmate-storage-lifecycle-"));
  const service = createPersistentStoreLifecycleService();
  let first: Awaited<ReturnType<typeof service.initialize>> | null = null;
  let dbPath: string | null = null;
  try {
    const bootstrap = await createOrVerifyV6FreshDatabase(userDataPath);
    dbPath = bootstrap.dbPath;
    const bundledCatalogPath = join(process.cwd(), "public", "model-catalog.json");
    first = await service.initialize(bootstrap.dbPath, bundledCatalogPath, userDataPath);
    assert.ok(first.storageWorker);
    assert.deepEqual(await first.sessionStorage.listSessions(), []);
    await service.close(first, bootstrap.dbPath);
    await assert.rejects(async () => first!.sessionStorage.listSessions(), StorageWorkerGenerationError);
    first = null;
    const second = await service.initialize(bootstrap.dbPath, bundledCatalogPath, userDataPath);
    try {
      assert.ok(second.storageWorker);
      assert.deepEqual(await second.sessionStorage.listSessions(), []);
    } finally {
      await service.close(second, bootstrap.dbPath);
    }
  } finally {
    if (first && dbPath) await service.close(first, dbPath).catch(() => undefined);
    await rm(userDataPath, { recursive: true, force: true });
  }
});
