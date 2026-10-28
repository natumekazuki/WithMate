import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { MainIpcSessionQueryDeps } from "../../src-electron/ipc/contracts.js";
import { registerHtmlPreviewSession } from "../../src-electron/files/html-preview-isolation.js";
import { HTML_PREVIEW_DISPOSE, HTML_PREVIEW_MOUNT, type HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";
import type { HtmlPreviewResources } from "../../src-electron/files/html-preview-resources.js";

const source: HtmlPreviewMountRequest["source"] = { kind: "link", request: { sessionId: "aux", target: "preview.html" } };
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function harness() {
  const owner = { isDestroyed: () => false };
  const foreign = { isDestroyed: () => false };
  const mainFrame = {};
  const event = { sender: { id: 1, mainFrame, session: {}, isDestroyed: () => false }, senderFrame: mainFrame };
  const state = {
    window: owner, ownerSession: "main" as string | null, resolves: 0, mounts: 0,
    resolveResources: async (): Promise<HtmlPreviewResources> => ({ pathname: "/preview.html", read: async () => new Response("asset") }),
    authorize: async () => {},
  };
  Object.assign(globalThis, { __htmlMountTestService: {
    mount: (_event: unknown, request: HtmlPreviewMountRequest, _resources: unknown, authorize: () => Promise<void>) => {
      state.mounts++; state.authorize = authorize; return { url: `withmate-html-preview://mount/${request.id}.html`, partition: "mount" };
    },
  } });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier.endsWith("/files/html-preview-service.js") ? { url: "withmate:test-mount-service", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      return url === "withmate:test-mount-service" ? { format: "module", shortCircuit: true, source: `
        export class HtmlPreviewService {
          mount(...args) { return globalThis.__htmlMountTestService.mount(...args); }
          dispose() {}
          respond() {}
        }
      ` } : next(url, context);
    },
  });
  const { registerHtmlPreviewHandlers } = await import("../../src-electron/ipc/html-preview.js");
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const authorization = {
    resolveEventWindow: () => state.window,
    resolveSessionWindow: (id: string) => id === "main" ? owner : null,
    getSessionFileExplorerOwnerSessionId: async (id: string) => id === "aux" ? state.ownerSession : null,
    getFilePreviewWindowResource: () => null,
  } as unknown as MainIpcSessionQueryDeps;
  registerHtmlPreviewHandlers({ handle: (channel: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(channel, handler) } as unknown as IpcMain, {
    authorization,
    resolveResources: async () => { state.resolves++; return state.resolveResources(); },
  });
  const mount = (id: string, inputSource = source) => Promise.resolve(handlers.get(HTML_PREVIEW_MOUNT)!(event as unknown as IpcMainInvokeEvent, { id, html: "<p>HTML</p>", source: inputSource }));
  const dispose = (id: string) => handlers.get(HTML_PREVIEW_DISPOSE)!(event as unknown as IpcMainInvokeEvent, id);
  return { state, event, owner, foreign, mount, dispose, close() {
    hooks.deregister(); Reflect.deleteProperty(globalThis, "__htmlMountTestService");
  } };
}

// @test-value v2
// kind = "security"
// claim = "mount IPCは認可されたlinkとroot resourceを受け入れ、foreign owner・subframe・HTML guest・期限切れsourceをresource解決前に拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "mountが出自のownerを確認しない、HTML guestのmain-frame IPCを受理する、または失効済みsessionを許可する"
// observable = "登録mount handlerの結果・拒否とresource resolver/service mount呼出回数"
// observation_boundary = "public-boundary"
// scope = "HTML mount IPCのsenderとsource認可"
// lifecycle = "permanent"
// impact = "HTMLや別Windowからlocal資源の認可を取得する権限逸脱を防ぐ"
// distinction = "read IPC testはmount専用source認可とHTML session判定を通らないため、この小さなhandler testで確認する"
// @end-test-value
test("HTML mount authorizes source and main app sender before resolving resources", async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.mount("link"), { url: "withmate-html-preview://mount/link.html", partition: "mount" });
    await h.mount("resource", { kind: "resource", resource: { sessionId: "aux", rootId: "workspace", relativePath: "preview.html" } });
    assert.equal(h.state.mounts, 2);
    h.state.window = h.foreign;
    await assert.rejects(h.mount("foreign"), /current Preview resource/);
    h.state.window = h.owner;
    h.event.senderFrame = {};
    await assert.rejects(h.mount("subframe"), /original main application frame/);
    h.event.senderFrame = h.event.sender.mainFrame;
    h.state.ownerSession = null;
    await assert.rejects(h.mount("expired"), /current Preview resource/);
    h.state.ownerSession = "main";
    registerHtmlPreviewSession(h.event.sender.session as Electron.Session);
    await assert.rejects(h.mount("guest"), /cannot use WithMate IPC/);
    assert.equal(h.state.resolves, 2);
    assert.equal(h.state.mounts, 2);
  } finally { h.close(); }
});

// @test-value v2
// kind = "security"
// claim = "非同期resource解決中にownerが変化またはdisposeしたmountは公開されず、成功mountへ渡す再認可も失効を検出する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "resource解決後の再認可やpending取消を省略し、失効したownerへmountを返す"
// observable = "遅延mount promiseの拒否、service mount回数と渡されたauthorize callbackの拒否"
// observation_boundary = "public-boundary"
// scope = "HTML mount IPCの非同期認可・取消境界"
// lifecycle = "permanent"
// impact = "表示終了やowner切替後の遅延mountによるlocal資源公開を防ぐ"
// distinction = "同期sender testと型検査ではawait中のowner・取消状態変化を検出できない"
// @end-test-value
test("HTML mount rechecks late authorization and respects pending cancellation", async () => {
  const h = await harness();
  try {
    await h.mount("active");
    h.state.ownerSession = null;
    await assert.rejects(h.state.authorize(), /current Preview resource/);
    h.state.ownerSession = "main";
    let release!: (resources: HtmlPreviewResources) => void;
    h.state.resolveResources = () => new Promise((resolve) => { release = resolve; });
    const late = h.mount("late");
    await flush();
    h.state.window = h.foreign;
    release({ pathname: "/preview.html", read: async () => new Response("asset") });
    await assert.rejects(late, /original main application frame/);
    h.state.window = h.owner;
    const canceled = h.mount("canceled");
    await flush();
    h.dispose("canceled");
    release({ pathname: "/preview.html", read: async () => new Response("asset") });
    await assert.rejects(canceled, /mount was canceled/);
    assert.equal(h.state.mounts, 1);
  } finally { h.close(); }
});
