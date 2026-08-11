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
