import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Companion Auxiliary start は closed 履歴ロードを無効化した revision で再ロードする", async () => {
  const source = await readFile(new URL("../../src/CompanionReviewApp.tsx", import.meta.url), "utf8");
  const handler = source.match(/async function handleStartAuxiliarySession\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0];

  assert.ok(handler, "handleStartAuxiliarySession が見つかること");
  assert.match(handler, /const parentSessionId = snapshot\.session\.id;/);
  assert.match(handler, /const canApplyLoadResult = \(\) => auxiliaryLoadRevisionRef\.current === loadRevision;/);
  assert.match(handler, /parentSessionId,/);
  assert.match(
    handler,
    /finally \{\s*void loadClosedAuxiliarySessions\(parentSessionId, canApplyLoadResult\);\s*setIsAuxiliaryActionPending\(false\);\s*\}/,
  );
});
