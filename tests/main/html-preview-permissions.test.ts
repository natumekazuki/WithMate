import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Session, WebContents, WebFrameMain } from "electron";
import type { HtmlPreviewPermissionPrompt } from "../../src-electron/files/html-preview-permissions.js";
import { HTML_PREVIEW_SCHEME } from "../../src-shared/window/html-preview.js";

class Contents extends EventEmitter {
  readonly mainFrame = { url: "https://preview.test/page", detached: false, framesInSubtree: [] as unknown[] };
  focusedFrame = this.mainFrame;
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  constructor() {
    super();
    this.mainFrame.framesInSubtree.push(this.mainFrame);
    this.on("destroyed", () => { this.destroyed = true; });
  }
}

class TestSession extends EventEmitter {
  request: Parameters<Session["setPermissionRequestHandler"]>[0] = null;
  check: Parameters<Session["setPermissionCheckHandler"]>[0] = null;
  display: Parameters<Session["setDisplayMediaRequestHandler"]>[0] = null;
  setPermissionRequestHandler(handler: typeof this.request) { this.request = handler; }
  setPermissionCheckHandler(handler: typeof this.check) { this.check = handler; }
  setDisplayMediaRequestHandler(handler: typeof this.display) { this.display = handler; }
}

async function harness(sources = Promise.resolve([{ id: "screen:1", name: "First screen" }, { id: "window:2", name: "Second window" }])) {
  const contents = new Contents();
  const session = new TestSession();
  const prompts: HtmlPreviewPermissionPrompt[] = [];
  const signals: AbortSignal[] = [];
  const replies: ((choice: number | null) => void)[] = [];
  const state = { active: true, owned: true };
  Object.assign(globalThis, { __previewPermissionContents: contents, __previewPermissionSources: sources });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron" ? { url: "withmate:test-permissions-electron", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      return url === "withmate:test-permissions-electron" ? {
        format: "module", shortCircuit: true,
        source: `export const webContents = { fromFrame: () => globalThis.__previewPermissionContents };
          export const desktopCapturer = { getSources: () => globalThis.__previewPermissionSources };`,
      } : next(url, context);
    },
  });
  const { installHtmlPreviewPermissions } = await import("../../src-electron/files/html-preview-permissions.js");
  const cleanup = installHtmlPreviewPermissions(session as unknown as Session, {
    isActive: () => state.active,
    ownsContents: (candidate) => state.owned && candidate === contents as unknown as WebContents,
    ask: (prompt, signal) => { prompts.push(prompt); signals.push(signal); return new Promise((resolve) => replies.push(resolve)); },
  });
  cleanup.attachContents(contents as unknown as WebContents);
  const request = (permission: "media" | "geolocation", mediaTypes: ("audio" | "video")[] = []) => new Promise<boolean>((resolve) => {
    session.request!(contents as unknown as WebContents, permission, resolve, {
      requestingUrl: contents.mainFrame.url, isMainFrame: true, mediaTypes,
    });
  });
  const check = (mediaType: "audio" | "video") => session.check!(contents as unknown as WebContents, "media", "https://preview.test", {
    requestingUrl: contents.mainFrame.url, isMainFrame: true, mediaType,
  });
  return { contents, session, state, prompts, signals, replies, cleanup, request, check, close() {
    cleanup(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__previewPermissionContents");
    Reflect.deleteProperty(globalThis, "__previewPermissionSources");
  } };
}

