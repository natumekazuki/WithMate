import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useConversationQueryPages } from "../../src/chat/conversation/use-conversation-query-pages.js";
import type { ConversationQueryOutcome, ConversationQueryRequest } from "../../src-shared/session/conversation-page.js";

async function withDom(run: (element: HTMLElement) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const keys = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const previousAct = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  keys.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try { await run(dom.window.document.getElementById("root")!); }
  finally {
    dom.window.close();
    keys.forEach((key, index) => { const value = previous[index]; if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
}

function page(request: ConversationQueryRequest): ConversationQueryOutcome<number> {
  const offset = request.offset ?? 0;
  return { status: "complete", stamp: { generationId: "generation", ownerIdentity: "owner", contentRevision: 1, requestId: request.requestId }, incarnationId: "incarnation", messageCount: 10000, totalCount: 10000, offset, items: Array.from({ length: Math.min(64, 10000 - offset) }, (_, index) => offset + index) };
}

// @test-value v2
// kind = "contract"
// claim = "全履歴queryは遠いordinalへ移動しても総件数とstampを維持し、保持結果を現在と隣接の最大192件へ限定する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴FindとMessages Navigatorの有限page" }
// fault = "page移動時に総件数を表示page件数へ置換するか、結果を累積保持するか、継続stampを送らず別snapshotを読む"
// observable = "hookのtotalCount、items件数、itemAtで得るordinal、read要求のstamp/requestId"
// observation_boundary = "component-behavior"
// scope = "conversation-query-pages"
// lifecycle = "permanent"
// impact = "大きな履歴でも全件へのFindとNavigator移動を有限メモリで利用できる"
// distinction = "Storageの有限応答契約だけではrendererの累積保持とglobalordinalの消失を検出できない"
// @end-test-value
test("query pages retain bounded neighbours and global ordinals", async () => withDom(async (element) => {
  const requests: ConversationQueryRequest[] = [];
  let latest: ReturnType<typeof useConversationQueryPages<number>> | undefined;
  function Probe({ ordinal }: { ordinal: number }) {
    latest = useConversationQueryPages({ identity: "owner:query", enabled: true, ordinal, read: async (request) => { requests.push(request); return page(request); } });
    return null;
  }
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe ordinal={0} />));
    assert.equal(latest?.totalCount, 10000);
    for (const ordinal of [64, 128, 5000, 9920, 9999, 0]) {
      await act(async () => root.render(<Probe ordinal={ordinal} />));
      assert.equal(latest?.itemAt(ordinal), ordinal);
      assert.equal(latest?.totalCount, 10000);
      assert.ok(latest && latest.items.length <= 192);
      assert.ok(latest.items.every((item, index) => item === latest!.offset + index));
    }
    const first = page(requests[0]);
    assert.equal(first.status, "complete");
    for (const request of requests.slice(1)) {
      assert.deepEqual(request.stamp, first.stamp);
      assert.equal(request.requestId, requests[0].requestId);
    }
  } finally { await act(async () => root.unmount()); }
}));

// @test-value v2
// kind = "invariant"
// claim = "会話owner変更・非表示は旧queryをcancelし、遅い成功や失敗を新ownerへ反映せず、失効を0件と区別して新requestでRetryする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴queryの取消・owner境界・Retry" }
// fault = "旧応答を現在の件数/errorへ適用する、cancelを送らない、失効を正常emptyにする、Retryで失効requestを再利用する"
// observable = "cancel要求、hookのerror/loading/totalCount、readの新requestIdとstable producerId"
// observation_boundary = "component-behavior"
// scope = "conversation-query-owner"
// lifecycle = "permanent"
// impact = "会話切替や非表示で古い検索を止め、別会話の結果を表示せず再試行できる"
// distinction = "型検査とStorage testはReact effect cleanup、旧Promise応答とRetryの競合を通らない"
// @end-test-value
test("query cancellation fences stale responses and retries invalidation", async () => withDom(async (element) => {
  const pending: Array<{ request: ConversationQueryRequest; resolve: (outcome: ConversationQueryOutcome<number>) => void; reject: (error: Error) => void }> = [];
  const cancelled: Array<{ requestId: string; producerId: string }> = [];
  let latest: ReturnType<typeof useConversationQueryPages<number>> | undefined;
  function Probe({ owner, enabled = true }: { owner: string; enabled?: boolean }) {
    latest = useConversationQueryPages({ identity: owner, enabled, ordinal: 0, read: (request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })), cancel: async (request) => { cancelled.push(request); } });
    return null;
  }
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe owner="one" />));
    assert.equal(latest?.loading, true);
    await act(async () => root.render(<Probe owner="two" />));
    assert.equal(cancelled[0]?.requestId, pending[0].request.requestId);
    await act(async () => pending[0].resolve(page(pending[0].request)));
    assert.equal(latest?.totalCount, 0);
    assert.equal(latest?.loading, true);
    await act(async () => pending[1].resolve({ status: "invalidated" }));
    assert.match(latest?.error ?? "", /Retry/);
    assert.equal(latest?.loading, false);
    await act(async () => latest?.retry());
    assert.notEqual(pending[2].request.requestId, pending[1].request.requestId);
    assert.equal(pending[2].request.producerId, pending[1].request.producerId);
    await act(async () => root.render(<Probe owner="two" enabled={false} />));
    assert.equal(cancelled.at(-1)?.requestId, pending[2].request.requestId);
    await act(async () => pending[2].reject(new Error("obsolete hidden failure")));
    assert.equal(latest?.totalCount, 0);
    assert.equal(latest?.error, "");
  } finally { await act(async () => root.unmount()); }
}));

// @test-value v2
// kind = "invariant"
// claim = "高速なordinal変更でも未完了のpage readは最大3件で、旧page完了後に最新位置を取得できる"
// oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md: producerの最大3page job" }
// fault = "旧pageが未完了のまま新位置のreadを増やしてbackend admissionでqueryを取消す、または最新位置を取得しない"
// observable = "deferred readの同時件数、旧read解放後のitemAtとerror、保持items件数"
// observation_boundary = "component-behavior"
// scope = "conversation query rapid range admission"
// lifecycle = "permanent"
// impact = "長い会話の連続scrollやFind移動が正常query取消と誤認され停止することを防ぐ"
// distinction = "同期応答fixtureの既存page testは未完了readの蓄積とbackend3job上限との整合を観測しない"
// @end-test-value
test("rapid ordinal changes respect the pending page budget", async () => withDom(async (element) => {
  const pending: Array<() => void> = [];
  let active = 0;
  let maximum = 0;
  let latest: ReturnType<typeof useConversationQueryPages<number>> | undefined;
  function Probe({ ordinal }: { ordinal: number }) {
    latest = useConversationQueryPages({ identity: "owner", enabled: true, ordinal, read: (request) => new Promise((resolve) => {
      active++;
      maximum = Math.max(maximum, active);
      pending.push(() => { active--; resolve(page(request)); });
    }) });
    return null;
  }
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe ordinal={0} />));
    await act(async () => pending.shift()!());
    for (const ordinal of [1024, 4096, 8192]) await act(async () => root.render(<Probe ordinal={ordinal} />));
    assert.ok(maximum <= 3);
    for (let cycle = 0; pending.length && cycle < 10; cycle++) await act(async () => pending.splice(0).forEach((resolve) => resolve()));
    assert.equal(pending.length, 0);
    assert.equal(latest?.itemAt(8192), 8192);
    assert.equal(latest?.error, "");
    assert.ok(maximum <= 3);
    assert.ok(latest!.items.length <= 192);
  } finally { await act(async () => root.unmount()); }
}));
