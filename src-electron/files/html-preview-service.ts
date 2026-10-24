import { randomUUID } from "node:crypto";
import { BrowserWindow, protocol, session, webFrameMain, type IpcMainInvokeEvent, type WebFrameMain } from "electron";
import type { HtmlPreviewEvent, HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_EVENT, HTML_PREVIEW_SCHEME } from "../../src-shared/window/html-preview.js";
import { assertHtmlPreviewMount, HTML_PREVIEW_CSP } from "./html-preview-policy.js";

type Preview = {
  id: string; owner: BrowserWindow; html: string; url: string;
  frame?: WebFrameMain; requested: boolean; loaded: boolean; cleanup: () => void;
};

export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Serves authorized HTML to opaque-origin iframes, without an application preload. */
export class HtmlPreviewService {
  private readonly previews = new Map<string, Preview>();

  constructor() {
    const browserSession = session.defaultSession;
    browserSession.webRequest.onBeforeRequest({ urls: [`${HTML_PREVIEW_SCHEME}://*/*`] }, (details, callback) => {
      const preview = [...this.previews.values()].find((entry) => entry.url === details.url);
      const allowed = !!preview && !preview.owner.isDestroyed()
        && details.webContentsId === preview.owner.webContents.id
        && details.resourceType === "subFrame" && details.method === "GET" && !preview.requested;
      if (allowed) preview.requested = true;
      else if (preview && !preview.owner.isDestroyed() && details.webContentsId === preview.owner.webContents.id) {
        this.fail(preview, "Navigation is blocked in HTML Preview. Reload the preview to return to the document.");
      }
      callback({ cancel: !allowed });
    });
    browserSession.protocol.handle(HTML_PREVIEW_SCHEME, (request) => {
      const preview = [...this.previews.values()].find((entry) => entry.url === request.url);
      if (!preview || !preview.requested || request.method !== "GET") return new Response(null, { status: 403 });
      return new Response(preview.html, { headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": HTML_PREVIEW_CSP,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), usb=(), hid=(), serial=(), payment=(), fullscreen=()",
      } });
    });
  }

  private owner(event: IpcMainInvokeEvent): BrowserWindow {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents !== event.sender
      || event.senderFrame !== event.sender.mainFrame) throw new Error("HTML preview sender is not an application window.");
    return owner;
  }

  private key(owner: BrowserWindow, id: string): string { return `${owner.id}:${id}`; }

  private report(preview: Preview, event: { type: "warning" | "error"; message: string } | { type: "ready" | "return-focus" | "find" }): void {
    if (!preview.owner.isDestroyed()) preview.owner.webContents.send(HTML_PREVIEW_EVENT,
      { id: preview.id, ...event } satisfies HtmlPreviewEvent);
  }

  private fail(preview: Preview, message: string): void {
    this.report(preview, { type: "error", message });
    this.remove(this.key(preview.owner, preview.id));
  }

  mount(event: IpcMainInvokeEvent, request: HtmlPreviewMountRequest): string {
    const owner = this.owner(event);
    const contents = owner.webContents;
    assertHtmlPreviewMount(request);
    const key = this.key(owner, request.id);
    if (this.previews.has(key)) throw new Error("HTML preview is already mounted.");
    const url = `${HTML_PREVIEW_SCHEME}://${randomUUID()}/`;
    const dispose = () => this.remove(key);
    const active = () => this.previews.get(key) === preview;
    const onStopped = () => {
      if (active()) this.fail(preview, "HTML Preview stopped responding. Reload the preview to try again.");
    };
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    const checkFrame = async () => {
      if (!active()) return;
      if (!preview.frame || preview.frame.isDestroyed()) { onStopped(); return; }
      responseTimer = setTimeout(onStopped, 15_000);
      try {
        // Owner WebContents events do not report a separately isolated iframe's crash.
        await preview.frame.executeJavaScript("void 0");
      } catch {
        onStopped();
      } finally {
        clearTimeout(responseTimer);
        if (active()) healthTimer = setTimeout(() => { void checkFrame(); }, 5_000);
      }
    };
    const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) { dispose(); return; }
      if (details.isMainFrame || details.isSameDocument) return;
      if (details.url === url && !preview.frame) preview.frame = details.frame ?? undefined;
      else if (details.frame && details.frame === preview.frame && details.url !== url) {
        this.fail(preview, "Navigation is blocked in HTML Preview. Reload the preview to return to the document.");
      }
    };
    const onNavigate = (details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      if (!details.frame || details.frame !== preview.frame) return;
      if (details.url === url && !preview.loaded) return;
      details.preventDefault();
      this.report(preview, { type: "warning", message: "Navigation is blocked in HTML Preview." });
    };
    const onLoad = (_event: Electron.Event, isMainFrame: boolean, processId: number, routingId: number) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (preview.loaded || !frame || frame.isDestroyed() || frame.url.split("#", 1)[0] !== url) return;
      preview.frame = frame;
      preview.loaded = true;
      clearTimeout(timer);
      this.report(preview, { type: "ready" });
      healthTimer = setTimeout(() => { void checkFrame(); }, 5_000);
    };
    const onConsole = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      if (!details.frame.isDestroyed() && details.frame.url.split("#", 1)[0] === url && details.level === "error") {
        this.report(preview, { type: "warning", message: `HTML content reported an error: ${details.message}`.slice(0, 500) });
      }
    };
    const onFailure = (_event: Electron.Event, _code: number, description: string, failedUrl: string,
      isMainFrame: boolean, processId: number, routingId: number) => {
      if (!isMainFrame && (failedUrl === url || (preview.frame && webFrameMain.fromId(processId, routingId) === preview.frame))) {
        this.fail(preview, `HTML Preview failed to load: ${description}. Use Source to inspect the file.`);
      }
    };
    const onInput = (inputEvent: Electron.Event, input: Electron.Input) => {
      if (!preview.frame || contents.focusedFrame !== preview.frame || input.type !== "keyDown") return;
      const find = (input.control || input.meta) && input.key.toLowerCase() === "f";
      if (input.key !== "F6" && !find) return;
      inputEvent.preventDefault();
      this.report(preview, { type: find ? "find" : "return-focus" });
    };
    const timer = setTimeout(() => this.fail(preview,
      "HTML Preview did not finish loading within 15 seconds. Use Source to inspect the file."), 15_000);
    const preview: Preview = { id: request.id, owner, html: request.html, url, requested: false, loaded: false, cleanup: () => {
      clearTimeout(timer);
      clearTimeout(healthTimer);
      clearTimeout(responseTimer);
      owner.removeListener("closed", dispose);
      // Electron listener-removal hooks can access native state after WebContents destruction.
      if (contents.isDestroyed()) return;
      contents.removeListener("did-start-navigation", onStart);
      contents.removeListener("will-frame-navigate", onNavigate);
      contents.removeListener("did-frame-finish-load", onLoad);
      contents.removeListener("did-fail-load", onFailure);
      contents.removeListener("console-message", onConsole);
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("render-process-gone", onStopped);
      contents.removeListener("unresponsive", onStopped);
    } };
    this.previews.set(key, preview);
    owner.once("closed", dispose);
    contents.on("did-start-navigation", onStart);
    contents.on("will-frame-navigate", onNavigate);
    contents.on("did-frame-finish-load", onLoad);
    contents.on("did-fail-load", onFailure);
    contents.on("console-message", onConsole);
    contents.on("before-input-event", onInput);
    contents.once("render-process-gone", onStopped);
    contents.on("unresponsive", onStopped);
    return url;
  }

  dispose(event: IpcMainInvokeEvent, id: string): void { this.remove(this.key(this.owner(event), id)); }

  private remove(key: string): void {
    const preview = this.previews.get(key);
    if (!preview) return;
    this.previews.delete(key);
    preview.cleanup();
  }
}
