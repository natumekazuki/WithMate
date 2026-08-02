import assert from "node:assert/strict";
import test from "node:test";

import { persistSessionSidePane } from "../../src/session-side-pane-preference.js";

test("persistSessionSidePane は専用 API へ選択状態を保存する", async () => {
  const saved: string[] = [];
  const logs: unknown[] = [];

  await persistSessionSidePane({
    async updateSessionSidePane(sidePane) {
      saved.push(sidePane);
      return {} as never;
    },
    reportRendererLog(input) {
      logs.push(input);
    },
  }, "files");

  assert.deepEqual(saved, ["files"]);
  assert.deepEqual(logs, []);
});

test("persistSessionSidePane は保存失敗を記録し、呼び出し元へは送出しない", async () => {
  const logs: Array<{ kind: string; data?: unknown; error?: { message: string } }> = [];

  await persistSessionSidePane({
    async updateSessionSidePane() {
      throw new Error("database busy");
    },
    reportRendererLog(input) {
      logs.push(input);
    },
  }, "context");

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "session.side-pane-preference-save-failed");
  assert.deepEqual(logs[0]?.data, { sidePane: "context" });
  assert.equal(logs[0]?.error?.message, "database busy");
});
