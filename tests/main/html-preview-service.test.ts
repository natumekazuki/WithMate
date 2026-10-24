import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { IpcMainInvokeEvent, OnBeforeRequestListenerDetails } from "electron";

class Contents extends EventEmitter {
  readonly id = 10;
  readonly mainFrame = {};
  focusedFrame: unknown = null;
  destroyed = false;
  readonly events: Array<{ id: string; type: string; message?: string }> = [];
  constructor() {
    super();
    this.on("removeListener", (name) => {
      if (this.destroyed && (name === "console-message" || name === "before-input-event")) {
        throw new TypeError("Object has been destroyed");
      }
    });
  }
  isDestroyed() { return this.destroyed; }
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
  close() { this.destroyed = true; this.contents.destroyed = true; this.emit("closed"); }
}

function createHarness() {
  const owner = new Owner();
  const frame = { url: "", isDestroyed: () => false, executeJavaScript: async (_script: string): Promise<unknown> => undefined };
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
        source: `
          export const BrowserWindow = { fromWebContents: (...args) => globalThis.__withmateHtmlPreviewElectron.BrowserWindow.fromWebContents(...args) };
          export const protocol = {};
          export const session = { get defaultSession() { return globalThis.__withmateHtmlPreviewElectron.session.defaultSession; } };
          export const webFrameMain = { fromId: (...args) => globalThis.__withmateHtmlPreviewElectron.webFrameMain.fromId(...args) };
        `,
      } : nextLoad(url, context);
    },
  });
  return {
    owner, frame,
    beforeRequest: (details: OnBeforeRequestListenerDetails, callback: (result: { cancel: boolean }) => void) => beforeRequest(details, callback),
    respond: (request: Request) => respond(request),
    cleanup() {
      hooks.deregister();
      if (previous) Object.defineProperty(globalThis, "__withmateHtmlPreviewElectron", previous);
      else Reflect.deleteProperty(globalThis, "__withmateHtmlPreviewElectron");
    },
  };
}

