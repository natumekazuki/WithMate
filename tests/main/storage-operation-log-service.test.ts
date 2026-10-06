import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppLogService } from "../../src-electron/app/app-log-service.js";
import { StorageOperationLogService } from "../../src-electron/app/storage-operation-log-service.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import type { StorageOperationDiagnostic } from "../../src-electron/storage/storage-operation-diagnostics.js";
import type { AppLogInput } from "../../src-shared/window/app-log-types.js";

function completed(overrides: Partial<StorageOperationDiagnostic> = {}): StorageOperationDiagnostic {
  return { operation: "audit.updateProgress", correlationId: "correlation", generationId: "generation", requestId: "request", stage: "completed", outcome: "success", waitMs: 2, holdMs: 3, ...overrides };
}

function appLogger(logsPath: string, options: { maxBytes?: number; maxFiles?: number } = {}): AppLogService {
  return new AppLogService({ logsPath, ...options, runtimeInfo: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test", platform: "test", arch: "test", isPackaged: false } });
}

function readLogs(logsPath: string): AppLogInput[] {
  return readdirSync(logsPath).flatMap((name) => readFileSync(path.join(logsPath, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AppLogInput));
}

// @test-value v2
// kind = "invariant"
// claim = "高頻度の通常storage診断は60秒区間ごとに1行の件数と時間の集計を出力し、空区間は出力しない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#storage-diagnostic-log-policy" }
// fault = "個別イベントや容量超過ごとにappendするか、stage件数と遅延時間を失う"
// observable = "公開write callbackの行数、level、summaryの件数と最大時間"
// observation_boundary = "component-behavior"
// scope = "storage-operation-log-summary"
// lifecycle = "permanent"
// impact = "progress頻度に比例したMain同期I/Oによる応答停滞を継続的に防ぐ"
// distinction = "型検査と既存AppLog testではtimer区間と高頻度入力に対する出力量を判定できず、仮想時計で短時間に確認する"
// @end-test-value
test("通常診断は固定区間の集計に縮約する", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logs: AppLogInput[] = [];
  const service = new StorageOperationLogService((input) => logs.push(input));
  try {
    for (let index = 0; index < 10_000; index += 1) {
      service.record(completed({ stage: "queued", outcome: "pending", waitMs: undefined, holdMs: undefined }));
      service.record(completed({ stage: "started", outcome: "pending", holdMs: undefined }));
      service.record(completed({ holdMs: index === 9_999 ? 120 : 3 }));
    }
    t.mock.timers.tick(59_999);
    assert.equal(logs.length, 0);
    t.mock.timers.tick(1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].kind, "storage.operation.summary");
    assert.equal(logs[0].level, "warn");
    assert.deepEqual(logs[0].data, {
      eventCount: 30_000,
      operations: [{ operation: "audit.updateProgress", queued: 10_000, started: 10_000, succeeded: 10_000, failed: 0, slow: 1, maxWaitMs: 2, maxHoldMs: 120 }],
      overflow: { queued: 0, started: 0, succeeded: 0, failed: 0, slow: 0, maxWaitMs: 0, maxHoldMs: 0 },
      slowestWait: completed({ stage: "started", outcome: "pending", holdMs: undefined }),
      slowestHold: completed({ holdMs: 120 }),
    });
    t.mock.timers.tick(60_000);
    assert.equal(logs.length, 1);
    service.record(completed());
    t.mock.timers.tick(60_000);
    assert.equal(logs.length, 2);
    assert.equal(logs[1].level, "info");
  } finally {
    service.dispose();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "操作種数とmetadataが多くても16種とoverflowの集計、最遅sampleがAppLogのJSONLに欠落なく収まる"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#storage-diagnostic-log-policy" }
// fault = "容量超過を破棄するか、保持metadataが膨張してAppLogのdata上限で集計全体が切り詰められる"
// observable = "実AppLogのJSONLのoperations、overflow、sampleとtruncatedの有無"
// observation_boundary = "public-boundary"
// scope = "bounded-storage-log-summary"
// lifecycle = "permanent"
// impact = "診断memoryの増加と件数・遅延情報の消失を防ぐ"
// distinction = "既存AppLogの単行testは集計の容量境界を通らず、1つの一時JSONLで実sanitize経路を検証できる"
// @end-test-value
test("操作容量超過は有限overflowへ集計してsampleもboundedに保つ", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-storage-log-"));
  const logger = appLogger(logsPath);
  const service = new StorageOperationLogService((input) => logger.write(input));
  try {
    for (let index = 0; index < 1_000; index += 1) {
      const event = completed({ operation: `${index}-${"x".repeat(400)}`, correlationId: "c".repeat(400), generationId: "g".repeat(400), requestId: "r".repeat(400), waitMs: index, holdMs: index });
      service.record(event);
      event.waitMs = 0;
      event.correlationId = "mutated";
    }
    service.dispose();
    const logs = readLogs(logsPath);
    assert.equal(logs.length, 1);
    const data = logs[0].data as { operations: Array<{ operation: string; succeeded: number }>; overflow: { succeeded: number; slow: number; maxWaitMs: number }; slowestWait: StorageOperationDiagnostic; slowestHold: StorageOperationDiagnostic; truncated?: boolean };
    assert.equal(data.truncated, undefined);
    assert.equal(data.operations.length, 16);
    assert.ok(data.operations.every((entry) => entry.operation.length === 160 && entry.succeeded === 1));
    assert.equal(data.overflow.succeeded, 984);
    assert.equal(data.overflow.slow, 900);
    assert.equal(data.overflow.maxWaitMs, 999);
    assert.equal(data.slowestWait.waitMs, 999);
    assert.equal(data.slowestHold.holdMs, 999);
    assert.equal(data.slowestWait.correlationId.length, 160);
    assert.equal(data.slowestWait.generationId?.length, 160);
    assert.equal(data.slowestWait.requestId?.length, 160);
  } finally {
    service.dispose();
    rmSync(logsPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "容量超過中のstorage失敗とfatalは通常集計のtimerを待たず相関情報とともにJSONLへ同期記録される"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#storage-diagnostic-log-policy" }
// fault = "失敗やfatalを通常診断と一緒にbufferへ入れて破棄または遅延する"
// observable = "flush前のJSONLの失敗level、相関情報、fatalのerror message"
// observation_boundary = "public-boundary"
// scope = "storage-failure-and-fatal-logging"
// lifecycle = "permanent"
// impact = "保存失敗と異常終了の調査情報を失うことを防ぐ"
// distinction = "型検査と既存AppLog testはstorage集計の容量超過と即時書込みの組合せを確認しない"
// @end-test-value
test("失敗とfatalは集計の容量とtimerに依存しない", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-storage-log-"));
  const logger = appLogger(logsPath);
  const service = new StorageOperationLogService((input) => logger.write(input));
  try {
    for (let index = 0; index < 100; index += 1) service.record(completed({ operation: `operation-${index}` }));
    const failure = completed({ operation: "audit.saveFailed", outcome: "failure" });
    service.record(failure);
    logger.write({ level: "fatal", kind: "main.uncaught-exception", process: "main", message: "fatal", error: { message: "crash" } });
    const logs = readLogs(logsPath);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].kind, "storage.operation");
    assert.equal(logs[0].level, "error");
    assert.equal(logs[0].correlationId, "correlation");
    assert.equal(logs[0].requestId, "request");
    assert.deepEqual(logs[0].data, failure);
    assert.equal(logs[1].level, "fatal");
    assert.equal(logs[1].error?.message, "crash");
    service.dispose();
    const summary = readLogs(logsPath).find((entry) => entry.kind === "storage.operation.summary");
    assert.equal(summary?.level, "warn");
    assert.equal((summary?.data as { overflow: { failed: number } }).overflow.failed, 1);
  } finally {
    service.dispose();
    rmSync(logsPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "正常終了のdisposeは未完了診断も一度だけflushしてtimerを停止し、終了後の失敗は即時記録する"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#storage-diagnostic-log-policy" }
// fault = "終了時に残存集計を失うか、timerとdisposeの重複出力、終了後の失敗破棄が起こる"
// observable = "disposeと仮想時間経過後のwrite callback回数、queued件数と即時失敗行"
// observation_boundary = "component-behavior"
// scope = "storage-log-shutdown"
// lifecycle = "permanent"
// impact = "終了直前の診断が失われることと終了後callbackの継続を防ぐ"
// distinction = "一般log testは集計timerの停止と最終flushを通らず、仮想時計で終了処理を直接確認する"
// @end-test-value
test("disposeは最終集計を一度flushしてtimerを停止する", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const logs: AppLogInput[] = [];
  const service = new StorageOperationLogService((input) => logs.push(input));
  service.record(completed({ stage: "queued", outcome: "pending", waitMs: undefined, holdMs: undefined }));
  service.dispose();
  service.dispose();
  t.mock.timers.tick(180_000);
  assert.equal(logs.length, 1);
  assert.equal((logs[0].data as { operations: Array<{ queued: number }> }).operations[0].queued, 1);
  service.record(completed({ outcome: "failure" }));
  assert.equal(logs.length, 2);
  assert.equal(logs[1].level, "error");
});

// @test-value v2
// kind = "invariant"
// claim = "診断write失敗はconsole.warnで明示し、実coordinatorの成功値と元の失敗例外を変えない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#failure-handling" }
// fault = "診断write失敗がstorage結果を置換するか、timerの未捕捉例外になるか、黙って失われる"
// observable = "coordinatorの戻り値とreject例外、console.warn回数、write再試行回数"
// observation_boundary = "public-boundary"
// scope = "storage-diagnostic-write-failure"
// lifecycle = "permanent"
// impact = "ログ媒体故障で保存処理の意味が変わることと故障の無通知を防ぐ"
// distinction = "既存coordinator testは新しい集計writer経路を通らず、実coordinatorと失敗sinkを接続して判定する"
// @end-test-value
test("diagnostic write失敗は操作結果を変えずに通知する", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const warnings = t.mock.method(console, "warn", () => undefined);
  let writes = 0;
  const service = new StorageOperationLogService(() => { writes += 1; throw new Error("disk failed"); });
  const coordinator = new ProviderRuntimeOperationCoordinator((event) => service.record(event));
  try {
    assert.equal(await coordinator.runExclusive(() => 42), 42);
    const storageError = new Error("storage failed");
    await assert.rejects(coordinator.runExclusive(() => { throw storageError; }), (error) => error === storageError);
    assert.equal(writes, 1);
    t.mock.timers.tick(60_000);
    assert.equal(writes, 2);
    assert.equal(warnings.mock.callCount(), 2);
    assert.match(String(warnings.mock.calls[0].arguments[0]), /log write failed/);
    t.mock.timers.tick(180_000);
    assert.equal(writes, 2);
  } finally {
    service.dispose();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "summaryと失敗とfatalが同一millisecondでrotationしても最新3世代のJSONLは上書きされず保持される"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#storage" }
// fault = "timestamp衝突で世代を上書きするか、active fileを数えず保持上限を超える"
// observable = "実JSONLのファイル件数と最新summary、失敗、fatalのkindとerror"
// observation_boundary = "public-boundary"
// scope = "storage-log-rotation"
// lifecycle = "permanent"
// impact = "rotationで直近の保存失敗やfatalの情報を意図せず失うことを防ぐ"
// distinction = "既存AppLog testはrotationを通らず、小さい容量で同一時刻の世代切替を短時間に再現する"
// @end-test-value
test("rotationは同一時刻でも直近のsummaryと重要イベントを保持する", (t) => {
  t.mock.method(Date, "now", () => 123456);
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-storage-log-"));
  const logger = appLogger(logsPath, { maxBytes: 1, maxFiles: 3 });
  const service = new StorageOperationLogService((input) => logger.write(input));
  try {
    logger.write({ level: "info", kind: "old", process: "main", message: "old" });
    logger.write({ level: "info", kind: "older", process: "main", message: "older" });
    service.record(completed());
    service.flush();
    service.record(completed({ outcome: "failure" }));
    service.dispose();
    logger.write({ level: "fatal", kind: "main.uncaught-exception", process: "main", message: "fatal", error: { message: "boom" } });
    const logs = readLogs(logsPath);
    assert.equal(readdirSync(logsPath).length, 3);
    assert.deepEqual(logs.map((entry) => entry.kind).sort(), ["main.uncaught-exception", "storage.operation", "storage.operation.summary"].sort());
    assert.equal(logs.find((entry) => entry.level === "fatal")?.error?.message, "boom");
  } finally {
    service.dispose();
    rmSync(logsPath, { recursive: true, force: true });
  }
});
