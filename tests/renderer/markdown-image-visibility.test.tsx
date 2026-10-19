import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { MarkdownImage } from "../../src/ui/markdown/markdown-images.js";
import type { MarkdownImageResolver } from "../../src/ui/markdown/image-resource-loader.js";
import { MarkdownRenderContext } from "../../src/ui/markdown/markdown-context.js";
import type { SessionFilePreviewImageActionRequest, SessionFilePreviewImageContextMenuResult } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";

async function withImageDom(run: (fixture: {
  container: HTMLElement;
  dom: JSDOM;
  root: ReturnType<typeof createRoot>;
  intersection: ReturnType<typeof installIntersectionObserver>;
  timers: Map<number, { handler: TimerHandler; delay: number | undefined }>;
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
  const timers = new Map<number, { handler: TimerHandler; delay: number | undefined }>();
  let timerId = 0;
  dom.window.setTimeout = (handler, delay) => { timers.set(++timerId, { handler, delay }); return timerId; };
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
// claim = "本文とlightboxの画像menuはmouse・keyboardで元sourceと表示座標を渡し、lightboxへfocusを移して閉じると起点へ戻し、external画像にはlocal path情報を渡さない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "blob URLを元pathとして渡す、lightboxやkeyboardからmenuに到達できない、外部画像をlocal pathと誤認する、拡大中の通知が隠れる、またはdialogへのfocus移動・復帰を失う"
// observable = "native menu APIのrequest、contextmenuのdefaultPrevented、lightbox内の通知、dialog表示時とEscape後のactiveElement"
// observation_boundary = "component-behavior"
// scope = "MarkdownImageの通常表示・拡大表示からnative menuへの操作境界"
// lifecycle = "permanent"
// distinction = "Main service testはrender済みblobと元sourceの対応やkeyboard座標・portal内の通知を観測できない"
// @end-test-value
test("画像menuは通常表示と拡大表示のmouse・keyboardで元sourceを保持する", async () => {
  await withImageDom(async ({ container, dom, root, intersection, timers }) => {
    const requests: SessionFilePreviewImageActionRequest[] = [];
    const fileContext = { sessionId: "aux-1", baseResource: {
      sessionId: "aux-1", absolutePath: "C:\\docs\\message.md",
    } };
    Object.defineProperty(dom.window, "withmate", { value: {
      showSessionFilePreviewImageContextMenu: async (request: SessionFilePreviewImageActionRequest) => {
        requests.push(request);
        return { status: request.image ? "copied-path" : "copied" };
      },
    } });
    const resolver: MarkdownImageResolver = async () => "blob:display-only";
    await act(async () => root.render(
      <MarkdownRenderContext.Provider value={{ markdown: "", imageContext: fileContext }}>
        <MarkdownImage source="../images/sample.png" resolveImageSource={resolver} />
      </MarkdownRenderContext.Provider>,
    ));
    await act(async () => intersection.observers[0].intersect(true));
    const image = container.querySelector("img")!;
    const trigger = container.querySelector("button")!;
    const rect = new dom.window.DOMRect(10, 20, 120, 80);
    image.getBoundingClientRect = trigger.getBoundingClientRect = () => rect;
    await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    const rightClick = new dom.window.MouseEvent("contextmenu", { clientX: 42, clientY: 62, bubbles: true, cancelable: true });
    await act(async () => image.dispatchEvent(rightClick));
    assert.equal(rightClick.defaultPrevented, true);
    assert.deepEqual(requests[0], { sessionId: "aux-1", point: { x: 42, y: 62 }, image: {
      target: "../images/sample.png", baseResource: fileContext.baseResource,
    } });
    assert.equal(container.querySelector('[role="status"]')?.textContent, "Path copied.");
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "F10", shiftKey: true, bubbles: true, cancelable: true,
    })));
    assert.deepEqual(requests[1].point, { x: 70, y: 60 });
    trigger.focus();
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => trigger.click());
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusTimers = [...timers].filter(([, timer]) => timer.delay === 0);
    assert.equal(focusTimers.length, 1);
    const [focusTimerId, { handler: focusHandler }] = focusTimers[0];
    assert.ok(typeof focusHandler === "function");
    await act(async () => { timers.delete(focusTimerId); focusHandler(); });
    assert.equal(dom.window.document.activeElement, dialog);
    const lightboxImage = dialog.querySelector("img")!;
    lightboxImage.getBoundingClientRect = () => new dom.window.DOMRect(-20, 0, 500, 400);
    dialog.querySelector<HTMLElement>(".image-viewport")!.getBoundingClientRect = () => new dom.window.DOMRect(30, 40, 200, 100);
    await act(async () => lightboxImage.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      clientX: 80, clientY: 90, bubbles: true, cancelable: true,
    })));
    assert.deepEqual(requests[2], { ...requests[0], point: { x: 80, y: 90 } });
    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "ContextMenu", bubbles: true, cancelable: true,
    })));
    assert.deepEqual(requests[3], { ...requests[0], point: { x: 130, y: 90 } });
    assert.equal(dialog.querySelector('[role="status"]')?.textContent, "Path copied.");
    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => root.render(
      <MarkdownRenderContext.Provider value={{ markdown: "", imageContext: fileContext }}>
        <MarkdownImage key="external" source="https://example.test/image.png" />
      </MarkdownRenderContext.Provider>,
    ));
    const externalImage = container.querySelector("img")!;
    await act(async () => externalImage.dispatchEvent(new dom.window.Event("load")));
    await act(async () => externalImage.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      clientX: 40, clientY: 50, bubbles: true, cancelable: true,
    })));
    assert.deepEqual(requests[4], { sessionId: "aux-1", point: { x: 40, y: 50 } });
    assert.equal(container.querySelector('[role="status"]')?.textContent, "Image copied.");
  });
});

