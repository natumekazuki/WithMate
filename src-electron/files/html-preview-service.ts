import { randomUUID } from "node:crypto";
import { BrowserWindow, session, View, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { HtmlPreviewEvent, HtmlPreviewLayout, HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_EVENT } from "../../src-shared/window/html-preview.js";
import { assertHtmlPreviewMount, clipHtmlPreviewLayout, HTML_PREVIEW_CSP } from "./html-preview-policy.js";

type Sender = IpcMainEvent | IpcMainInvokeEvent;
type Preview = { id: string; owner: BrowserWindow; container: View; view: WebContentsView; html: string; url: string; cleanup: () => void };

/** Owns untrusted HTML only; it never reads a path or exposes the application preload. */
export class HtmlPreviewService {
  private readonly previews = new Map<string, Preview>();
  private readonly isolatedSession = session.fromPartition("withmate-html-preview", { cache: false });

  constructor() {
    this.isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.isolatedSession.setPermissionCheckHandler(() => false);
    this.isolatedSession.setDevicePermissionHandler(() => false);
    this.isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.isolatedSession.on("will-download", (event, _item, contents) => {
      event.preventDefault();
      const preview = [...this.previews.values()].find((entry) => entry.view.webContents === contents);
      if (preview) this.report(preview, "warning", "Downloads are blocked in HTML Preview.");
    });
    this.isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      const preview = [...this.previews.values()].find((entry) => entry.url === details.url);
      callback({ cancel: !preview || preview.view.webContents.id !== details.webContentsId
        || details.resourceType !== "mainFrame" || details.method !== "GET" });
    });
    this.isolatedSession.protocol.handle("https", (request) => {
      const preview = [...this.previews.values()].find((entry) => entry.url === request.url);
      if (!preview || request.method !== "GET") return new Response(null, { status: 403 });
      return new Response(preview.html, { headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": HTML_PREVIEW_CSP,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      } });
    });
  }

  private owner(event: Sender): BrowserWindow {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents !== event.sender
      || event.senderFrame !== event.sender.mainFrame) throw new Error("HTML preview sender is not an application window.");
    return owner;
  }

  private key(owner: BrowserWindow, id: string): string { return `${owner.id}:${id}`; }

  private report(preview: Preview, type: "warning" | "error", message: string): void {
    if (!preview.owner.isDestroyed()) preview.owner.webContents.send(HTML_PREVIEW_EVENT,
      { id: preview.id, type, message: message.slice(0, 500) } satisfies HtmlPreviewEvent);
  }

  async mount(event: Sender, request: HtmlPreviewMountRequest): Promise<void> {
    const owner = this.owner(event);
    const ownerContents = owner.webContents;
    assertHtmlPreviewMount(request);
    const key = this.key(owner, request.id);
    if (this.previews.has(key)) throw new Error("HTML preview is already mounted.");
    const container = new View();
    const view = new WebContentsView({ webPreferences: {
      session: this.isolatedSession, sandbox: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, contextIsolation: true, webSecurity: true,
      webviewTag: false, navigateOnDragDrop: false, safeDialogs: true, autoplayPolicy: "user-gesture-required",
    } });
    const url = `https://preview.invalid/${randomUUID()}`;
    const dispose = () => this.remove(key);
    const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) dispose();
    };
    const preview: Preview = { id: request.id, owner, container, view, html: request.html, url, cleanup: () => {
      owner.removeListener("closed", dispose);
      ownerContents.removeListener("did-start-navigation", onNavigation);
      ownerContents.removeListener("render-process-gone", dispose);
    } };
    this.previews.set(key, preview);
    owner.once("closed", dispose);
    ownerContents.on("did-start-navigation", onNavigation);
    ownerContents.once("render-process-gone", dispose);
    container.setVisible(false);
    container.addChildView(view);
    owner.contentView.addChildView(container);
    view.webContents.setWindowOpenHandler(() => {
      this.report(preview, "warning", "Opening windows is blocked in HTML Preview.");
      return { action: "deny" };
    });
    const blockNavigation = (event: Electron.Event) => {
      event.preventDefault();
      this.report(preview, "warning", "Navigation is blocked in HTML Preview.");
    };
    view.webContents.on("will-frame-navigate", blockNavigation);
    view.webContents.on("will-redirect", blockNavigation);
    view.webContents.on("will-attach-webview", blockNavigation);
    let initialNavigationStarted = false;
    view.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (!initialNavigationStarted && details.url === url) {
        initialNavigationStarted = true;
        return;
      }
      // Dispose unexpected document transitions even when no cancellable event fires.
      this.report(preview, "error", "Navigation is blocked in HTML Preview. Reload the preview to return to the document.");
      this.remove(key);
    });
    view.webContents.on("console-message", (details) => {
      if (details.level === "error") this.report(preview, "warning", `HTML content reported an error: ${details.message}`);
    });
    view.webContents.on("render-process-gone", () => {
      container.setVisible(false);
      this.report(preview, "error", "HTML Preview stopped. Reload the preview to try again.");
    });
    view.webContents.on("unresponsive", () => {
      this.report(preview, "error", "HTML Preview stopped responding. Reload the preview to try again.");
      this.remove(key);
    });
    view.webContents.on("before-input-event", (inputEvent, input) => {
      const find = (input.control || input.meta) && input.key.toLowerCase() === "f";
      if (input.type !== "keyDown" || (input.key !== "F6" && !find)) return;
      inputEvent.preventDefault();
      owner.webContents.focus();
      owner.webContents.send(HTML_PREVIEW_EVENT, { id: request.id, type: find ? "find" : "return-focus" } satisfies HtmlPreviewEvent);
    });
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        view.webContents.loadURL(url),
        new Promise<never>((_resolve, reject) => {
          loadTimer = setTimeout(() => reject(new Error("HTML Preview did not finish loading within 15 seconds. Use Source to inspect the file.")), 15_000);
        }),
      ]);
    } catch (error) {
      this.remove(key);
      throw error;
    } finally {
      clearTimeout(loadTimer);
    }
  }

  layout(event: Sender, id: string, layout: HtmlPreviewLayout): void {
    const owner = this.owner(event);
    const preview = this.previews.get(this.key(owner, id));
    if (!preview) return;
    const [width, height] = owner.getContentSize();
    const scale = owner.webContents.getZoomFactor();
    const scaled = (rect: HtmlPreviewLayout["bounds"]) => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
    const { bounds, clip, visible } = clipHtmlPreviewLayout({ ...layout, bounds: scaled(layout.bounds), clip: scaled(layout.clip) }, { width, height });
    preview.container.setVisible(visible);
    if (!visible) {
      if (preview.view.webContents.isFocused()) owner.webContents.focus();
      return;
    }
    preview.container.setBounds(clip);
    preview.view.setBounds({ x: bounds.x - clip.x, y: bounds.y - clip.y, width: bounds.width, height: bounds.height });
    preview.view.webContents.setZoomFactor(scale);
  }

  focus(event: Sender, id: string): void {
    const owner = this.owner(event);
    this.previews.get(this.key(owner, id))?.view.webContents.focus();
  }

  dispose(event: Sender, id: string): void { this.remove(this.key(this.owner(event), id)); }

  private remove(key: string): void {
    const preview = this.previews.get(key);
    if (!preview) return;
    this.previews.delete(key);
    preview.cleanup();
    if (!preview.owner.isDestroyed()) preview.owner.contentView.removeChildView(preview.container);
    preview.container.removeChildView(preview.view);
    if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close();
  }
}
