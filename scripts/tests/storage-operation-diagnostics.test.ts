import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import {
  createStorageOperationDiagnosticContext,
  getStorageOperationCorrelationId,
  runWithStorageOperationCorrelation,
  startEventLoopDelayMonitoring,
} from "../../src-electron/storage-operation-diagnostics.js";

// @test-value v2
// kind = "invariant"
// claim = "明示したstorage operationの相関IDはAsyncLocalStorageでasync await境界をまたいでも保持される"
// oracle = { type = "contract", ref = "src-electron/storage-operation-diagnostics.ts#runWithStorageOperationCorrelation" }
// fault = "async処理へ相関IDが伝播せず、同一処理内で別IDが生成される"
// observable = "getStorageOperationCorrelationIdとcreateStorageOperationDiagnosticContextのcorrelationId"
// observation_boundary = "public-boundary"
// scope = "storage-operation-diagnostics"
// lifecycle = "permanent"
// @end-test-value
test("storage operation correlation は async 境界をまたいで保持される", async () => {
  const context = await runWithStorageOperationCorrelation("correlation-test", async () => {
    await Promise.resolve();
    assert.equal(getStorageOperationCorrelationId(), "correlation-test");
    return createStorageOperationDiagnosticContext();
  });
  assert.equal(context.correlationId, "correlation-test");
});

// @test-value v2
// kind = "invariant"
// claim = "event loop delay監視helperは実測済みの有限な要約値だけをcallbackへ渡し、停止後にcallbackを発生させない"
// oracle = { type = "contract", ref = "src-electron/storage-operation-diagnostics.ts#startEventLoopDelayMonitoring" }
// fault = "空histogramを診断値として出力するか、stop後もtimer callbackが残る"
// observable = "helper callbackのp50/p99/max/mean値とstop後のcallback回数"
// observation_boundary = "public-boundary"
// scope = "event-loop-delay-monitoring"
// lifecycle = "permanent"
// @end-test-value
test("event loop delay monitor は停止可能な要約callbackを提供する", async () => {
  const reports: Array<{ p50Ms: number; p99Ms: number; maxMs: number; meanMs: number }> = [];
  let attempts = 0;
  let resolveReport!: () => void;
  const reportReady = new Promise<void>((resolve) => {
    resolveReport = resolve;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const reportTimeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("event loop delay report timeout")), 2_000);
  });
  let stop: (() => void) | undefined;
  try {
    stop = startEventLoopDelayMonitoring((report) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("diagnostic sink failure");
      }
      reports.push(report);
      resolveReport();
    }, {
      intervalMs: 10,
      resolutionMs: 1,
    });
    await Promise.race([reportReady, reportTimeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    stop?.();
  }
  const countAfterStop = reports.length;
  await delay(30);
  assert.equal(reports.length, countAfterStop);
  assert.ok(attempts > 0);
  assert.ok(reports.length > 0);
  assert.ok(reports.every((report) => Object.values(report).every((value) => Number.isFinite(value) && value >= 0)));
});
