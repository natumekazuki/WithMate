import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("EXT-LIFECYCLE-04: shutdown後のGUI completion callbackはexecution runtimeをlazy生成しない", async () => {
  const mainSource = await readFile(new URL("../../src-electron/main.ts", import.meta.url), "utf8");

  assert.match(
    mainSource,
    /resumeSessionExecutionQueue:\s*\(sessionId\)\s*=>\s*sessionExecutionService\?\.resumeQueue\(sessionId\)/,
  );
  assert.match(
    mainSource,
    /function requireSessionExecutionService\(\)[\s\S]*?if \(sessionExternalRuntimeShuttingDown\)[\s\S]*?throw new SessionExecutionShuttingDownError\(\)[\s\S]*?new SessionExecutionStorageV6/,
  );
});

test("shutdown cleanup は interaction expiry failure 後も execution drain を実行する", async () => {
  const mainSource = await readFile(new URL("../../src-electron/main.ts", import.meta.url), "utf8");

  assert.match(
    mainSource,
    /const errors: unknown\[\] = \[\];[\s\S]*?expirePendingForShutdown\([\s\S]*?errors\.push\(error\);[\s\S]*?await sessionExecutionService\?\.drainForShutdown\(\);/,
  );
  assert.match(mainSource, /new AggregateError\(errors, "Session shutdown cleanup failed\."\)/);
});

test("schedule recoveryはexecution recovery後に開始しshutdownはadmission close前に停止する", async () => {
  const mainSource = await readFile(new URL("../../src-electron/main.ts", import.meta.url), "utf8");

  assert.match(
    mainSource,
    /async function recoverInterruptedSessions\(\)[\s\S]*?await requireSessionExecutionService\(\)\.reconcileAfterRestart\(\);[\s\S]*?await requireSessionScheduleService\(\)\.start\(\);/,
  );
  assert.match(
    mainSource,
    /shutdownSessionRuntime: async \(\) => \{[\s\S]*?await shutdownSessionScheduleRuntimeBestEffort\(\);[\s\S]*?closeSessionRuntimeAdmission\(/,
  );
  assert.match(
    mainSource,
    /function closeSessionExecutionRuntime\(\): void \{[\s\S]*?sessionScheduleStorage\?\.close\(\);[\s\S]*?sessionScheduleService = null;/,
  );
});
