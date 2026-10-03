import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { MermaidViewport } from "../../src/ui/markdown/mermaid-viewport.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function withViewport(run: (fixture: {
  container: HTMLElement;
  render: (sourceKey?: string) => Promise<void>;
  resize: (width: number, height: number) => Promise<void>;
}) => Promise<void>, options: {
  svg?: string;
  onOpenPath?: (target: string) => void;
} = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const callbacks = new Set<() => void>();
  let viewportWidth = 800;
  let viewportHeight = 400;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    ResizeObserver: { configurable: true, value: class {
      constructor(private callback: () => void) {}
      observe() { callbacks.add(this.callback); }
      disconnect() { callbacks.delete(this.callback); }
    } },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => viewportWidth },
    clientHeight: { configurable: true, get: () => viewportHeight },
  });
  Object.defineProperty(dom.window.SVGElement.prototype, "viewBox", {
    get: () => ({ baseVal: { width: 2000, height: 1000 } }),
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const render = async (sourceKey = "first") => {
    await act(async () => root.render(<>
      <MermaidViewport
        key={sourceKey}
        svg={options.svg ?? '<svg viewBox="0 0 2000 1000"><text>First diagram</text></svg>'}
        onOpenPath={options.onOpenPath}
      />
      <MermaidViewport key="second" svg='<svg viewBox="0 0 2000 1000"><text>Second diagram</text></svg>' />
    </>));
  };
  try {
    await render();
    await run({ container, render, resize: async (width, height) => {
      viewportWidth = width;
      viewportHeight = height;
      await act(async () => callbacks.forEach((callback) => callback()));
    } });
  } finally {
    await act(async () => root.unmount());
    for (const name of ["window", "document", "ResizeObserver"]) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

function button(container: Element, name: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  assert.ok(result);
  return result;
}

// @test-value v2
// kind = "contract"
// claim = "Mermaidの倍率操作はFitの実効倍率から拡縮し、100%とFitへ復帰し、別の図の倍率と位置を変更しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/763 完了条件: 倍率・復帰・各図の独立性" }
// fault = "操作が表示倍率だけを書き換える、Fitへの復帰時にスクロールが残る、または他の図を変更する"
// observable = "倍率buttonのtext、canvas寸法、viewportのscrollLeftとscrollTop"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportの操作から描画寸法と図ごとのstateへの反映"
// lifecycle = "permanent"
// distinction = "既存の画像Fit計算testでは確認しないSVGへの倍率適用と図ごとの状態分離を、小さいDOM fixtureで確認する"
// @end-test-value
test("Mermaidの拡縮・100%・Fitは図ごとに独立する", async () => {
  await withViewport(async ({ container }) => {
    const [first, second] = Array.from(container.querySelectorAll<HTMLElement>(".message-mermaid"));
    const firstCanvas = first.querySelector<HTMLElement>(".message-mermaid-canvas")!;
    const firstViewport = first.querySelector<HTMLElement>("[role=region]")!;
    const secondViewport = second.querySelector<HTMLElement>("[role=region]")!;
    assert.equal(button(first, "Reset diagram zoom to 100%").textContent, "40%");
    assert.equal(firstCanvas.style.width, "800px");
    await act(async () => button(first, "Zoom diagram in").click());
    assert.equal(button(first, "Reset diagram zoom to 100%").textContent, "50%");
    assert.equal(firstCanvas.style.width, "1000px");
    assert.equal(firstCanvas.style.height, "500px");
    await act(async () => button(first, "Zoom diagram out").click());
    assert.equal(firstCanvas.style.width, "800px");
    await act(async () => button(first, "Reset diagram zoom to 100%").click());
    assert.equal(firstCanvas.style.width, "2000px");
    assert.equal(firstCanvas.style.height, "1000px");
    firstViewport.scrollLeft = 300;
    firstViewport.scrollTop = 200;
    secondViewport.scrollLeft = 15;
    secondViewport.scrollTop = 20;
    await act(async () => button(first, "Fit diagram to preview").click());
    assert.equal(firstCanvas.style.width, "800px");
    assert.equal(firstViewport.scrollLeft, 0);
    assert.equal(firstViewport.scrollTop, 0);
    assert.equal(button(second, "Reset diagram zoom to 100%").textContent, "40%");
    assert.equal(secondViewport.scrollLeft, 15);
    assert.equal(secondViewport.scrollTop, 20);
    assert.equal(firstViewport.tabIndex, 0);
  });
});

// @test-value v2
// kind = "contract"
// claim = "MermaidのSVGとHTML linkはraw targetを既存open処理へ渡し、auxiliary clickやpanはnavigationしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/768 受入条件: 安全なリンク経路とzoom/pan維持" }
// fault = "SVGのxlink:hrefを見落とす、browser解決後URLを渡す、またはmiddle-clickやpanでdocument遷移する"
// observable = "clickのdefaultPrevented、open callbackのtargetと回数、panによるscroll位置"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportのSVGとforeignObject内linkに対するevent委譲"
// lifecycle = "permanent"
// impact = "図からのリンク操作でElectronの表示面やファイル相対解決を失う"
// distinction = "通常Markdownのanchor testでは通らないSVG DOMの委譲とpanの入力競合を小さいfixtureで確認する"
// @end-test-value
test("Mermaid linkはraw targetを委譲しauxiliary clickとpanで遷移しない", async () => {
  const opened: string[] = [];
  await withViewport(async ({ container }) => {
    const viewport = container.querySelector<HTMLElement>("[role=region]")!;
    const svgText = viewport.querySelector("a text")!;
    const htmlText = viewport.querySelector("a span")!;
    const Mouse = container.ownerDocument.defaultView!.MouseEvent;
    const dispatch = async (target: Element, type: string, init: MouseEventInit = {}) => {
      const event = new Mouse(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => target.dispatchEvent(event));
      return event;
    };
    assert.equal((await dispatch(svgText, "click")).defaultPrevented, true);
    assert.equal((await dispatch(htmlText, "click", { detail: 0 })).defaultPrevented, true);
    assert.deepEqual(opened, ["../target%20file.md#L10", "https://example.com/path"]);
    assert.equal((await dispatch(svgText, "auxclick", { button: 1 })).defaultPrevented, true);
    assert.equal((await dispatch(htmlText, "auxclick", { button: 2 })).defaultPrevented, true);
    assert.equal(opened.length, 2);
    Object.defineProperty(viewport, "scrollWidth", { get: () => 2000 });
    viewport.setPointerCapture = () => {};
    viewport.hasPointerCapture = () => false;
    await dispatch(svgText, "pointerdown", { ctrlKey: true, clientX: 100, clientY: 100 });
    await dispatch(viewport, "pointermove", { ctrlKey: true, clientX: 80, clientY: 90 });
    await dispatch(viewport, "pointerup", { ctrlKey: true });
    assert.equal((await dispatch(svgText, "click", { ctrlKey: true })).defaultPrevented, true);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop, opened.length], [20, 10, 2]);
    await dispatch(svgText, "pointerdown");
    await dispatch(svgText, "click");
    assert.equal(opened.length, 3);
  }, {
    onOpenPath: (target) => opened.push(target),
    svg: '<svg viewBox="0 0 2000 1000"><a xlink:href="../target%20file.md#L10"><text>File</text></a><foreignObject><a href="//example.com/path"><span>Website</span></a></foreignObject></svg>',
  });
});

// @test-value v2
// kind = "contract"
// claim = "Mermaidの除去済み・不許可destinationは画面遷移せずerrorを示し、同一page fragmentもdocument遷移しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/768 受入条件: 無効・許可されないリンクの画面保持と失敗通知" }
// fault = "href除去後anchorや不許可schemeを開く、無言で捨てる、またはfragmentで履歴を変更する"
// observable = "defaultPrevented、role=alertのerror、open callbackの回数、図のDOM保持"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportの無効link feedbackとdocument遷移抑止"
// lifecycle = "permanent"
// impact = "開けないリンクから復帰不能になるか失敗理由を確認できなくなる"
// distinction = "Mermaidのsanitizer自体のtestではなくsanitization後のanchorを操作したときの利用者向け境界を確認する"
// @end-test-value
test("Mermaidの無効linkは図を保持してerrorを示す", async () => {
  for (const invalidLink of [
    '<a><text>Removed</text></a>',
    '<a href="about:blank"><text>Unsupported</text></a>',
  ]) {
    const opened: string[] = [];
    await withViewport(async ({ container }) => {
      const diagram = container.querySelector(".message-mermaid-canvas svg")!;
      const Mouse = container.ownerDocument.defaultView!.MouseEvent;
      assert.equal(container.querySelector("[role=alert]"), null);
      for (const link of diagram.querySelectorAll("a")) {
        const event = new Mouse("click", { bubbles: true, cancelable: true });
        await act(async () => link.dispatchEvent(event));
        assert.equal(event.defaultPrevented, true);
        assert.equal(container.querySelector(".message-mermaid-canvas svg"), diagram);
        if (link.getAttribute("href") === "#node") {
          assert.equal(container.querySelector("[role=alert]"), null);
        } else {
          assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /no supported destination/);
        }
      }
      assert.deepEqual(opened, []);
    }, {
      onOpenPath: (target) => opened.push(target),
      svg: `<svg viewBox="0 0 2000 1000">${invalidLink}<a href="#node"><text>Fragment</text></a></svg>`,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Fitは表示領域のresizeへ追従し、手動倍率はresizeで変わらず、別sourceの図ではFitへ戻る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/763 完了条件: 狭い表示領域と図単位の独立性" }
// fault = "幅変更後にFitが見切れる、手動倍率が勝手に変わる、または別図へ拡大stateが漏れる"
// observable = "resizeとsource切替後の倍率buttonのtextとcanvas寸法"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportのresize通知とsource単位のmount境界"
// lifecycle = "permanent"
// distinction = "型検査や画像用testはSVG寸法とresize通知から実効倍率への接続を確認しない"
// @end-test-value
test("MermaidのFitはresizeへ追従し手動倍率は維持する", async () => {
  await withViewport(async ({ container, resize, render }) => {
    await resize(319, 400);
    assert.equal(button(container, "Reset diagram zoom to 100%").textContent, "15.9%");
    assert.equal(container.querySelector<HTMLElement>(".message-mermaid-canvas")?.style.width, "318px");
    await act(async () => button(container, "Reset diagram zoom to 100%").click());
    await resize(600, 200);
    assert.equal(button(container, "Reset diagram zoom to 100%").textContent, "100%");
    await act(async () => button(container, "Fit diagram to preview").click());
    assert.equal(button(container, "Reset diagram zoom to 100%").textContent, "20%");
    await act(async () => button(container, "Zoom diagram in").click());
    await render("new-source");
    assert.equal(button(container, "Reset diagram zoom to 100%").textContent, "20%");
    assert.equal(container.querySelector<HTMLElement>(".message-mermaid-canvas")?.style.height, "200px");
  });
});

// @test-value v2
// kind = "contract"
// claim = "MermaidのCtrl＋wheelは対象のFit実効倍率から1ポイントずつ上下に拡縮し、通常wheelと別図の倍率を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 共通previewのCtrl＋wheel操作" }
// fault = "wheelが倍率へ接続されない、逆方向へ拡縮する、通常wheelを奪う、または別図へ倍率が漏れる"
// observable = "倍率button、SVG canvas寸法、wheelのdefaultPreventedと親への伝播"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportの実DOM wheel入力と表示倍率"
// lifecycle = "permanent"
// distinction = "button操作testが通らないnative wheelの接続と通常scrollのイベント境界を確認する"
// @end-test-value
test("MermaidのCtrl＋wheelは対象だけを拡縮し通常wheelを保持する", async () => {
  await withViewport(async ({ container }) => {
    const [first, second] = Array.from(container.querySelectorAll<HTMLElement>(".message-mermaid"));
    const viewport = first.querySelector<HTMLElement>("[role=region]")!;
    const canvas = first.querySelector<HTMLElement>(".message-mermaid-canvas")!;
    const Wheel = container.ownerDocument.defaultView!.WheelEvent;
    let parentWheels = 0;
    container.addEventListener("wheel", () => parentWheels++);
    const wheel = async (deltaY: number, ctrlKey: boolean) => {
      const event = new Wheel("wheel", { deltaY, ctrlKey, bubbles: true, cancelable: true });
      await act(async () => viewport.dispatchEvent(event));
      return event;
    };
    assert.equal((await wheel(-100, true)).defaultPrevented, true);
    assert.equal(button(first, "Reset diagram zoom to 100%").textContent, "41%");
    assert.equal(button(second, "Reset diagram zoom to 100%").textContent, "40%");
    assert.equal(canvas.style.width, "820px");
    assert.equal((await wheel(100, true)).defaultPrevented, true);
    assert.equal(canvas.style.width, "800px");
    assert.equal(parentWheels, 0);
    assert.equal((await wheel(100, false)).defaultPrevented, false);
    assert.equal(parentWheels, 1);
    assert.equal(button(first, "Reset diagram zoom to 100%").textContent, "40%");
    assert.equal(button(second, "Reset diagram zoom to 100%").textContent, "40%");
    await act(async () => button(first, "Fit diagram to preview").click());
    assert.equal(button(first, "Fit diagram to preview").getAttribute("aria-pressed"), "true");
  });
});

// @test-value v2
// kind = "contract"
// claim = "MermaidのCtrl＋左dragは対象だけを移動して終了・中断後に停止し、通常の左drag文字選択と右clickを維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 共通previewのCtrl＋左drag移動" }
// fault = "修飾keyやbuttonを区別せず移動する、Ctrl＋左dragで移動しない、または終了後も移動する"
// observable = "scrollLeft／scrollTop、pointer capture、移動中class、pointerとcontextmenuのdefaultPrevented"
// observation_boundary = "component-behavior"
// scope = "MermaidViewportのpointer入力からscroll移動・終了への反映"
// lifecycle = "permanent"
// distinction = "倍率testでは観測できない共通panの修飾key条件、別図の独立性とpointer中断を実componentで検証する"
// @end-test-value
test("MermaidはCtrl＋左dragで移動し文字選択と右clickを保持する", async () => {
  await withViewport(async ({ container }) => {
    const [first, second] = Array.from(container.querySelectorAll<HTMLElement>(".message-mermaid"));
    const viewport = first.querySelector<HTMLElement>("[role=region]")!;
    const other = second.querySelector<HTMLElement>("[role=region]")!;
    const canvas = first.querySelector<HTMLElement>(".message-mermaid-canvas")!;
    Object.defineProperties(viewport, {
      scrollWidth: { get: () => Number.parseFloat(canvas.style.width) },
      scrollHeight: { get: () => Number.parseFloat(canvas.style.height) },
    });
    let captured: number | null = null;
    viewport.setPointerCapture = (id) => { captured = id; };
    viewport.hasPointerCapture = (id) => captured === id;
    viewport.releasePointerCapture = () => { captured = null; };
    const Mouse = container.ownerDocument.defaultView!.MouseEvent;
    const pointer = async (type: string, button = 0, x = 200, y = 160, id = 7, ctrlKey = true) => {
      const event = new Mouse(type, { button, ctrlKey, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: id });
      await act(async () => viewport.dispatchEvent(event));
      return event;
    };
    await act(async () => button(first, "Reset diagram zoom to 100%").click());
    viewport.scrollLeft = 120;
    viewport.scrollTop = 90;
    for (const [mouseButton, ctrlKey] of [[0, false], [2, false], [2, true]] as const) {
      assert.equal((await pointer("pointerdown", mouseButton, 200, 160, 7, ctrlKey)).defaultPrevented, false);
      await pointer("pointermove", mouseButton, 150, 120, 7, ctrlKey);
      assert.deepEqual([viewport.scrollLeft, viewport.scrollTop, captured], [120, 90, null]);
    }
    assert.equal((await pointer("contextmenu", 2)).defaultPrevented, false);
    assert.equal((await pointer("pointerdown")).defaultPrevented, true);
    await pointer("pointermove", 0, 150, 120);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop, captured], [170, 130, 7]);
    assert.deepEqual([other.scrollLeft, other.scrollTop], [0, 0]);
    assert.equal(viewport.classList.contains("is-panning"), true);
    await pointer("pointermove", 0, 100, 80, 8);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [170, 130]);
    await pointer("pointerup");
    await pointer("pointermove", 0, 100, 80);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop, captured], [170, 130, null]);
    assert.equal(viewport.classList.contains("is-panning"), false);
    assert.equal((await pointer("contextmenu", 2)).defaultPrevented, false);

    for (const ending of ["pointercancel", "lostpointercapture"]) {
      await pointer("pointerdown");
      await pointer("pointermove", 0, 150, 120);
      await pointer(ending);
      const stoppedAt = [viewport.scrollLeft, viewport.scrollTop];
      await pointer("pointermove", 0, 100, 80);
      assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], stoppedAt);
      assert.equal(viewport.classList.contains("is-panning"), false);
    }
    await act(async () => button(first, "Fit diagram to preview").click());
    assert.equal((await pointer("pointerdown")).defaultPrevented, false);
    await pointer("pointermove", 0, 150, 120);
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [0, 0]);
    assert.equal((await pointer("contextmenu", 2)).defaultPrevented, false);
  });
});
