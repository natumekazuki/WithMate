import assert from "node:assert/strict";
import test from "node:test";

import {
  createHomeSessionSummaryRefresher,
  type HomeSessionSummaryRefreshRequest,
} from "../../src/home/home-session-summary-refresh.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "invariant"
// claim = "通知集中時はrefreshを1件実行中と1件pendingに集約し、実行中scopeも最新pendingへ引き継いで最新contextへ収束する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md 再取得時の状態維持" }
// fault = "通知ごとに並列実行する、pendingを列挙する、実行中scopeを失う、または古いcontextの結果を適用する"
// observable = "run回数・最大同時実行数・request mode/scope・適用context・refresh完了Promise"
// observation_boundary = "public-boundary"
// scope = "Home session summary refresher admissionとpending集約"
// lifecycle = "permanent"
// impact = "通知集中で一覧readが増殖するか、最新の一覧・open Sessionの状態が欠落する"
// distinction = "型やpage helperでは確認できない非同期admissionとscope引継ぎをdeferredで決定論的に観測する"
// @end-test-value
test("refreshは1件＋最新pendingへ集約し、scopeと最新contextを引き継ぐ", async () => {
  const gate = deferred();
  const requests: HomeSessionSummaryRefreshRequest[] = [];
  const applied: string[] = [];
  let context = "old";
  let active = 0;
  let maxActive = 0;
  const refresher = createHomeSessionSummaryRefresher(async (request, isCurrent) => {
    const capturedContext = context;
    requests.push(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (requests.length === 1) await gate.promise;
    if (isCurrent()) applied.push(capturedContext);
    active -= 1;
  });
  const completion = refresher.refresh({ mode: "replace", invalidation: { scope: "ids", sessionIds: ["first"] } });
  await Promise.resolve();
  context = "latest";
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(refresher.refresh({ mode: "preserve", invalidation: { scope: "ids", sessionIds: ["second"] } }), completion);
  }
  assert.equal(requests.length, 1);
  gate.resolve();
  await completion;
  assert.equal(maxActive, 1);
  assert.deepEqual(requests, [
    { mode: "replace", invalidation: { scope: "ids", sessionIds: ["first"] } },
    { mode: "replace", invalidation: { scope: "ids", sessionIds: ["first", "second"] } },
  ]);
  assert.deepEqual(applied, ["latest"]);
  refresher.dispose();
});

// @test-value v2
// kind = "invariant"
// claim = "pending IDは100件までを保持し、それを超える通知集合はall scopeへ昇格して欠落なく再取得する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md 再取得時の状態維持" }
// fault = "ID集合を無制限に保持するか、超過IDを捨ててallへ昇格しない"
// observable = "境界100件と101件でrunへ渡されるscope・ID集合"
// observation_boundary = "public-boundary"
// scope = "Home refreshのpending ID境界"
// lifecycle = "permanent"
// impact = "通知集中でrenderer保持量が増えるか、超過対象の更新を見落とす"
// distinction = "schemaは個々の通知しか検査せず、複数通知の和集合の境界を保証しない"
// @end-test-value
test("pending ID集合は100件の境界を超えるとallに昇格する", async () => {
  for (const count of [100, 101]) {
    const gate = deferred();
    const requests: HomeSessionSummaryRefreshRequest[] = [];
    const refresher = createHomeSessionSummaryRefresher(async (request) => {
      requests.push(request);
      if (requests.length === 1) await gate.promise;
    });
    const completion = refresher.refresh({ mode: "preserve", invalidation: { scope: "ids", sessionIds: ["0"] } });
    await Promise.resolve();
    for (let index = 1; index < count; index += 1) {
      void refresher.refresh({ mode: "preserve", invalidation: { scope: "ids", sessionIds: [String(index)] } });
    }
    gate.resolve();
    await completion;
    assert.deepEqual(requests[1]?.invalidation, count === 100
      ? { scope: "ids", sessionIds: Array.from({ length: 100 }, (_, index) => String(index)) }
      : { scope: "all" });
    refresher.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "query失効で現在結果の適用を止め、disposeはpendingと後続refreshを停止して終了済みHomeへ結果を返さない"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md queryの分離" }
// fault = "context変更前の結果を適用するか、unmount後にpendingまたは新規refreshを実行する"
// observable = "isCurrentの変化、run回数と適用件数"
// observation_boundary = "public-boundary"
// scope = "Home refresh context失効とdispose"
// lifecycle = "permanent"
// impact = "検索変更やWindow終了後に古いSession一覧を再表示する"
// distinction = "page queryの取消とは異なるowner lifetimeと未開始pendingの停止を確認する"
// @end-test-value
test("context失効とdisposeは旧結果とpending実行を停止する", async () => {
  const gate = deferred();
  let current!: () => boolean;
  let runs = 0;
  let applied = 0;
  const refresher = createHomeSessionSummaryRefresher(async (_request, isCurrent) => {
    current = isCurrent;
    runs += 1;
    await gate.promise;
    if (isCurrent()) applied += 1;
  });
  const request = { mode: "preserve", invalidation: { scope: "all" } } as const;
  const completion = refresher.refresh(request);
  await Promise.resolve();
  assert.equal(current(), true);
  refresher.invalidate();
  assert.equal(current(), false);
  void refresher.refresh(request);
  refresher.dispose();
  gate.resolve();
  await completion;
  await refresher.refresh(request);
  assert.equal(runs, 1);
  assert.equal(applied, 0);
});
