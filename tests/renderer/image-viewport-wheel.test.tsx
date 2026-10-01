import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ImageViewport, ImageZoomControls, useImageViewport } from "../../src/ui/image-viewport.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "画像のCtrl＋wheelはFitの実効倍率から1ポイントずつ連続入力を累積し、10〜800%の限界と10%未満のFitを守る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 共通previewのCtrl＋wheel操作、docs/manual-test-checklist.md: MT-023D7C" }
// fault = "連続wheelが古い倍率を使って取りこぼされる、限界を超える、低倍率Fitで縮小すると拡大へ反転する、または通常wheelもcancelする"
// observable = "倍率buttonのtextとFit状態、画像のstyle.zoom、wheelのdefaultPrevented"
// observation_boundary = "component-behavior"
// scope = "共有ImageViewportの画像load・wheel入力から表示倍率への反映"
// lifecycle = "permanent"
// distinction = "既存のFit計算とbutton testが確認しないnative wheelの接続・連続入力・上下限を小さいDOM fixtureで確認する"
// @end-test-value
test("画像のCtrl＋wheelはFitから拡縮し連続入力と上下限を守る", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  function Harness() {
    const controller = useImageViewport("image");
    return <>
      <ImageZoomControls controller={controller} />
      <ImageViewport controller={controller} src="data:image/png;base64,AAAA" alt="Zoom target" />
    </>;
  }
  try {
    await act(async () => root.render(<Harness />));
    const viewport = container.querySelector<HTMLElement>(".image-viewport")!;
    const image = container.querySelector<HTMLImageElement>("img")!;
    const reset = container.querySelector<HTMLButtonElement>('button[aria-label="Reset image zoom to 100%"]')!;
    const fit = container.querySelector<HTMLButtonElement>('button[aria-label="Fit image to viewport"]')!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 450 },
    });
    const loadImage = async (width: number, height: number) => {
      Object.defineProperties(image, {
        naturalWidth: { configurable: true, value: width },
        naturalHeight: { configurable: true, value: height },
      });
      await act(async () => image.dispatchEvent(new dom.window.Event("load")));
    };
    const dispatchWheel = (deltaY: number, ctrlKey = true) => {
      const event = new dom.window.WheelEvent("wheel", { deltaY, ctrlKey, bubbles: true, cancelable: true });
      image.dispatchEvent(event);
      return event;
    };
    await loadImage(1600, 900);
    assert.equal(reset.textContent, "50%");
    await act(async () => {
      assert.equal(dispatchWheel(-100).defaultPrevented, true);
      dispatchWheel(-100);
    });
    assert.equal(reset.textContent, "52%");
    assert.equal(image.style.zoom, "0.52");
    await act(async () => { dispatchWheel(100); });
    assert.equal(reset.textContent, "51%");
    assert.equal(image.style.zoom, "0.51");
    await act(async () => { for (let i = 0; i < 800; i++) dispatchWheel(-100); });
    assert.equal(reset.textContent, "800%");
    assert.equal(image.style.zoom, "8");
    await act(async () => { for (let i = 0; i < 800; i++) dispatchWheel(100); });
    assert.equal(reset.textContent, "10%");
    assert.equal(image.style.zoom, "0.1");
    await act(async () => {
      assert.equal(dispatchWheel(-100, false).defaultPrevented, false);
      assert.equal(dispatchWheel(0).defaultPrevented, false);
    });
    assert.equal(reset.textContent, "10%");
    await loadImage(16000, 9000);
    await act(async () => fit.click());
    assert.equal(reset.textContent, "5%");
    await act(async () => { assert.equal(dispatchWheel(100).defaultPrevented, true); });
    assert.equal(reset.textContent, "5%");
    assert.equal(fit.getAttribute("aria-pressed"), "true");
    await act(async () => { dispatchWheel(-100); });
    assert.equal(reset.textContent, "10%");
    assert.equal(image.style.zoom, "0.1");
  } finally {
    await act(async () => root.unmount());
    for (const name of ["window", "document"]) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
