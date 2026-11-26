import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { executionWindowResultSchemas } from "../../src-shared/session/session-execution-read.js";
import { installFailedTurnRetryFixture } from "./failed-turn-retry-fixture.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの最新と過去の確定失敗はそれぞれの応答からだけ再送し、Dockで前回本文を誤再送・草稿へ転記しない。各操作は指定された元受付を送り、現在の草稿を消費しない。最新実行記録の取得失敗は再送せず再取得できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線; docs/design/session-run-lifecycle.md#failed-turn-retry" }
// fault = "最新だけをDockへ移す、Dockから旧本文を操作できるままにする、別の失敗を再送する、草稿を消す、または最新記録の取得エラーと再取得を隠す"
// observable = "実SessionWindowAppの失敗カードごとのResend、Dockの再取得エラーとRetry（再送なし）、Dockの旧Resend/Edit・告知の不在、受付に渡すMain/Aux・元Turn・元receipt、入力欄の値"
// observation_boundary = "consumer"
// scope = "最新も以前も確定失敗のMain/Aux。読み取り・受付IPCをfixtureに差し替える"
// lifecycle = "permanent"
// impact = "通常の新規入力と再試行の境界を誤り、意図しない開始入力を再送する"
// distinction = "実行中の旧失敗を検証する試験は、最新失敗時だけDockへ操作が移る欠陥を再現しない"
// @end-test-value
test("latest and older failures use only the exact response Resend in Main and Auxiliary", { timeout: 15_000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true, get(this: HTMLElement) { return this.classList.contains("session-message-list") ? 720 : 0; },
  });
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: [] }, Buffer,
  });
  const f = await installFailedTurnRetryFixture(api);
  for (const session of [f.main, f.aux]) {
    session.runState = "error";
    session.messages.push({ role: "assistant", text: "B: Latest failed response", runFailure: "Fixture failure", historyIndex: 5 });
  }
  api.getLiveSessionRun = async () => null;
  const getLatest = api.getLatestSessionTurn;
  let latestUnavailable = true;
  let mainLatestReads = 0;
  api.getLatestSessionTurn = async (id) => {
    if (id === f.main.id) {
      mainLatestReads++;
      if (latestUnavailable) throw new Error("Latest execution read unavailable");
    }
    const turn = await getLatest(id);
    return turn && { ...turn, phase: "failed", assistantMessageSeq: 5, errorMessage: "Fixture failure" };
  };
  const readExecution = api.readSessionExecution;
  api.readSessionExecution = async (owner, operation, request) => {
    if (operation !== "read_turn_input_display") return readExecution(owner, operation, request);
    const ref = request as { target: { sessionId: string; incarnationId: string }; messageSeq?: number; turnId?: string };
    if (ref.messageSeq !== 5 && ref.turnId !== "70") return readExecution(owner, operation, request);
    return executionWindowResultSchemas.read_turn_input_display.parse({
      ok: true, origin: { kind: "gui", operation: "send", targetSessionId: ref.target.sessionId, targetIncarnationId: ref.target.incarnationId },
      receiptId: `${ref.target.sessionId}:B`, receiptState: "failed", turnId: "70", turnState: "failed",
      isFixedStart: true, senderTheme: null, retryInputUnchanged: null,
    }) as never;
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const hooks = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => hooks.deregister());
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  const click = async (button: HTMLButtonElement | null) => { assert.ok(button); await act(async () => button.click()); };
  try {
    await act(async () => root.render(<App />));
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), "Keep Main draft");
      composer().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const readRetry = container.querySelector<HTMLButtonElement>(".session-recovery-actions .load-error button");
    assert.ok(readRetry, "the read error has its own Retry, even after a failed turn");
    assert.equal(readRetry.textContent, "Retry");
    assert.match(container.querySelector(".session-recovery-actions")?.textContent ?? "", /Latest execution read unavailable/);
    const latestReadsBeforeRetry = mainLatestReads;
    latestUnavailable = false;
    await click(readRetry);
    assert.ok(mainLatestReads > latestReadsBeforeRetry);
    assert.doesNotMatch(container.textContent ?? "", /Latest execution read unavailable/);
    assert.equal(f.requests.length, 0, "retrying the read must not resend a turn");
    for (const [label, session, draft] of [["Main", f.main, "Keep Main draft"], ["Auxiliary", f.aux, "Keep Auxiliary draft"]] as const) {
      if (label === "Auxiliary") {
        await click(container.querySelector('button.concurrent-chat-splitter[aria-label="Open Auxiliary"]'));
        await click(container.querySelector('.concurrent-chat-target-dock button[title="Auxiliary"]'));
      }
      const pane = container.querySelector(`#session-${label.toLowerCase()}-chat-pane`)!;
      const retry = `button[aria-label="${label}: Resend Failed Turn"]`;
      assert.equal(pane.querySelectorAll(retry).length, 2);
      assert.equal(container.querySelectorAll(retry).length, 2, "there is no second Resend outside the failure cards");
      assert.equal(container.querySelector('.session-recovery-actions button[aria-label$="Previous Request"]'), null);
      assert.doesNotMatch(container.textContent ?? "", /(?:Resend and )?Edit (?:is|are) available for the previous request/);
      assert.equal(composer().value, draft);
      const failedCard = (text: string) => [...pane.querySelectorAll("article")]
        .find((card) => card.querySelector("[data-message-body]")?.textContent === text);
      const prior = f.requests.length;
      for (const [text, receiptId, turnId] of [["B: Latest failed response", "B", "70"], ["A: Partial response", "A", "42"]] as const) {
        await click(failedCard(text)?.querySelector(retry) ?? null);
        assert.deepEqual(f.requests.at(-1)?.request.target, f.targets[session.id]);
        assert.equal(f.requests.at(-1)?.request.receiptId, `${session.id}:${receiptId}`);
        assert.equal(f.requests.at(-1)?.request.turnId, turnId);
        assert.equal(composer().value, draft);
      }
      assert.equal(f.requests.length, prior + 2);
    }
    assert.deepEqual(f.unexpected, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