// @test-value v2
// kind = "security"
// claim = "許可したカメラだけがpermission checkを通り、拒否したマイクとnavigation中・mount終了後の保留要求は許可されず、その確認signalがabortされる"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "media許可を全機器へ拡大する、またはnavigation・mount終了後に古い承認を適用する"
// observable = "Electron permission request callbackとpermission checkの真偽、promptの要求元と権限名、確認signalのaborted"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionのpermission handler"
// lifecycle = "permanent"
// impact = "意図していないカメラ・マイク利用や遷移先への許可移転を防ぐ"
// distinction = "型検査は非同期承認とnavigationの競合やmedia種別の承認範囲を検出できず、小さなhandler testで直接確認する"
// @end-test-value
test("permission approval remains frame- and media-specific and expires with the mount", async () => {
  const h = await harness();
  try {
    assert.equal(h.check("video"), false);
    const camera = h.request("media", ["video"]);
    assert.match(h.prompts[0]!.title, /camera/);
    assert.match(h.prompts[0]!.detail, /https:\/\/preview.test/);
    h.replies.shift()!(0);
    assert.equal(await camera, true);
    assert.equal(h.check("video"), true);
    assert.equal(h.check("audio"), false);
    const microphone = h.request("media", ["audio"]);
    h.replies.shift()!(1);
    assert.equal(await microphone, false);
    const location = h.request("geolocation");
    const locationSignal = h.signals.at(-1)!;
    assert.equal(locationSignal.aborted, false);
    h.contents.emit("did-start-navigation");
    assert.equal(await location, false);
    assert.equal(locationSignal.aborted, true);
    h.replies.shift()!(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.check("video"), false);
    const late = h.request("media", ["audio"]);
    const lateSignal = h.signals.at(-1)!;
    h.cleanup();
    assert.equal(await late, false);
    assert.equal(lateSignal.aborted, true);
    h.replies.shift()!(0);
    assert.equal(h.session.request, null);
    assert.equal(h.session.check, null);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "mock Electron境界で画面共有とUSB選択callbackは選んだsource/deviceだけを返し、遷移中の選択と確認signalを取消する。serial確認はpageとembedded originを表示する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "先頭source/deviceを自動選択する、利用者の選択を別documentへ渡す、またはserial requesterを誤ったframe originと断定する"
// observable = "mock Electron display callbackのvideo id、USB callbackのdevice idと取消値、確認signalのaborted、serial promptのpage・embedded origin表示"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionの画面共有・device chooser handler"
// lifecycle = "permanent"
// impact = "意図していない画面の漏えい・機器アクセスを防ぐ"
// distinction = "型検査や一般permission testではsource選択とnavigation後のcallback値を検出できない"
// @end-test-value
test("display and device handlers require explicit selection and cancel stale choices", async () => {
  const h = await harness();
  try {
    const capture = new Promise<Electron.Streams | null>((resolve) => h.session.display!({
      frame: h.contents.mainFrame as unknown as WebFrameMain, securityOrigin: "https://preview.test",
      userGesture: true, videoRequested: true, audioRequested: false,
    }, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts.length, 1);
    h.replies.shift()!(1);
    const stream = await capture;
    assert.ok(stream);
    assert.equal("id" in stream.video! ? stream.video.id : undefined, "window:2");
    let prevented = false;
    const device = new Promise<string>((resolve) => h.session.emit("select-usb-device", { preventDefault() { prevented = true; } }, {
      frame: h.contents.mainFrame, deviceList: [{ deviceId: "a", productName: "First USB" }, { deviceId: "b", productName: "Second USB" }],
    }, resolve));
    assert.equal(prevented, true);
    h.replies.shift()!(1);
    assert.equal(await device, "b");
    h.contents.mainFrame.framesInSubtree.push({ url: "https://embedded.test/frame", detached: false });
    const port = new Promise<string>((resolve) => h.session.emit("select-serial-port", { preventDefault() {} },
      [{ portId: "port-a", portName: "COM1" }], h.contents, resolve));
    assert.match(h.prompts.at(-1)!.detail, /Requesting page \(including embedded frames\): https:\/\/preview.test/);
    assert.match(h.prompts.at(-1)!.detail, /Embedded origins: https:\/\/embedded.test/);
    h.replies.shift()!(0);
    assert.equal(await port, "port-a");
    const canceled = new Promise<string>((resolve) => h.session.emit("select-usb-device", { preventDefault() {} }, {
      frame: h.contents.mainFrame, deviceList: [{ deviceId: "c", productName: "USB" }],
    }, resolve));
    const canceledSignal = h.signals.at(-1)!;
    h.contents.emit("did-start-navigation");
    assert.equal(await canceled, "");
    assert.equal(canceledSignal.aborted, true);
    h.replies.shift()!(0);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "要求元contentsの終了はpermission確認signalをabortし、遅いAllowを許可へ変換しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "終了済みdocumentの確認をhostに残す、または終了後の回答をpermission許可にする"
// observable = "確認signalのaborted、mock Electron permission callbackの結果と呼出回数"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionのpermission handlerと確認取消signal"
// lifecycle = "permanent"
// impact = "終了済みdocumentの確認が後続操作を遮ったり不要な許可を与えることを防ぐ"
// distinction = "型検査はcontents終了と非同期Allowの競合を検出できず、小さなmock handler testで取消通知を直接確認する"
// @end-test-value
test("destroying requesting contents aborts its permission prompt and settles once", async () => {
  const h = await harness();
  try {
    const results: boolean[] = [];
    h.session.request!(h.contents as unknown as WebContents, "geolocation", (allowed) => results.push(allowed), {
      requestingUrl: h.contents.mainFrame.url, isMainFrame: true,
    });
    const signal = h.signals[0]!;
    h.contents.emit("destroyed");
    assert.equal(signal.aborted, true);
    assert.deepEqual(results, [false]);
    h.replies.shift()!(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(results, [false]);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "画面共有sourceの取得中に文書が遷移した場合、callbackは取消となり、source取得後も確認を作らない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "取消済みのsource取得後に古いdocumentの画面共有確認をqueueへ追加する"
// observable = "mock Electron display callbackの空streamと呼出回数、askの呼出件数"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionの非同期画面共有handler"
// lifecycle = "permanent"
// impact = "利用できない古い確認によるhost確認queueの閉塞を防ぐ"
// distinction = "通常の選択取消testはsource取得完了後であり、非同期取得前の取消を観測できない。遅延Promiseのみで安価に確認する"
// @end-test-value
test("canceled display source discovery cannot enqueue a stale prompt", async () => {
  let resolveSources!: (sources: { id: string; name: string }[]) => void;
  const h = await harness(new Promise((resolve) => { resolveSources = resolve; }));
  try {
    const streams: (Electron.Streams | null)[] = [];
    h.session.display!({
      frame: h.contents.mainFrame as unknown as WebFrameMain, securityOrigin: "https://preview.test",
      userGesture: true, videoRequested: true, audioRequested: false,
    }, (stream) => streams.push(stream));
    h.contents.emit("did-start-navigation");
    assert.deepEqual(streams, [{}]);
    resolveSources([{ id: "screen:1", name: "First screen" }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(streams, [{}]);
    assert.equal(h.prompts.length, 0);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "null contentsのUSB/HID chooser checkはmount内の有効な所有frameの非opaque originだけ許可し、遷移後は現在origin、終了後は拒否を返す"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "native chooser入口を常時拒否する、または無関係・opaque・detached・終了済みoriginにも開放する"
// observable = "mock Electron permission check handlerのUSB/HID・Serial・fileSystemの真偽値"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionのnull contents chooser入口。native device grantの保存・再利用はmockの対象外"
// lifecycle = "permanent"
// impact = "USB/HID選択を利用可能に保ちながら、他mount・終了済みpageへchooser入口を開放しない"
// distinction = "型検査とframe付き選択testではnativeのnull contents経路を検出できない。小さなhandler呼出のみでorigin境界を継続確認する"
// @end-test-value
test("null device chooser checks require a live owned mount origin", async () => {
  const h = await harness();
  try {
    const handler = h.session.check!;
    const check = (requestingOrigin: string, permission: "usb" | "hid" | "serial" | "fileSystem" = "usb", securityOrigin?: string) =>
      handler(null, permission, requestingOrigin, { isMainFrame: false, ...(securityOrigin ? { securityOrigin } : {}) });
    for (const permission of ["usb", "hid"] as const) {
      assert.equal(check("https://preview.test", permission), true);
      assert.equal(check("https://foreign.test", permission), false);
      assert.equal(check("null", permission), false);
      assert.equal(check("data:text/html,hello", permission), false);
      assert.equal(check("not a URL", permission), false);
    }
    assert.equal(check("https://preview.test", "serial"), false);
    assert.equal(check("https://preview.test", "fileSystem"), false);
    assert.equal(check("https://foreign.test", "hid", "https://preview.test"), true);
    h.state.owned = false;
    assert.equal(check("https://preview.test"), false);
    h.state.owned = true;
    h.state.active = false;
    assert.equal(check("https://preview.test"), false);
    h.state.active = true;
    h.contents.mainFrame.detached = true;
    assert.equal(check("https://preview.test"), false);
    h.contents.mainFrame.detached = false;
    h.contents.emit("did-start-navigation");
    h.contents.mainFrame.url = "https://preview.test/next";
    assert.equal(check("https://preview.test"), true);
    h.contents.mainFrame.url = "https://next.test/next";
    assert.equal(check("https://preview.test"), false);
    assert.equal(check("https://next.test"), true);
    h.contents.mainFrame.framesInSubtree.push({ url: "https://embedded.test/frame", detached: false });
    assert.equal(check("https://embedded.test", "hid"), true);
    h.contents.mainFrame.url = `${HTML_PREVIEW_SCHEME}://mount-token/page.html`;
    assert.equal(check(`${HTML_PREVIEW_SCHEME}://mount-token`), true);
    assert.equal(check(`${HTML_PREVIEW_SCHEME}://other-token`), false);
    h.contents.mainFrame.url = "unregistered://mount-token/page";
    assert.equal(check("unregistered://mount-token"), false);
    h.contents.emit("destroyed");
    assert.equal(check("https://embedded.test"), false);
    h.cleanup();
    assert.equal(check("https://embedded.test"), false);
    assert.equal(h.session.check, null);
  } finally { h.close(); }
  const fresh = await harness();
  try {
    assert.equal(fresh.session.check!(null, "usb", `${HTML_PREVIEW_SCHEME}://mount-token`, { isMainFrame: false }), false);
    const freshHandler = fresh.session.check!;
    assert.equal(freshHandler(null, "hid", "https://preview.test", { isMainFrame: false }), true);
    fresh.cleanup();
    assert.equal(freshHandler(null, "hid", "https://preview.test", { isMainFrame: false }), false);
  } finally { fresh.close(); }
});