// @test-value v2
// kind = "security"
// claim = "HTML文書URLはownerのsubframeへ一度だけ配信し、subframe IPC・別window・再navigationを拒否する。disposeはlistenerを解放し、owner終了は例外なく本文を失効させる"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "別windowやmain frameへ本文を配信する、消費済みURLを再利用する、または破棄済みWebContentsのlistener解除hookで終了時に例外を起こす"
// observable = "requestのcancel、responseの本文/CSP/status、readyとfocus通知、dispose後のlistener数、終了時の例外と複数URLの失効"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewServiceの文書配信・frame event・owner lifetime"
// lifecycle = "permanent"
// impact = "別windowへのHTML漏えい、アプリ権限の公開、Preview Window終了時のmain process例外を防ぐ"
// distinction = "rendererや入力policyのtestではElectron request/frame/ownerの関連付けを検出できない。実iframeのsandboxと描画は別途runtimeで確認する"
// @end-test-value
test("HTML previewはowner subframe限定で配信しframe操作と終了時失効を維持する", async () => {
  const harness = createHarness();
  const { owner, frame, beforeRequest, respond } = harness;
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
    assert.deepEqual(owner.contents.eventNames(), ["removeListener"]);
    const endedUrls = ["ended-first", "ended-second"].map((id) => service.mount(event, { id, html: "<p>End</p>" }));
    for (const endedUrl of endedUrls) {
      assert.equal(request({ url: endedUrl }), false);
      assert.equal(await respond(new Request(endedUrl)).text(), "<p>End</p>");
    }
    assert.doesNotThrow(() => owner.close());
    for (const endedUrl of endedUrls) assert.equal(respond(new Request(endedUrl)).status, 403);
    assert.equal(owner.listenerCount("closed"), 0);
  } finally {
    harness.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "ownerが健全でも読込済みHTML frameの実行失敗・破棄・応答不能をerror通知して本文を失効し、破棄前probeの遅延応答は同じidの再読込を壊さない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "OOPIF単独停止を検出しない、応答待ちを無制限に積み重ねる、またはdispose前のprobeが再読込後のpreviewを失効する"
// observable = "ready/error通知、probe実行回数、文書URLのHTTP status、再読込後の配信本文と終了後の通知数"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewServiceの読込後frame応答監視とpreview lifetime"
// lifecycle = "permanent"
// impact = "灰色のまま応答しないHTMLを検出しReloadを案内し、再読込済み文書への誤った停止通知を防ぐ"
// distinction = "型検査とowner eventのtestでは非同期OOPIF停止や破棄後の遅延応答を検出できず、fake timerで実時間待機なしに継続確認できる"
// @end-test-value
test("HTML frame単独停止を通知し遅延probeは再読込と終了を妨げない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  const { owner, frame, beforeRequest, respond } = harness;
  const { HtmlPreviewService } = await import("../../src-electron/files/html-preview-service.js");
  const service = new HtmlPreviewService();
  const event = { sender: owner.contents, senderFrame: owner.contents.mainFrame } as unknown as IpcMainInvokeEvent;
  let probes = 0;
  let resolveProbe!: (value: unknown) => void;
  let rejectProbe!: (error: Error) => void;
  const start = () => {
    const url = service.mount(event, { id: "health", html: "<p>Alive</p>" });
    beforeRequest({ url, webContentsId: owner.contents.id, resourceType: "subFrame", method: "GET" } as OnBeforeRequestListenerDetails, () => {});
    frame.url = url;
    owner.contents.emit("did-frame-finish-load", {}, false, 1, 2);
    assert.deepEqual(owner.contents.events.at(-1), { id: "health", type: "ready" });
    return url;
  };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  frame.executeJavaScript = (script) => {
    assert.equal(script, "void 0");
    probes += 1;
    return new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
  };
  try {
    let url = start();
    t.mock.timers.tick(5_000);
    assert.equal(probes, 1);
    resolveProbe(undefined);
    await flush();
    assert.equal(owner.contents.events.at(-1)?.type, "ready");
    t.mock.timers.tick(5_000);
    assert.equal(probes, 2);
    rejectProbe(new Error("Render frame was disposed"));
    await flush();
    assert.match(owner.contents.events.at(-1)?.message ?? "", /stopped responding/);
    assert.equal(respond(new Request(url)).status, 403);

    url = start();
    t.mock.timers.tick(5_000);
    const count = probes;
    t.mock.timers.tick(14_999);
    assert.equal(probes, count);
    assert.equal(owner.contents.events.at(-1)?.type, "ready");
    t.mock.timers.tick(1);
    assert.equal(owner.contents.events.at(-1)?.type, "error");
    assert.equal(respond(new Request(url)).status, 403);
    resolveProbe(undefined);
    await flush();

    url = start();
    frame.isDestroyed = () => true;
    t.mock.timers.tick(5_000);
    assert.equal(owner.contents.events.at(-1)?.type, "error");
    assert.equal(respond(new Request(url)).status, 403);
    frame.isDestroyed = () => false;

    for (const late of ["resolve", "reject"] as const) {
      const disposedUrl = start();
      t.mock.timers.tick(5_000);
      const settle = late === "resolve" ? () => resolveProbe(undefined) : () => rejectProbe(new Error("Late disposal"));
      service.dispose(event, "health");
      assert.equal(respond(new Request(disposedUrl)).status, 403);
      const reloadedUrl = start();
      const notifications = owner.contents.events.length;
      settle();
      await flush();
      assert.equal(owner.contents.events.length, notifications);
      assert.equal(await respond(new Request(reloadedUrl)).text(), "<p>Alive</p>");
      service.dispose(event, "health");
      const finishedProbes: number = probes;
      t.mock.timers.tick(60_000);
      assert.equal(probes, finishedProbes);
      assert.equal(owner.contents.events.length, notifications);
    }

    start();
    t.mock.timers.tick(5_000);
    owner.close();
    const notifications = owner.contents.events.length;
    rejectProbe(new Error("Owner closed"));
    await flush();
    t.mock.timers.tick(60_000);
    assert.equal(owner.contents.events.length, notifications);
  } finally {
    if (!owner.isDestroyed()) owner.close();
    harness.cleanup();
    t.mock.timers.reset();
  }
});
