import { randomUUID } from "node:crypto";
import { BrowserWindow, protocol, session, shell, type IpcMainInvokeEvent, type Session, type WebContents } from "electron";
import type { HtmlPreviewEvent, HtmlPreviewMountRequest, HtmlPreviewMountResult, HtmlPreviewPrompt } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_EVENT, HTML_PREVIEW_SCHEME } from "../../src-shared/window/html-preview.js";
import { assertHtmlPreviewMount } from "./html-preview-policy.js";
import { assertNotHtmlPreviewSender, registerHtmlPreviewSession } from "./html-preview-isolation.js";
import { installHtmlPreviewPermissions } from "./html-preview-permissions.js";
import type { HtmlPreviewResources } from "./html-preview-resources.js";

type Prompt = { value: HtmlPreviewPrompt; finish: (choice: number | null) => void };
type Preview = {
  id: string; owner: BrowserWindow; partition: string; session: Session; url: string;
  guest?: WebContents; contents: Set<WebContents>; windows: Set<BrowserWindow>;
  prompts: Prompt[]; attach: (contents: WebContents) => void; cleanup: () => void;
};
const mounts = new Map<string, Preview>();
const safePreferences: Electron.WebPreferences = {
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
  webviewTag: false, plugins: false, experimentalFeatures: false, navigateOnDragDrop: false,
};

export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME, privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, stream: true,
  } }]);
}

/** Installed before loading any trusted application document. Unregistered guests never attach. */
export function configureHtmlPreviewHost(contents: WebContents): void {
  contents.on("will-attach-webview", (event, preferences, params) => {
    const preview = mounts.get(params.partition);
    if (!preview || preview.owner.isDestroyed() || preview.owner.webContents !== contents
      || preview.guest || params.src !== preview.url) { event.preventDefault(); return; }
    delete preferences.preload;
    Object.assign(preferences, safePreferences, { session: preview.session });
  });
  contents.on("did-attach-webview", (_event, guest) => {
    const preview = [...mounts.values()].find((entry) => entry.session === guest.session);
    if (!preview || preview.owner.isDestroyed() || preview.owner.webContents !== contents || preview.guest) {
      guest.close({ waitForBeforeUnload: false });
      return;
    }
    preview.guest = guest;
    preview.attach(guest);
  });
}

function isWebUrl(value: string, preview: Preview): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:", "data:", "blob:"].includes(url.protocol)
      || (url.protocol === "about:" && ["blank", "srcdoc"].includes(url.pathname))
      || (url.protocol === `${HTML_PREVIEW_SCHEME}:` && url.host === new URL(preview.url).host);
  } catch { return false; }
}

export class HtmlPreviewService {
  private readonly previews = new Map<string, Preview>();