// @test-value v2
// kind = "contract"
// claim = "画像menuは失敗をalertへ返し、dismissと同一componentの旧resolver世代への遅延成功を通知しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "IPC失敗やdismissをcopy成功として表示する、または同一sourceのresolver変更後に旧menuの遅延結果を表示する"
// observable = "status/alertの有無と通知text"
// observation_boundary = "component-behavior"
// scope = "MarkdownImageのmenu結果とresource寿命"
// lifecycle = "permanent"
// distinction = "native menu service testやunmountで分離したcomponentでは、同一componentのresolver世代変更後の通知寿命を観測できない"
// @end-test-value
test("画像menuは失敗を通知しdismissと旧resourceの遅延成功は通知しない", async () => {
  await withImageDom(async ({ container, dom, root, intersection }) => {
    let response: () => Promise<SessionFilePreviewImageContextMenuResult> = async () => ({ status: "dismissed" });
    Object.defineProperty(dom.window, "withmate", { value: {
      showSessionFilePreviewImageContextMenu: () => response(),
    } });
    const render = (resolver: MarkdownImageResolver) => root.render(
      <MarkdownRenderContext.Provider value={{ markdown: "", imageContext: { sessionId: "session-1" } }}>
        <MarkdownImage source="image.png" resolveImageSource={resolver} />
      </MarkdownRenderContext.Provider>,
    );
    await act(async () => render(async () => "data:image/png;base64,AAAA"));
    await act(async () => intersection.observers[0].intersect(true));
    const shell = container.querySelector(".message-image-shell")!;
    const image = container.querySelector("img")!;
    await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    const openMenu = () => image.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      clientX: 20, clientY: 30, bubbles: true, cancelable: true,
    }));
    await act(async () => openMenu());
    assert.equal(container.querySelector('[role="status"], [role="alert"]'), null);
    response = async () => ({ status: "failed", message: "Clipboard write failed." });
    await act(async () => openMenu());
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Clipboard write failed.");
    response = async () => { throw new Error("IPC closed"); };
    await act(async () => openMenu());
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Image context menu could not be opened.");
    let finish!: (result: SessionFilePreviewImageContextMenuResult) => void;
    response = () => new Promise((resolve) => { finish = resolve; });
    await act(async () => openMenu());
    await act(async () => render(async () => "data:image/png;base64,BBBB"));
    assert.equal(container.querySelector(".message-image-shell"), shell);
    await act(async () => intersection.observers.at(-1)!.intersect(true));
    const currentImage = container.querySelector("img")!;
    assert.equal(currentImage.getAttribute("src"), "data:image/png;base64,BBBB");
    await act(async () => currentImage.dispatchEvent(new dom.window.Event("load")));
    await act(async () => finish({ status: "copied" }));
    assert.equal(container.querySelector('[role="status"], [role="alert"]'), null);
  });
});

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
