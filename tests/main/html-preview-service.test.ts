import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";

class Contents extends EventEmitter {
  readonly mainFrame = {};
  destroyed = false;
  closes = 0;
  async loadURL() {}
  setWindowOpenHandler() {}
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.closes += 1; }
}

class NativeView {
  readonly children: NativeView[] = [];
  setVisible() {}
  addChildView(view: NativeView) { this.children.push(view); }
  removeChildView(view: NativeView) { this.children.splice(this.children.indexOf(view), 1); }
}

class Owner extends EventEmitter {
  readonly id = 1;
  readonly contents = new Contents();
  readonly contentView = new NativeView();
  destroyed = false;
  get webContents() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.contents;
  }
  isDestroyed() { return this.destroyed; }
  close() {
    this.destroyed = true;
    this.contents.close();
    this.contentView.children.length = 0;
    this.emit("closed");
  }
}

// @test-value v2
// kind = "contract"
// claim = "HTML previewのowner終了は破棄済みWindowへ再アクセスせず全childを解放し、先行disposeと重複しても二重closeしない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "closed callbackでowner.webContentsを再取得してthrowし、後続viewの解放を中断する、または先行dispose済みviewを再closeする"
// observable = "owner.closeとdisposeの完了、childのdestroyedとclose回数、ownerとcontentsの残listener数"
// observation_boundary = "component-behavior"
// scope = "HtmlPreviewServiceの複数viewとowner終了のlifecycle"
// lifecycle = "permanent"
// impact = "Preview Windowを閉じるとmain process例外が発生しHTML rendererが残る"
// distinction = "renderer mount mockやpolicy testでは実serviceのclosed callbackを通らない。1つの短いElectron stubで終了順序と解放を継続確認し、実native寿命は非表示runtimeで別途確認する"
// @end-test-value
test("HTML previewはowner終了と先行disposeで全childを一度だけ解放する", async () => {
  let owner: Owner;
  const children: Contents[] = [];
  const isolatedSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {}, webRequest: { onBeforeRequest() {} }, protocol: { handle() {} },
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__withmateHtmlPreviewElectron");
  Object.assign(globalThis, { __withmateHtmlPreviewElectron: {
    BrowserWindow: { fromWebContents: () => owner },
    session: { fromPartition: () => isolatedSession },
    View: NativeView,
    WebContentsView: class extends NativeView {
      readonly webContents = new Contents();
      constructor() { super(); children.push(this.webContents); }
    },
  } });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "electron" ? { url: "withmate:test-html-preview-electron", shortCircuit: true } : nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      return url === "withmate:test-html-preview-electron" ? {
        format: "module", shortCircuit: true,
        source: "export const { BrowserWindow, session, View, WebContentsView } = globalThis.__withmateHtmlPreviewElectron;",
      } : nextLoad(url, context);
    },
  });
  try {
    const { HtmlPreviewService } = await import("../../src-electron/files/html-preview-service.js");
    const service = new HtmlPreviewService();
    for (const disposeFirst of [false, true]) {
      owner = new Owner();
      children.length = 0;
      const event = { sender: owner.contents, senderFrame: owner.contents.mainFrame } as unknown as IpcMainInvokeEvent;
      for (const id of ["first", "second"]) await service.mount(event, { id, html: "<p>Preview</p>" });
      if (disposeFirst) {
        service.dispose(event, "first");
        service.dispose(event, "first");
        assert.equal(children[0].closes, 1);
      }
      assert.doesNotThrow(() => owner.close());
      assert.deepEqual(children.map((child) => ({ destroyed: child.isDestroyed(), closes: child.closes })), [
        { destroyed: true, closes: 1 }, { destroyed: true, closes: 1 },
      ]);
      assert.equal(owner.listenerCount("closed"), 0);
      assert.equal(owner.contents.listenerCount("did-start-navigation"), 0);
      assert.equal(owner.contents.listenerCount("render-process-gone"), 0);
    }
  } finally {
    hooks.deregister();
    if (previous) Object.defineProperty(globalThis, "__withmateHtmlPreviewElectron", previous);
    else Reflect.deleteProperty(globalThis, "__withmateHtmlPreviewElectron");
  }
});
