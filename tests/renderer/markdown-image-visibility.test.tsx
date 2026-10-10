import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { MarkdownImage } from "../../src/ui/markdown/markdown-images.js";
import type { MarkdownImageResolver } from "../../src/ui/markdown/image-resource-loader.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";

async function withImageDom(run: (fixture: {
  container: HTMLElement;
  dom: JSDOM;
  root: ReturnType<typeof createRoot>;
  intersection: ReturnType<typeof installIntersectionObserver>;
  timers: Map<number, TimerHandler>;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const intersection = installIntersectionObserver(false);
  const timers = new Map<number, TimerHandler>();
  let timerId = 0;
  dom.window.setTimeout = (handler) => { timers.set(++timerId, handler); return timerId; };
  dom.window.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); };
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try { await run({ container, dom, root, intersection, timers }); }
  finally {
    await act(async () => root.unmount());
    intersection.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

// @test-value v2
// kind = "contract"
// claim = "local画像はviewport到達時だけresolverと待機timerを開始し、表示後は同じresourceを保持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "画面外で画像取得やtimerを開始する、viewport到達後も取得しない、または親更新で画像を再取得する"
// observable = "resolver呼出しとsignal、保留timer、画像alt/title/src、preview buttonのdisabled状態"
// observation_boundary = "component-behavior"
// scope = "MarkdownImage local viewport demand and ready resource"
// lifecycle = "permanent"
// impact = "未閲覧画像の全量取得負荷を抑え、必要な画像とalt・lightbox操作を表示する"
// distinction = "loader testや型検査ではviewport通知とcomponentの取得開始・表示状態の連動を観測できず、少数の通知で継続契約を確認する"
// @end-test-value
test("local画像はviewport到達で取得しready画像とaltを保持する", async () => {
  await withImageDom(async ({ container, dom, root, intersection, timers }) => {
    const calls: { source: string; signal?: AbortSignal }[] = [];
    const resolver: MarkdownImageResolver = async (source, signal) => {
      calls.push({ source, signal });
      return "data:image/png;base64,AAAA";
    };
    const render = (alt = "sample") => root.render(<MarkdownImage source="image.png" alt={alt} title="title" resolveImageSource={resolver} />);
    await act(async () => render());
    assert.equal(calls.length, 0);
    assert.equal(timers.size, 0);
    await act(async () => intersection.observers[0].intersect(false));
    assert.equal(calls.length, 0);
    await act(async () => intersection.observers[0].intersect(true));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, "image.png");
    assert.equal(calls[0].signal?.aborted, false);
    assert.equal(timers.size, 1);
    const image = container.querySelector("img")!;
    assert.equal(image.alt, "sample");
    assert.equal(image.title, "title");
    assert.equal(image.getAttribute("src"), "data:image/png;base64,AAAA");
    assert.equal(container.querySelector("button")?.disabled, true);
    await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    assert.equal(timers.size, 0);
    assert.equal(container.querySelector("button")?.disabled, false);
    await act(async () => { intersection.observers[0].intersect(false); render("updated"); });
    assert.equal(calls.length, 1);
    assert.equal(container.querySelector("img"), image);
    assert.equal(image.alt, "updated");
  });
});

// @test-value v2
// kind = "invariant"
// claim = "source/resolver世代変更はviewport需要を再確認し旧取得をabortしてstale blobを解放し、新世代を再表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "旧需要で画面外の新resourceを取得する、旧取得を取消せずstale blobを表示する、またはunmountでowned URLを残す"
// observable = "resolver呼出し数、AbortSignal、画像src、URL.revokeObjectURL、保留timer"
// observation_boundary = "component-behavior"
// scope = "MarkdownImage deferred resource replacement and disposal"
// lifecycle = "permanent"
// impact = "reloadや画面切替で不要な全量取得と旧画像混在を防ぎ、再表示とresource解放を両立する"
// distinction = "従来の常時表示lifecycle testと異なり旧viewport需要を持つまま画面外の新世代に切り替える境界を確認する"
// @end-test-value
test("local画像の世代変更は再び表示需要を待ち旧取得を取消する", async () => {
  await withImageDom(async ({ container, root, intersection, timers }) => {
    const pending: { signal?: AbortSignal; resolve: (url: string) => void }[] = [];
    const resolver: MarkdownImageResolver = (_source, signal) => new Promise((resolve) => pending.push({ signal, resolve }));
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    try {
      await act(async () => root.render(<MarkdownImage source="first.png" resolveImageSource={resolver} />));
      await act(async () => intersection.observers[0].intersect(true));
      assert.equal(pending.length, 1);
      await act(async () => root.render(<MarkdownImage source="second.png" resolveImageSource={resolver} />));
      assert.equal(pending[0].signal?.aborted, true);
      assert.equal(pending.length, 1);
      assert.equal(timers.size, 0);
      await act(async () => pending[0].resolve("blob:stale"));
      assert.deepEqual(revoked, ["blob:stale"]);
      assert.equal(container.querySelector("img"), null);
      await act(async () => root.render(<MarkdownImage source="first.png" resolveImageSource={resolver} />));
      assert.equal(pending.length, 1, "returning to a previous source must await fresh viewport demand");
      const newResolver: MarkdownImageResolver = (source, signal) => resolver(source, signal);
      await act(async () => root.render(<MarkdownImage source="second.png" resolveImageSource={newResolver} />));
      assert.equal(pending.length, 1);
      await act(async () => intersection.observers.at(-1)!.intersect(true));
      await act(async () => pending[1].resolve("blob:current"));
      assert.equal(container.querySelector("img")?.getAttribute("src"), "blob:current");
      await act(async () => root.render(null));
      assert.equal(pending[1].signal?.aborted, true);
      assert.deepEqual(revoked, ["blob:stale", "blob:current"]);
      assert.equal(timers.size, 0);
    } finally { URL.revokeObjectURL = originalRevoke; }
  });
});
