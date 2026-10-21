import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useStreamedResponseText } from "../../src/chat/conversation/use-streamed-response-text.js";

// @test-value v2
// kind = "contract"
// claim = "stream表示はStrictModeで受信済み本文からmountしても更新を継続し、連続受信と同長置換を100ms周期で最新値へ集約し、terminalや入力待ちの即時表示、次run・owner切替・非表示後のtimer失効を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "effect再実行後にtimerを再開できない、入力ごとに表示やdeadlineを更新する、強い状態変化を待たせる、または旧owner/runのtimerが新しい表示を上書きする"
// observable = "hook consumerの表示本文と制御clockの各時点、timer進行後のowner/run別本文"
// observation_boundary = "consumer"
// scope = "stream response presentation cadence and lifetime"
// lifecycle = "permanent"
// impact = "通信のdelta頻度で本文の再layout頻度が変わり、応答終了や承認・質問が見えにくくなる。会話切替では別会話の本文が混入する"
// distinction = "Markdown単体の集約testはSourceや応答ownerのlifetimeを扱わず、型検査もdeadline延期と古いtimerの適用を検出できない。制御clockの小さいhook fixtureで検証する"
// @end-test-value
test("stream presentation keeps a bounded cadence and flushes lifecycle changes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let owner = "main:inc"; let key = "response-initial"; let text = "already streaming"; let streaming = true; let enabled = true;
  let presented = "";
  function View() { presented = useStreamedResponseText(owner, key, text, streaming, enabled); return <output>{presented}</output>; }
  const render = () => act(async () => root.render(<React.StrictMode><View /></React.StrictMode>));
  const tick = (milliseconds: number) => act(async () => context.mock.timers.tick(milliseconds));
  try {
    await render();
    await tick(99); assert.equal(presented, "");
    await tick(1); assert.equal(presented, "already streaming", "StrictMode effect replay restarts the initial publication");
    text = "next delta"; await render();
    await tick(99); assert.equal(presented, "already streaming");
    await tick(1); assert.equal(presented, "next delta", "publication continues after the initial mount");
    key = "response-1"; text = ""; await render();
    for (const delta of ["first", "other", "third", "four!", "fifth"]) {
      text = delta; await render();
      assert.equal(presented, ""); await tick(20);
    }
    assert.equal(presented, "fifth", "continuous deltas cannot postpone the original deadline");
    text = "pending terminal"; await render(); await tick(25);
    text = "final terminal"; streaming = false; await render();
    assert.equal(presented, "final terminal", "terminal and strong state changes flush the latest raw text");
    await tick(100); assert.equal(presented, "final terminal");
    streaming = true; text = "after approval"; await render();
    assert.equal(presented, "final terminal", "resuming streaming keeps the already displayed body");
    await tick(100); assert.equal(presented, "after approval");
    text = "old run pending"; await render(); await tick(20);
    key = "response-2"; text = "new run"; await render();
    assert.equal(presented, ""); await tick(80); assert.equal(presented, "");
    await tick(20); assert.equal(presented, "new run");
    text = "late previous owner"; await render(); await tick(20);
    owner = "aux:inc"; key = "response-3"; text = "auxiliary"; await render();
    await tick(80); assert.equal(presented, "");
    await tick(20); assert.equal(presented, "auxiliary");
    text = "hidden delta"; await render(); enabled = false; await render();
    await tick(100); assert.equal(presented, "");
    enabled = true; text = "reopened latest"; await render();
    assert.equal(presented, ""); await tick(100); assert.equal(presented, "reopened latest");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
});
