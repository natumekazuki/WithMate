import assert from "node:assert/strict";
import test from "node:test";

import type { WorkItemEvent } from "../../src/work-item.js";
import { collectRecentWorkItemHistory } from "../../src-electron/work-item-history-projection.js";

const progressEvent: WorkItemEvent = {
  sequence: 1,
  workItemId: "work-root",
  revision: 1,
  type: "progress",
  actorSessionId: "root-a",
  payload: { progressSummary: "Started", blockers: [], nextAction: "Continue" },
  createdAt: "2026-08-30T00:00:00.000Z",
};

// @test-value v1
// kind = "regression"
// claim = "GUI用Root WorkItem履歴はbyte上限へ達した時点でnewest-first iteratorを停止し、最新eventを含むsuffixだけを時系列順で返す"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
// failure_mode = "古い順にbyte上限へ詰めて最新handoffを落とすか、上限到達後も全eventを展開してElectron mainへ過大なJSON負荷を掛ける"
// scope = "Root WorkItem GUI history response projection"
// lifecycle = "permanent"
// distinction = "同じ大きさのeventをnewest-firstで渡し、保持sequenceとiterator消費件数の両方を観測する"
// @end-test-value
test("GUI履歴はbyte上限内の最新suffixだけを遅延取得する", () => {
  const events = [27, 28, 29, 30].map((sequence) => ({
    ...progressEvent,
    sequence,
    revision: sequence,
    payload: { progressSummary: `progress-${sequence}-${"x".repeat(1024)}`, blockers: [], nextAction: "Continue" },
  } satisfies WorkItemEvent));
  const newestFirst = [...events].reverse();
  const twoEventBudget = 2
    + Buffer.byteLength(JSON.stringify(newestFirst[0]), "utf8")
    + 1
    + Buffer.byteLength(JSON.stringify(newestFirst[1]), "utf8");
  let consumed = 0;
  function* iterate(): IterableIterator<WorkItemEvent> {
    for (const event of newestFirst) {
      consumed += 1;
      yield event;
    }
  }

  const projected = collectRecentWorkItemHistory(iterate(), twoEventBudget);
  assert.deepEqual(projected.map((event) => event.sequence), [29, 30]);
  assert.equal(consumed, 3);
});
