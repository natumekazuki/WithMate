import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Session, WebContents, WebFrameMain } from "electron";
import type { HtmlPreviewPermissionPrompt } from "../../src-electron/files/html-preview-permissions.js";

class Contents extends EventEmitter {
  readonly mainFrame = { url: "https://preview.test/page", detached: false, framesInSubtree: [] as unknown[] };
  focusedFrame = this.mainFrame;
  isDestroyed() { return false; }
  constructor() { super(); this.mainFrame.framesInSubtree.push(this.mainFrame); }
}

class TestSession extends EventEmitter {
  request: Parameters<Session["setPermissionRequestHandler"]>[0] = null;
  check: Parameters<Session["setPermissionCheckHandler"]>[0] = null;
  display: Parameters<Session["setDisplayMediaRequestHandler"]>[0] = null;
  setPermissionRequestHandler(handler: typeof this.request) { this.request = handler; }
  setPermissionCheckHandler(handler: typeof this.check) { this.check = handler; }
  setDisplayMediaRequestHandler(handler: typeof this.display) { this.display = handler; }
}

async function harness() {
  const contents = new Contents();
  const session = new TestSession();
  const prompts: HtmlPreviewPermissionPrompt[] = [];
  const replies: ((choice: number | null) => void)[] = [];
  Object.assign(globalThis, { __previewPermissionContents: contents });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "electron" ? { url: "withmate:test-permissions-electron", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      return url === "withmate:test-permissions-electron" ? {
        format: "module", shortCircuit: true,
        source: `export const webContents = { fromFrame: () => globalThis.__previewPermissionContents };
          export const desktopCapturer = { getSources: async () => [{ id: "screen:1", name: "First screen" }, { id: "window:2", name: "Second window" }] };`,
      } : next(url, context);
    },
  });
  const { installHtmlPreviewPermissions } = await import("../../src-electron/files/html-preview-permissions.js");
  const cleanup = installHtmlPreviewPermissions(session as unknown as Session, {
    isActive: () => true,
    ownsContents: (candidate) => candidate === contents as unknown as WebContents,
    ask: (prompt) => { prompts.push(prompt); return new Promise((resolve) => replies.push(resolve)); },
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
  return { contents, session, prompts, replies, cleanup, request, check, close() {
    cleanup(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__previewPermissionContents");
  } };
}

// @test-value v2
// kind = "security"
// claim = "許可したカメラだけがpermission checkを通り、拒否したマイクとnavigation中・破棄後の保留要求は許可されない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "media許可を全機器へ拡大する、またはnavigation・mount終了後に古い承認を適用する"
// observable = "Electron permission request callbackとpermission checkの真偽、promptの要求元と権限名"
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
    h.contents.emit("did-start-navigation");
    assert.equal(await location, false);
    h.replies.shift()!(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.check("video"), false);
    const late = h.request("media", ["audio"]);
    h.cleanup();
    assert.equal(await late, false);
    h.replies.shift()!(0);
    assert.equal(h.session.request, null);
    assert.equal(h.session.check, null);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "画面共有とUSB選択は利用者が選んだsource/deviceだけを返し、遷移中の選択を取消する。requester frameを取得できないserialはpageとembedded originを表示する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "先頭source/deviceを自動選択する、利用者の選択を別documentへ渡す、またはserial requesterを誤ったframe originと断定する"
// observable = "Electron display callbackのvideo id、USB callbackのdevice idと取消値、serial promptのpage・embedded origin表示"
// observation_boundary = "public-boundary"
// scope = "mount専用Sessionの画面共有・device chooser handler"
// lifecycle = "permanent"
// impact = "意図していない画面の漏えい・機器アクセスを防ぐ"
// distinction = "型検査や一般permission testではsource選択とnavigation後のcallback値を検出できない"
// @end-test-value
test("display and device handlers require explicit selection and cancel stale choices", async () => {
  const h = await harness();
  try {
    const capture = new Promise<Electron.Streams>((resolve) => h.session.display!({
      frame: h.contents.mainFrame as unknown as WebFrameMain, securityOrigin: "https://preview.test",
      userGesture: true, videoRequested: true, audioRequested: false,
    }, resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts.length, 1);
    h.replies.shift()!(1);
    const stream = await capture;
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
    h.contents.emit("did-start-navigation");
    assert.equal(await canceled, "");
    h.replies.shift()!(0);
  } finally { h.close(); }
});