  private owner(event: IpcMainInvokeEvent): BrowserWindow {
    assertNotHtmlPreviewSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents !== event.sender
      || event.senderFrame !== event.sender.mainFrame) throw new Error("HTML preview sender is not an application window.");
    return owner;
  }

  private key(owner: BrowserWindow, id: string): string { return `${owner.id}:${id}`; }

  private report(preview: Preview, event: HtmlPreviewEvent): void {
    if (!preview.owner.isDestroyed() && !preview.owner.webContents.isDestroyed()) {
      preview.owner.webContents.send(HTML_PREVIEW_EVENT, event);
    }
  }

  private cancelPrompts(preview: Preview): void {
    const prompts = preview.prompts.splice(0);
    for (const prompt of prompts) prompt.finish(null);
    if (prompts.length) this.report(preview, { id: preview.id, type: "prompt", prompt: null });
  }

  respond(event: IpcMainInvokeEvent, id: string, requestId: string, choice: number | null): void {
    const preview = this.previews.get(this.key(this.owner(event), id));
    const prompt = preview?.prompts[0];
    if (!preview || !prompt || prompt.value.requestId !== requestId) throw new Error("This HTML request is no longer active.");
    if (choice !== null && (!Number.isInteger(choice) || choice < 0 || choice >= prompt.value.choices.length)) {
      throw new TypeError("Invalid HTML request response.");
    }
    preview.prompts.shift();
    prompt.finish(choice);
    this.report(preview, { id, type: "prompt", prompt: preview.prompts[0]?.value ?? null });
  }

  mount(event: IpcMainInvokeEvent, request: HtmlPreviewMountRequest, resources: HtmlPreviewResources,
    authorize: () => Promise<void>): HtmlPreviewMountResult {
    const owner = this.owner(event);
    assertHtmlPreviewMount(request);
    const key = this.key(owner, request.id);
    if (this.previews.has(key)) throw new Error("HTML preview is already mounted.");
    const token = randomUUID();
    const partition = `withmate-html-preview-${token}`;
    const browserSession = session.fromPartition(partition);
    registerHtmlPreviewSession(browserSession);
    const url = `${HTML_PREVIEW_SCHEME}://${token}${resources.pathname}`;
    const ownerContents = owner.webContents;
    const dispose = () => this.remove(key);
    const active = () => this.previews.get(key) === preview;
    const warn = (message: string) => this.report(preview, { id: preview.id, type: "warning", message });
    const fail = (message: string) => { if (active()) { this.report(preview, { id: preview.id, type: "error", message }); dispose(); } };
    const ask = (value: Omit<HtmlPreviewPrompt, "requestId">, signal: AbortSignal): Promise<number | null> => {
      if (!active() || signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const cancel = () => {
          const index = preview.prompts.indexOf(prompt);
          if (index < 0) return;
          preview.prompts.splice(index, 1);
          prompt.finish(null);
          if (index === 0) this.report(preview, { id: preview.id, type: "prompt", prompt: preview.prompts[0]?.value ?? null });
        };
        const prompt: Prompt = { value: { ...value, requestId: randomUUID() }, finish: (choice) => {
          signal.removeEventListener("abort", cancel);
          resolve(choice);
        } };
        signal.addEventListener("abort", cancel, { once: true });
        preview.prompts.push(prompt);
        if (preview.prompts.length === 1) this.report(preview, { id: preview.id, type: "prompt", prompt: preview.prompts[0]!.value });
      });
    };
    const pendingWindows = new Map<number, Promise<boolean>>();
    const downloads = new Set<Electron.DownloadItem>();
    const permissions = installHtmlPreviewPermissions(browserSession, {
      ask, isActive: active, ownsContents: (contents) => preview.contents.has(contents),
    });

    const openExternal = async (target: string, signal: AbortSignal) => {
      let parsed: URL;
      try { parsed = new URL(target); } catch { warn("This link is not a valid URL."); return; }
      if (["file:", "javascript:", "chrome:", "devtools:"].includes(parsed.protocol) || parsed.protocol.startsWith("withmate")) {
        warn("This link cannot access local files or WithMate internals. Select local files with the document's file picker.");
        return;
      }
      const selected = await ask({ title: "Open an external application?", detail: target, choices: ["Open"] }, signal);
      if (selected === 0 && active() && !signal.aborted) {
        try { await shell.openExternal(target); } catch { warn("The external application could not be opened."); }
      }
    };

    const attach = (contents: WebContents) => {
      let document = new AbortController();
      preview.contents.add(contents);
      permissions.attachContents(contents);
      contents.setWindowOpenHandler((details) => {
        if (!active()) return { action: "deny" };
        const opener = document.signal;
        if (!isWebUrl(details.url, preview)) { void openExternal(details.url, opener); return { action: "deny" }; }
        return {
          action: "allow",
          overrideBrowserWindowOptions: { show: false, autoHideMenuBar: true, webPreferences: { ...safePreferences, session: browserSession } },
          createWindow: (options) => {
            // Keep Chromium's opener/postBody handling; hold requests until confirmation.
            const child = new BrowserWindow({ ...options, show: false, webPreferences: { ...safePreferences, session: browserSession } });
            const childId = child.webContents.id;
            preview.windows.add(child);
            attach(child.webContents);
            const closed = new AbortController();
            child.once("closed", () => closed.abort());
            const confirmation = AbortSignal.any([opener, closed.signal]);
            const approved = ask({ title: "Open a preview window?", detail: details.url, choices: ["Open"] }, confirmation).then((selected) => {
              const allowed = selected === 0 && active() && !confirmation.aborted && !child.isDestroyed();
              pendingWindows.delete(childId);
              if (!child.isDestroyed()) { if (allowed) child.show(); else child.destroy(); }
              return allowed;
            });
            pendingWindows.set(childId, approved);
            child.on("closed", () => preview.windows.delete(child));
            return child.webContents;
          },
        };
      });
      contents.on("will-frame-navigate", (details) => {
        if (!isWebUrl(details.url, preview)) { details.preventDefault(); void openExternal(details.url, document.signal); }
      });
      contents.on("will-redirect", (details) => {
        if (!isWebUrl(details.url, preview)) { details.preventDefault(); void openExternal(details.url, document.signal); }
      });
      contents.on("did-start-navigation", (details) => {
        if (details.isSameDocument) return;
        document.abort();
        document = new AbortController();
        if (contents === preview.guest && details.isMainFrame && !details.isSameDocument) this.cancelPrompts(preview);
      });
      contents.on("dom-ready", () => {
        if (active() && contents === preview.guest) this.report(preview, { id: preview.id, type: "ready" });
      });
      const stopped = () => {
        if (contents === preview.guest) fail("HTML Preview stopped responding. Reload the preview to try again.");
        else if (active()) { warn("A preview window stopped responding and was closed."); contents.close({ waitForBeforeUnload: false }); }
      };
      contents.on("did-fail-load", (_event, code, description, _url, main) => {
        if (main && code !== -3 && contents === preview.guest) fail(`HTML Preview failed to load: ${description}. Use Source or Reload to continue.`);
      });
      contents.on("console-message", (details) => {
        if (details.level === "error") warn(`HTML content reported an error: ${details.message}`.slice(0, 500));
      });
      contents.on("before-input-event", (inputEvent, value) => {
        if (value.type !== "keyDown") return;
        const find = (value.control || value.meta) && value.key.toLowerCase() === "f";
        if (value.key !== "F6" && !find) return;
        inputEvent.preventDefault();
        this.report(preview, { id: preview.id, type: find ? "find" : "return-focus" });
      });
      contents.on("unresponsive", stopped);
      contents.on("render-process-gone", stopped);
      contents.once("destroyed", () => {
        document.abort();
        preview.contents.delete(contents);
        if (active() && contents === preview.guest) fail("HTML Preview closed. Reload the preview to continue.");
      });
    };
    const ownerNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) dispose();
    };
    const download = (_event: Electron.Event, item: Electron.DownloadItem, contents: WebContents) => {
      if (!active() || !preview.contents.has(contents)) { item.cancel(); return; }
      // Electron's Save dialog confirms destination and overwrite. Never choose an automatic save path.
      item.setSaveDialogOptions({ title: "Save HTML preview download" });
      downloads.add(item);
      item.once("done", (_doneEvent, state) => {
        downloads.delete(item);
        if (active() && state === "interrupted") warn("The download was interrupted.");
      });
    };
    const preview: Preview = { id: request.id, owner, partition, session: browserSession, url,
      contents: new Set(), windows: new Set(), prompts: [], attach, cleanup: () => {
        mounts.delete(partition);
        this.cancelPrompts(preview);
        for (const item of downloads) item.cancel();
        for (const window of preview.windows) if (!window.isDestroyed()) window.destroy();
        for (const contents of preview.contents) if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        permissions();
        browserSession.protocol.unhandle(HTML_PREVIEW_SCHEME);
        browserSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
        void Promise.all([browserSession.clearStorageData(), browserSession.clearCache(), browserSession.closeAllConnections()])
          .catch(() => { /* This unique, non-persistent partition is never reused. */ });
        browserSession.removeListener("will-download", download);
        owner.removeListener("closed", dispose);
        if (!ownerContents.isDestroyed()) {
          ownerContents.removeListener("did-start-navigation", ownerNavigate);
          ownerContents.removeListener("render-process-gone", dispose);
        }
      } };
    this.previews.set(key, preview);
    mounts.set(partition, preview);
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const pending = details.webContentsId === undefined ? undefined : pendingWindows.get(details.webContentsId);
      const allowed = () => active() && !details.url.startsWith("file:") && (details.webContentsId === undefined || details.webContentsId <= 0
        || [...preview.contents].some((contents) => contents.id === details.webContentsId));
      if (pending) void pending.then((approved) => callback({ cancel: !approved || !allowed() }));
      else callback({ cancel: !allowed() });
    });
    browserSession.protocol.handle(HTML_PREVIEW_SCHEME, async (incoming) => {
      const target = new URL(incoming.url);
      if (!active() || target.host !== token) return new Response(null, { status: 403 });
      if (incoming.method !== "GET" && incoming.method !== "HEAD") return new Response(null, { status: 405 });
      try {
        await authorize();
        if (!active()) return new Response(null, { status: 403 });
        const resource = target.pathname === resources.pathname
          ? new Response(incoming.method === "HEAD" ? null : request.html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          : await resources.read(target.pathname, incoming);
        try { await authorize(); } catch (error) { await resource.body?.cancel(); throw error; }
        if (!active()) { await resource.body?.cancel(); return new Response(null, { status: 403 }); }
        resource.headers.set("Cache-Control", "no-store");
        resource.headers.set("X-Content-Type-Options", "nosniff");
        resource.headers.set("Referrer-Policy", "no-referrer");
        resource.headers.set("Cross-Origin-Resource-Policy", "same-origin");
        return resource;
      } catch { return new Response("HTML resource is unavailable or no longer authorized.", { status: 403 }); }
    });
    browserSession.on("will-download", download);
    owner.once("closed", dispose);
    ownerContents.on("did-start-navigation", ownerNavigate);
    ownerContents.once("render-process-gone", dispose);
    return { url, partition };
  }

  dispose(event: IpcMainInvokeEvent, id: string): void { this.remove(this.key(this.owner(event), id)); }

  private remove(key: string): void {
    const preview = this.previews.get(key);
    if (!preview) return;
    this.previews.delete(key);
    preview.cleanup();
  }
}
