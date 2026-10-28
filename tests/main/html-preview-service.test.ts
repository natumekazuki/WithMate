import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { IpcMainInvokeEvent, Session, WebContents } from "electron";
import type { HtmlPreviewEvent, HtmlPreviewMountRequest, HtmlPreviewPrompt } from "../../src-shared/window/html-preview.js";

let sequence = 0;
class Contents extends EventEmitter {
  id = ++sequence;
  mainFrame = { url: "https://app.test", detached: false, framesInSubtree: [] as unknown[] };
  destroyed = false;
  events: HtmlPreviewEvent[] = [];
  open!: Parameters<WebContents["setWindowOpenHandler"]>[0];
  constructor(readonly session: TestSession) { super(); this.mainFrame.framesInSubtree.push(this.mainFrame); }
  isDestroyed() { return this.destroyed; }
  send(_channel: string, event: HtmlPreviewEvent) { this.events.push(event); }
  setWindowOpenHandler(handler: typeof this.open) { this.open = handler; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit("destroyed"); } }
}
class Window extends EventEmitter {
  id = ++sequence;
  destroyed = false;
  shown = false;
  webContents: Contents;
  constructor(readonly options: Electron.BrowserWindowConstructorOptions = {}) {
    super(); this.webContents = new Contents(options.webPreferences?.session as unknown as TestSession ?? new TestSession());
  }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.webContents.close(); this.emit("closed"); } }
}
class TestSession extends EventEmitter {
  beforeRequest!: (details: { url: string; webContentsId?: number }, callback: (result: { cancel?: boolean }) => void) => void;
  response!: (request: Request) => Promise<Response>;
  request: Parameters<Session["setPermissionRequestHandler"]>[0] = null;
  check: Parameters<Session["setPermissionCheckHandler"]>[0] = null;
  display: Parameters<Session["setDisplayMediaRequestHandler"]>[0] = null;
  cleared = 0;
  protocol = {
    handle: (_scheme: string, callback: typeof this.response) => { this.response = callback; },
    unhandle: (_scheme: string) => {},
  };
  webRequest = { onBeforeRequest: (handler: typeof this.beforeRequest) => { this.beforeRequest = handler; } };
  setPermissionRequestHandler(handler: typeof this.request) { this.request = handler; }
  setPermissionCheckHandler(handler: typeof this.check) { this.check = handler; }
  setDisplayMediaRequestHandler(handler: typeof this.display) { this.display = handler; }
  async clearStorageData() { this.cleared++; }
  async clearCache() {}
  async closeAllConnections() {}
}

const source: HtmlPreviewMountRequest["source"] = { kind: "link", request: { sessionId: "session", target: "preview.html" } };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function event(owner: Window): IpcMainInvokeEvent {
  return { sender: owner.webContents, senderFrame: owner.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
}
async function harness() {
  const owner = new Window();
  const foreign = new Window();
  const sessions = new Map<string, TestSession>();
  const children: Window[] = [];
  const guests: Contents[] = [];
  const externalTargets: string[] = [];
  Object.assign(globalThis, { __withmateHtmlPreviewElectron: {
    ownerOf: (contents: Contents) => [owner, foreign, ...children].find((window) => window.webContents === contents),
    fromPartition: (partition: string) => { const session = new TestSession(); sessions.set(partition, session); return session; },
    createWindow: (options: Electron.BrowserWindowConstructorOptions) => { const child = new Window(options); children.push(child); return child; },
    fromFrame: (frame: unknown) => [owner.webContents, foreign.webContents, ...children.map((child) => child.webContents), ...guests].find((contents) => contents.mainFrame === frame),
    openExternal: (target: string) => { externalTargets.push(target); },
  } });
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === "electron" ? { url: "withmate:test-html-preview-electron", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      return url === "withmate:test-html-preview-electron" ? { format: "module", shortCircuit: true, source: `
        export class BrowserWindow {
          constructor(options) { return globalThis.__withmateHtmlPreviewElectron.createWindow(options); }
          static fromWebContents(contents) { return globalThis.__withmateHtmlPreviewElectron.ownerOf(contents); }
        }
        export const session = { fromPartition: (...args) => globalThis.__withmateHtmlPreviewElectron.fromPartition(...args) };
        export const protocol = { registerSchemesAsPrivileged() {} };
        export const shell = { openExternal: async (target) => globalThis.__withmateHtmlPreviewElectron.openExternal(target) };
        export const webContents = { fromFrame: (...args) => globalThis.__withmateHtmlPreviewElectron.fromFrame(...args) };
        export const desktopCapturer = { getSources: async () => [] };
      ` } : next(url, context);
    },
  });
  const { HtmlPreviewService, configureHtmlPreviewHost } = await import("../../src-electron/files/html-preview-service.js");
  const service = new HtmlPreviewService();
  configureHtmlPreviewHost(owner.webContents as unknown as WebContents);
  configureHtmlPreviewHost(foreign.webContents as unknown as WebContents);
  const mount = (id: string, authorize: () => Promise<void> = async () => {}, read = async () => new Response("asset")) => {
    const result = service.mount(event(owner), { id, html: "<p>Private HTML</p>", source }, { pathname: "/folder/preview.html", read }, authorize);
    return { ...result, session: sessions.get(result.partition)! };
  };
  const attach = (mounted: ReturnType<typeof mount>) => {
    const guest = new Contents(mounted.session);
    guest.mainFrame.url = mounted.url;
    guests.push(guest);
    owner.webContents.emit("did-attach-webview", {}, guest);
    return guest;
  };
  const prompt = (): HtmlPreviewPrompt => {
    const last = owner.webContents.events.at(-1);
    assert.ok(last?.type === "prompt" && last.prompt);
    return last.prompt;
  };
  return { owner, foreign, service, mount, attach, prompt, children, externalTargets, close() {
    owner.destroy(); foreign.destroy(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__withmateHtmlPreviewElectron");
  } };
}

