import assert from "node:assert/strict";
import test from "node:test";

import { persistSessionRightPaneVisibility } from "../../src/session-right-pane-preference.js";

test("persistSessionRightPaneVisibility は専用 API へ表示状態を保存する", async () => {
  const saved: boolean[] = [];
  const logs: unknown[] = [];

  await persistSessionRightPaneVisibility({
    async updateSessionRightPaneVisibility(isVisible) {
      saved.push(isVisible);
      return {} as never;
    },
    reportRendererLog(input) {
      logs.push(input);
    },
  }, false);

  assert.deepEqual(saved, [false]);
  assert.deepEqual(logs, []);
});

test("persistSessionRightPaneVisibility は保存失敗を記録し、呼び出し元へは送出しない", async () => {
  const logs: Array<{ kind: string; data?: unknown; error?: { message: string } }> = [];

  await persistSessionRightPaneVisibility({
    async updateSessionRightPaneVisibility() {
      throw new Error("database busy");
    },
    reportRendererLog(input) {
      logs.push(input);
    },
  }, true);

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "session.right-pane-preference-save-failed");
  assert.deepEqual(logs[0]?.data, { isVisible: true });
  assert.equal(logs[0]?.error?.message, "database busy");
});
