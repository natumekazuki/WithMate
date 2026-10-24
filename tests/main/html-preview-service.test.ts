import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { IpcMainInvokeEvent, OnBeforeRequestListenerDetails } from "electron";

class Contents extends EventEmitter {
  readonly id = 10;
  readonly mainFrame = {};
  focusedFrame: unknown = null;
  readonly events: Array<{ id: string; type: string; message?: string }> = [];
  send(_channel: string, event: { id: string; type: string; message?: string }) { this.events.push(event); }
}

class Owner extends EventEmitter {
  readonly id = 1;
  readonly contents = new Contents();
  destroyed = false;
  get webContents() {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.contents;
  }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit("closed"); }
}

// @test-value v2
// kind = "security"
// claim = "HTML文書URLはownerのsubframeへ一度だけ配信し、subframe IPC・別window・再navigationを拒否して、終了とdisposeで本文とlistenerを解放する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "別windowやmain frameへ本文を配信する、消費済みURLを再利用する、または終了時の破棄済みowner参照で解放を中断する"
// observable = "requestのcancel、responseの本文/CSP/status、readyとfocus通知、終了/dispose後のURL失効とlistener数"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewServiceの文書配信・frame event・owner lifetime"
// lifecycle = "permanent"
// impact = "別windowへのHTML漏えい、アプリ権限の公開、Preview Window終了時のmain process例外を防ぐ"
// distinction = "rendererや入力policyのtestではElectron request/frame/ownerの関連付けを検出できない。実iframeのsandboxと描画は別途runtimeで確認する"
// @end-test-value
test("HTML previewはowner subframe限定で配信しframe操作と終了時失効を維持する", async () => {
  const owner = new Owner();
  const frame = { url: "", isDestroyed: () => false };
  let beforeRequest!: (details: OnBeforeRequestListenerDetails, callback: (result: { cancel: boolean }) => void) => void;
  let respond!: (request: Request) => Response;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__withmateHtmlPreviewElectron");
  Object.assign(globalThis, { __withmateHtmlPreviewElectron: {
    BrowserWindow: { fromWebContents: (contents: unknown) => contents === owner.contents ? owner : null },
    protocol: {},
    session: { defaultSession: {
      webRequest: { onBeforeRequest(_filter: unknown, listener: typeof beforeRequest) { beforeRequest = listener; } },
      protocol: { handle(_scheme: string, handler: typeof respond) { respond = handler; } },
    } },
    webFrameMain: { fromId: () => frame },
  } });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "electron" ? { url: "withmate:test-html-preview-electron", shortCircuit: true } : nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      return url === "withmate:test-html-preview-electron" ? {
        format: "module", shortCircuit: true,
        source: "export const { BrowserWindow, protocol, session, webFrameMain } = globalThis.__withmateHtmlPreviewElectron;",
      } : nextLoad(url, context);
    },
  });
  try {
    const { HtmlPreviewService } = await import("../../src-electron/files/html-preview-service.js");
    const service = new HtmlPreviewService();
    const event = { sender: owner.contents, senderFrame: owner.contents.mainFrame } as unknown as IpcMainInvokeEvent;
    const url = service.mount(event, { id: "first", html: "<p>Private HTML</p>" });
    const request = (changes: Partial<OnBeforeRequestListenerDetails> = {}) => {
      let canceled: boolean | undefined;
      beforeRequest({ url, webContentsId: owner.contents.id, resourceType: "subFrame", method: "GET", ...changes } as OnBeforeRequestListenerDetails,
        (result) => { canceled = result.cancel; });
      return canceled;
    };
    assert.throws(() => service.mount({ ...event, senderFrame: {} } as IpcMainInvokeEvent, { id: "foreign", html: "" }), /application window/);
    assert.throws(() => service.mount(event, { id: "first", html: "" }), /already mounted/);
    assert.equal(respond(new Request(url)).status, 403);
    assert.equal(request({ webContentsId: 99 }), true);
    assert.equal(request(), false);
    const response = respond(new Request(url));
    assert.equal(await response.text(), "<p>Private HTML</p>");
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /sandbox allow-scripts/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");

    frame.url = url;
    owner.contents.emit("did-start-navigation", { url, frame, isMainFrame: false, isSameDocument: false });
    owner.contents.emit("did-frame-finish-load", {}, false, 1, 2);
    assert.deepEqual(owner.contents.events.at(-1), { id: "first", type: "ready" });
    owner.contents.focusedFrame = frame;
    let prevented = 0;
    owner.contents.emit("before-input-event", { preventDefault() { prevented += 1; } }, { type: "keyDown", key: "F6" });
    owner.contents.emit("before-input-event", { preventDefault() { prevented += 1; } }, { type: "keyDown", key: "f", control: true });
    assert.equal(prevented, 2);
    assert.deepEqual(owner.contents.events.slice(-2), [{ id: "first", type: "return-focus" }, { id: "first", type: "find" }]);
    owner.contents.emit("will-frame-navigate", { frame, url: "file:///private.txt", preventDefault() { prevented += 1; } });
    assert.equal(prevented, 3);
    assert.equal(owner.contents.events.at(-1)?.type, "warning");
    assert.equal(request(), true);
    assert.equal(owner.contents.events.at(-1)?.type, "error");
    assert.equal(respond(new Request(url)).status, 403);

    for (const changes of [{ resourceType: "mainFrame" }, { method: "POST" }] as const) {
      const deniedUrl = service.mount(event, { id: "denied", html: "<p>Private</p>" });
      assert.equal(request({ url: deniedUrl, ...changes }), true);
      assert.equal(respond(new Request(deniedUrl)).status, 403);
    }

    const disposedUrl = service.mount(event, { id: "disposed", html: "<p>Discard</p>" });
    service.dispose(event, "disposed");
    service.dispose(event, "disposed");
    assert.equal(respond(new Request(disposedUrl)).status, 403);
    const endedUrl = service.mount(event, { id: "ended", html: "<p>End</p>" });
    assert.doesNotThrow(() => owner.close());
    assert.equal(respond(new Request(endedUrl)).status, 403);
    assert.equal(owner.listenerCount("closed"), 0);
    assert.deepEqual(owner.contents.eventNames(), []);
  } finally {
    hooks.deregister();
    if (previous) Object.defineProperty(globalThis, "__withmateHtmlPreviewElectron", previous);
    else Reflect.deleteProperty(globalThis, "__withmateHtmlPreviewElectron");
  }
});