// @test-value v2
// kind = "security"
// claim = "mount専用partitionはHTMLと資源をowner認可の前後で確認して配信し、期限切れ・遅延取消とforeign guestを拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "遅延read後の失効を無視する、mount間でpartitionを共有する、または別Windowのguestへ配信する"
// observable = "protocol responseの本文/status、request cancel値、partition identity、guest attach時のpreventDefault"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewService mount、protocol handler、host attachment"
// lifecycle = "permanent"
// impact = "別ownerや失効後のHTML・local資源漏えいを防ぐ"
// distinction = "型検査とresolver testではElectron session lifetimeと非同期認可の競合を検出できない"
// @end-test-value
test("HTML preview uses isolated authorized sessions and rejects stale resource delivery", async () => {
  const h = await harness();
  try {
    let authorized = true;
    const first = h.mount("first", async () => { if (!authorized) throw new Error("Expired"); });
    const second = h.mount("second");
    assert.notEqual(first.partition, second.partition);
    assert.ok(!first.partition.startsWith("persist:"));
    assert.equal(await (await first.session.response(new Request(first.url))).text(), "<p>Private HTML</p>");
    assert.equal(await (await first.session.response(new Request(new URL("style.css", first.url)))).text(), "asset");
    const guest = h.attach(first);
    const request = (id: number) => new Promise<boolean | undefined>((resolve) => first.session.beforeRequest({ url: "https://cdn.test/app.js", webContentsId: id }, (result) => resolve(result.cancel)));
    assert.equal(await request(guest.id), false);
    assert.equal(await request(h.foreign.webContents.id), true);
    let prevented = false;
    h.foreign.webContents.emit("will-attach-webview", { preventDefault() { prevented = true; } }, {}, { partition: first.partition, src: first.url });
    assert.equal(prevented, true);
    authorized = false;
    assert.equal((await first.session.response(new Request(first.url))).status, 403);
    let finishRead!: (response: Response) => void;
    let resourceAuthorized = true;
    let bodyCanceled = false;
    const expired = h.mount("expired-after-read", async () => { if (!resourceAuthorized) throw new Error("Expired"); },
      () => new Promise((resolve) => { finishRead = resolve; }));
    const expiredResponse = expired.session.response(new Request(new URL("asset.js", expired.url)));
    await flush();
    resourceAuthorized = false;
    finishRead(new Response(new ReadableStream({ cancel() { bodyCanceled = true; } })));
    assert.equal((await expiredResponse).status, 403);
    assert.equal(bodyCanceled, true);
    const delayed = h.mount("late", async () => {}, () => new Promise((resolve) => { finishRead = resolve; }));
    const response = delayed.session.response(new Request(new URL("style.css", delayed.url)));
    await flush();
    h.service.dispose(event(h.owner), "late");
    finishRead(new Response("private late asset"));
    assert.equal((await response).status, 403);
    assert.equal(delayed.session.cleared, 1);
    h.owner.destroy();
    assert.equal(guest.isDestroyed(), true);
    assert.equal((await second.session.response(new Request(second.url))).status, 403);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "子文書の遷移・終了で外部protocol確認を取消し、失効済みの回答や承認直後の遷移から外部起動しない。後続の有効な確認は操作できる"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "外部起動をmountの生存だけで許可する、または失効した子文書の確認がqueueを塞ぐ"
// observable = "host prompt event、古いrequestへの回答拒否、mock shell.openExternalの対象URL"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewServiceの子文書と外部protocol確認の寿命"
// lifecycle = "permanent"
// impact = "終了・遷移済み文書に対する古い承認の実行を防ぎ、現在の文書の確認を利用可能にする"
// distinction = "型検査とpermission単体testはhost queueと非同期外部起動の競合を観測できない"
// @end-test-value
test("external confirmations expire with the requesting child document", async () => {
  const h = await harness();
  try {
    const mounted = h.mount("external");
    const guest = h.attach(mounted);
    const popup = guest.open({ url: "https://preview.test/child" } as Electron.HandlerDetails);
    if (popup.action !== "allow" || !popup.createWindow) throw new Error("Expected popup confirmation");
    const child = popup.createWindow({}) as unknown as Contents;
    h.service.respond(event(h.owner), "external", h.prompt().requestId, 0);
    await flush();
    const external = (contents: Contents, url: string) => contents.emit("will-frame-navigate", { url, preventDefault() {} });
    external(child, "mailto:stale@example.test");
    const stale = h.prompt();
    external(guest, "mailto:current@example.test");
    child.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    assert.notEqual(h.prompt().requestId, stale.requestId);
    assert.throws(() => h.service.respond(event(h.owner), "external", stale.requestId, 0), /no longer active/);
    h.service.respond(event(h.owner), "external", h.prompt().requestId, 0);
    await flush();
    assert.deepEqual(h.externalTargets, ["mailto:current@example.test"]);
    external(child, "mailto:raced@example.test");
    h.service.respond(event(h.owner), "external", h.prompt().requestId, 0);
    child.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    assert.deepEqual(h.externalTargets, ["mailto:current@example.test"]);
    external(child, "mailto:closed@example.test");
    const closed = h.prompt();
    child.close();
    assert.deepEqual(h.owner.webContents.events.at(-1), { id: "external", type: "prompt", prompt: null });
    assert.throws(() => h.service.respond(event(h.owner), "external", closed.requestId, 0), /no longer active/);
    await flush();
    assert.deepEqual(h.externalTargets, ["mailto:current@example.test"]);
    external(guest, "mailto:fragment@example.test");
    const fragment = h.prompt();
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    assert.equal(h.prompt().requestId, fragment.requestId);
    h.service.respond(event(h.owner), "external", fragment.requestId, 0);
    await flush();
    assert.deepEqual(h.externalTargets, ["mailto:current@example.test", "mailto:fragment@example.test"]);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "許可待ちの子Window終了と要求元文書の遷移で確認を取消し、子文書の権限確認も終了時にqueueから除く"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "閉じたpopupや取消済みpermissionの確認をqueueに残す、または遷移後に古いpopupを表示する"
// observable = "host promptの取消event、子Windowのdestroy値、permission callbackの拒否値"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewServiceとpermission handlerの確認queue統合"
// lifecycle = "permanent"
// impact = "利用者が回答不能な古い確認で塞がれず、要求した文書だけの操作を確認する"
// distinction = "permission単体testはserviceのhost queueから確認が除かれることを検出できない"
// @end-test-value
test("popup and permission confirmations are removed when their documents end", async () => {
  const h = await harness();
  try {
    const mounted = h.mount("prompt-cancel");
    const guest = h.attach(mounted);
    const popup = () => {
      const result = guest.open({ url: "https://preview.test/child" } as Electron.HandlerDetails);
      if (result.action !== "allow" || !result.createWindow) throw new Error("Expected popup confirmation");
      return result.createWindow({}) as unknown as Contents;
    };
    popup();
    const closed = h.prompt();
    h.children[0]!.destroy();
    assert.deepEqual(h.owner.webContents.events.at(-1), { id: "prompt-cancel", type: "prompt", prompt: null });
    assert.throws(() => h.service.respond(event(h.owner), "prompt-cancel", closed.requestId, 0), /no longer active/);
    popup();
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await flush();
    assert.equal(h.children[1]!.isDestroyed(), true);
    const child = popup();
    child.mainFrame.url = "https://preview.test/child";
    h.service.respond(event(h.owner), "prompt-cancel", h.prompt().requestId, 0);
    await flush();
    let permission: boolean | undefined;
    mounted.session.request!(child as unknown as WebContents, "notifications", (allowed) => { permission = allowed; }, {
      requestingUrl: child.mainFrame.url, isMainFrame: true,
    });
    const requested = h.prompt();
    child.close();
    assert.equal(permission, false);
    assert.deepEqual(h.owner.webContents.events.at(-1), { id: "prompt-cancel", type: "prompt", prompt: null });
    assert.throws(() => h.service.respond(event(h.owner), "prompt-cancel", requested.requestId, 0), /no longer active/);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "guestとpopupへ隔離設定を強制し、通常Webとabout documentは外部アプリへ渡さずpopupの通信と表示をownerの明示回答まで保留する。guest停止はerror通知とmount破棄になる"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "preload/Nodeをguestへ残す、about documentを外部アプリに誤分類する、foreign ownerの回答を受理する、取消popupを通信させる、またはguest crashでmountを残す"
// observable = "attach時のwebPreferences、about frame navigationの許可、popup show/destroy、request callbackのcancel、owner eventとdispose後の配信status"
// observation_boundary = "public-boundary"
// scope = "HtmlPreviewService guest attach、popup、prompt response、failure lifecycle"
// lifecycle = "permanent"
// impact = "HTMLからアプリ権限への到達と未承認の子Window操作を防ぎ、停止後にReloadできる"
// distinction = "型検査ではWebContents eventとpopup confirmationの非同期境界を検出できない"
// @end-test-value
test("guest preferences, popup confirmation and crash lifecycle remain isolated", async () => {
  const h = await harness();
  try {
    const mounted = h.mount("interactive");
    const prefs: Electron.WebPreferences = { preload: "untrusted.js", nodeIntegration: true, sandbox: false, webSecurity: false };
    let prevented = false;
    h.owner.webContents.emit("will-attach-webview", { preventDefault() { prevented = true; } }, prefs, { partition: mounted.partition, src: mounted.url });
    assert.equal(prevented, false);
    assert.equal(prefs.preload, undefined);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.session, mounted.session);
    const guest = h.attach(mounted);
    guest.emit("dom-ready");
    assert.deepEqual(h.owner.webContents.events.at(-1), { id: "interactive", type: "ready" });
    guest.emit("will-frame-navigate", { url: "about:srcdoc", preventDefault() { assert.fail("srcdoc is a Web document"); } });
    assert.equal(h.owner.webContents.events.some((entry) => entry.type === "prompt"), false);
    const popup = guest.open({ url: "about:blank#form", frameName: "child" } as Electron.HandlerDetails);
    assert.equal(popup.action, "allow");
    if (popup.action !== "allow" || !popup.createWindow) throw new Error("Expected confirmed popup path");
    const childContents = popup.createWindow({ webPreferences: { preload: "bad.js", nodeIntegration: true } });
    const child = h.children[0]!;
    assert.equal(child.webContents, childContents);
    assert.equal(child.shown, false);
    assert.equal(child.options.webPreferences?.preload, undefined);
    assert.equal(child.options.webPreferences?.nodeIntegration, false);
    assert.equal(child.options.webPreferences?.session, mounted.session);
    let network: boolean | undefined;
    mounted.session.beforeRequest({ url: "https://remote.test/form", webContentsId: child.webContents.id }, (result) => { network = result.cancel; });
    assert.equal(network, undefined);
    const request = h.prompt();
    assert.throws(() => h.service.respond(event(h.foreign), "interactive", request.requestId, 0), /no longer active/);
    assert.throws(() => h.service.respond(event(h.owner), "interactive", "expired-request", 0), /no longer active/);
    assert.throws(() => h.service.respond(event(h.owner), "interactive", request.requestId, 99), /Invalid/);
    h.service.respond(event(h.owner), "interactive", request.requestId, 0);
    await flush();
    assert.equal(network, false);
    assert.equal(child.shown, true);
    const denied = guest.open({ url: "https://remote.test/cancel" } as Electron.HandlerDetails);
    if (denied.action !== "allow" || !denied.createWindow) throw new Error("Expected popup confirmation");
    denied.createWindow({});
    let deniedNetwork: boolean | undefined;
    mounted.session.beforeRequest({ url: "https://remote.test/cancel", webContentsId: h.children[1]!.webContents.id },
      (result) => { deniedNetwork = result.cancel; });
    h.service.respond(event(h.owner), "interactive", h.prompt().requestId, null);
    await flush();
    assert.equal(h.children[1]!.isDestroyed(), true);
    assert.equal(deniedNetwork, true);
    guest.emit("render-process-gone", {}, { reason: "crashed" });
    assert.equal(h.owner.webContents.events.some((entry) => entry.type === "error"), true);
    assert.equal(child.isDestroyed(), true);
    assert.equal((await mounted.session.response(new Request(mounted.url))).status, 403);
  } finally { h.close(); }
});
