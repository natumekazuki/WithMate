import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import type {
  HtmlPreviewEvent,
  HtmlPreviewMountRequest,
  HtmlPreviewMountResult,
  HtmlPreviewPrompt,
} from "../../src-shared/window/html-preview.js";
import {
  HTML_PREVIEW_EVENT,
  HTML_PREVIEW_SCHEME,
} from "../../src-shared/window/html-preview.js";
import { assertHtmlPreviewMount } from "./html-preview-policy.js";
import {
  assertNotHtmlPreviewSender,
  registerHtmlPreviewSession,
} from "./html-preview-isolation.js";
import { installHtmlPreviewPermissions } from "./html-preview-permissions.js";
import type { HtmlPreviewResources } from "./html-preview-resources.js";

/** 所有ウィンドウへ送る確認内容と、回答または取消で待機中の処理を再開する手段。 */
type Prompt = {
  value: HtmlPreviewPrompt;
  finish: (choice: number | null) => void;
};
/** 一つのマウントに属する隔離セッション、ゲスト、子ウィンドウ、確認待ちの要求を保持する。 */
type Preview = {
  id: string;
  owner: BrowserWindow;
  partition: string;
  session: Session;
  url: string;
  guest?: WebContents;
  contents: Set<WebContents>;
  windows: Set<BrowserWindow>;
  prompts: Prompt[];
  attach: (contents: WebContents) => void;
  cleanup: () => void;
};
const mounts = new Map<string, Preview>();
const safePreferences: Electron.WebPreferences = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  plugins: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
};

/** Electron の起動初期に、本文と関連リソースの配信に使う専用スキームを登録する。 */
export function registerHtmlPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HTML_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: true,
        stream: true,
      },
    },
  ]);
}

/** 信頼されたアプリの文書を読み込む前に設定する。未登録のゲストはアタッチさせない。 */
export function configureHtmlPreviewHost(contents: WebContents): void {
  contents.on("will-attach-webview", (event, preferences, params) => {
    const preview = mounts.get(params.partition);
    if (
      !preview ||
      preview.owner.isDestroyed() ||
      preview.owner.webContents !== contents ||
      preview.guest ||
      params.src !== preview.url
    ) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    Object.assign(preferences, safePreferences, { session: preview.session });
  });
  contents.on("did-attach-webview", (_event, guest) => {
    const preview = [...mounts.values()].find(
      (entry) => entry.session === guest.session,
    );
    if (
      !preview ||
      preview.owner.isDestroyed() ||
      preview.owner.webContents !== contents ||
      preview.guest
    ) {
      guest.close({ waitForBeforeUnload: false });
      return;
    }
    preview.guest = guest;
    preview.attach(guest);
  });
}

/** 外部アプリに委ねずゲスト内で扱う Web URL と、このマウント自身の専用 URL を判定する。 */
function isWebUrl(value: string, preview: Preview): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:", "data:", "blob:"].includes(url.protocol) ||
      (url.protocol === "about:" &&
        ["blank", "srcdoc"].includes(url.pathname)) ||
      (url.protocol === `${HTML_PREVIEW_SCHEME}:` &&
        url.host === new URL(preview.url).host)
    );
  } catch {
    return false;
  }
}

/** HTML プレビューを所有ウィンドウごとに管理し、隔離セッションの配信・確認・破棄を取りまとめる。 */
export class HtmlPreviewService {
  private readonly previews = new Map<string, Preview>();

  /** ゲストを除外し、要求がアプリウィンドウ自身のメインフレームから来たことを確認する。 */
  private owner(event: IpcMainInvokeEvent): BrowserWindow {
    assertNotHtmlPreviewSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (
      !owner ||
      owner.isDestroyed() ||
      owner.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("HTML preview sender is not an application window.");
    return owner;
  }

  /** 同じプレビュー ID を別の所有ウィンドウで使っても衝突しない内部キーを作る。 */
  private key(owner: BrowserWindow, id: string): string {
    return `${owner.id}:${id}`;
  }

  /** 所有ウィンドウとそのコンテンツが生存している場合に、プレビューの状態を通知する。 */
  private report(preview: Preview, event: HtmlPreviewEvent): void {
    if (
      !preview.owner.isDestroyed() &&
      !preview.owner.webContents.isDestroyed()
    ) {
      preview.owner.webContents.send(HTML_PREVIEW_EVENT, event);
    }
  }

  /** 確認待ちをすべて未選択で完了し、表示中の確認 UI を閉じるよう通知する。 */
  private cancelPrompts(preview: Preview): void {
    const prompts = preview.prompts.splice(0);
    for (const prompt of prompts) prompt.finish(null);
    if (prompts.length)
      this.report(preview, { id: preview.id, type: "prompt", prompt: null });
  }

  /** 所有ウィンドウから届いた回答を、現在表示中の要求に限り適用して次の確認へ進む。 */
  respond(
    event: IpcMainInvokeEvent,
    id: string,
    requestId: string,
    choice: number | null,
  ): void {
    const preview = this.previews.get(this.key(this.owner(event), id));
    const prompt = preview?.prompts[0];
    if (!preview || !prompt || prompt.value.requestId !== requestId)
      throw new Error("This HTML request is no longer active.");
    if (
      choice !== null &&
      (!Number.isInteger(choice) ||
        choice < 0 ||
        choice >= prompt.value.choices.length)
    ) {
      throw new TypeError("Invalid HTML request response.");
    }
    preview.prompts.shift();
    prompt.finish(choice);
    this.report(preview, {
      id,
      type: "prompt",
      prompt: preview.prompts[0]?.value ?? null,
    });
  }

  /** マウント専用の非永続セッションを作り、配信時に参照元の認可を再確認するゲスト URL とパーティションを返す。 */
  mount(
    event: IpcMainInvokeEvent,
    request: HtmlPreviewMountRequest,
    resources: HtmlPreviewResources,
    authorize: () => Promise<void>,
  ): HtmlPreviewMountResult {
    const owner = this.owner(event);
    assertHtmlPreviewMount(request);
    const key = this.key(owner, request.id);
    if (this.previews.has(key))
      throw new Error("HTML preview is already mounted.");
    const token = randomUUID();
    const partition = `withmate-html-preview-${token}`;
    const browserSession = session.fromPartition(partition);
    registerHtmlPreviewSession(browserSession);
    const url = `${HTML_PREVIEW_SCHEME}://${token}${resources.pathname}`;
    const ownerContents = owner.webContents;
    /** 所有ウィンドウの終了や遷移に合わせ、登録済みのマウントを破棄する。 */
    const dispose = () => this.remove(key);
    /** 同じキーが使い直されても、このマウントの非同期処理を再開しないよう実体で照合する。 */
    const active = () => this.previews.get(key) === preview;
    /** プレビューを閉じる必要のない問題を所有側の UI に伝える。 */
    const warn = (message: string) =>
      this.report(preview, { id: preview.id, type: "warning", message });
    /** このマウントがまだ有効なら、継続できない障害を通知して破棄する。 */
    const fail = (message: string) => {
      if (active()) {
        this.report(preview, { id: preview.id, type: "error", message });
        dispose();
      }
    };
    /** 確認を順番待ちに追加し、所有ウィンドウの回答または要求元の取消まで待つ。 */
    const ask = (
      value: Omit<HtmlPreviewPrompt, "requestId">,
      signal: AbortSignal,
    ): Promise<number | null> => {
      if (!active() || signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        /** この要求を未選択で取り除き、先頭の要求だった場合だけ確認 UI を更新する。 */
        const cancel = () => {
          const index = preview.prompts.indexOf(prompt);
          if (index < 0) return;
          preview.prompts.splice(index, 1);
          prompt.finish(null);
          if (index === 0)
            this.report(preview, {
              id: preview.id,
              type: "prompt",
              prompt: preview.prompts[0]?.value ?? null,
            });
        };
        const prompt: Prompt = {
          value: { ...value, requestId: randomUUID() },
          /** 回答待ちが終わった時点で取消リスナーを外し、選択結果を呼び出し元へ返す。 */
          finish: (choice) => {
            signal.removeEventListener("abort", cancel);
            resolve(choice);
          },
        };
        signal.addEventListener("abort", cancel, { once: true });
        preview.prompts.push(prompt);
        if (preview.prompts.length === 1)
          this.report(preview, {
            id: preview.id,
            type: "prompt",
            prompt: preview.prompts[0]!.value,
          });
      });
    };
    const pendingWindows = new Map<number, Promise<boolean>>();
    const downloads = new Set<Electron.DownloadItem>();
    const permissions = installHtmlPreviewPermissions(browserSession, {
      ask,
      isActive: active,
      /** このマウントに追加済みのゲストまたは子コンテンツだけを権限判定の対象にする。 */
      ownsContents: (contents) => preview.contents.has(contents),
    });

    /** 禁止スキームを除外し、要求元が有効な間に利用者が承認した URL だけを OS に渡す。 */
    const openExternal = async (target: string, signal: AbortSignal) => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        warn("This link is not a valid URL.");
        return;
      }
      if (
        ["file:", "javascript:", "chrome:", "devtools:"].includes(
          parsed.protocol,
        ) ||
        parsed.protocol.startsWith("withmate")
      ) {
        warn(
          "This link cannot access local files or WithMate internals. Select local files with the document's file picker.",
        );
        return;
      }
      const selected = await ask(
        {
          title: "Open an external application?",
          detail: target,
          choices: ["Open"],
        },
        signal,
      );
      if (selected === 0 && active() && !signal.aborted) {
        try {
          await shell.openExternal(target);
        } catch {
          warn("The external application could not be opened.");
        }
      }
    };

    /** ゲストや子ウィンドウを登録し、文書単位でナビゲーション、確認、障害を扱う。 */
    const attach = (contents: WebContents) => {
      let document = new AbortController();
      preview.contents.add(contents);
      permissions.attachContents(contents);
      contents.setWindowOpenHandler((details) => {
        if (!active()) return { action: "deny" };
        const opener = document.signal;
        if (!isWebUrl(details.url, preview)) {
          void openExternal(details.url, opener);
          return { action: "deny" };
        }
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            show: false,
            autoHideMenuBar: true,
            webPreferences: { ...safePreferences, session: browserSession },
          },
          /** Chromium のウィンドウ生成手順を保ち、確認が取れるまで子ウィンドウを非表示にする。 */
          createWindow: (options) => {
            // Chromium の opener と postBody の処理を維持し、確認が済むまで要求を保留する。
            const child = new BrowserWindow({
              ...options,
              show: false,
              webPreferences: { ...safePreferences, session: browserSession },
            });
            const childId = child.webContents.id;
            preview.windows.add(child);
            attach(child.webContents);
            const closed = new AbortController();
            child.once("closed", () => closed.abort());
            const confirmation = AbortSignal.any([opener, closed.signal]);
            const approved = ask(
              {
                title: "Open a preview window?",
                detail: details.url,
                choices: ["Open"],
              },
              confirmation,
            ).then((selected) => {
              const allowed =
                selected === 0 &&
                active() &&
                !confirmation.aborted &&
                !child.isDestroyed();
              pendingWindows.delete(childId);
              if (!child.isDestroyed()) {
                if (allowed) child.show();
                else child.destroy();
              }
              return allowed;
            });
            pendingWindows.set(childId, approved);
            child.on("closed", () => preview.windows.delete(child));
            return child.webContents;
          },
        };
      });
      contents.on("will-frame-navigate", (details) => {
        if (!isWebUrl(details.url, preview)) {
          details.preventDefault();
          void openExternal(details.url, document.signal);
        }
      });
      contents.on("will-redirect", (details) => {
        if (!isWebUrl(details.url, preview)) {
          details.preventDefault();
          void openExternal(details.url, document.signal);
        }
      });
      contents.on("did-start-navigation", (details) => {
        if (details.isSameDocument) return;
        document.abort();
        document = new AbortController();
        if (
          contents === preview.guest &&
          details.isMainFrame &&
          !details.isSameDocument
        )
          this.cancelPrompts(preview);
      });
      contents.on("dom-ready", () => {
        if (active() && contents === preview.guest)
          this.report(preview, { id: preview.id, type: "ready" });
      });
      /** ゲスト本体の停止ならマウントを終了し、子ウィンドウの停止ならそのコンテンツだけを閉じる。 */
      const stopped = () => {
        if (contents === preview.guest)
          fail(
            "HTML Preview stopped responding. Reload the preview to try again.",
          );
        else if (active()) {
          warn("A preview window stopped responding and was closed.");
          contents.close({ waitForBeforeUnload: false });
        }
      };
      contents.on("did-fail-load", (_event, code, description, _url, main) => {
        if (main && code !== -3 && contents === preview.guest)
          fail(
            `HTML Preview failed to load: ${description}. Use Source or Reload to continue.`,
          );
      });
      contents.on("console-message", (details) => {
        if (details.level === "error")
          warn(
            `HTML content reported an error: ${details.message}`.slice(0, 500),
          );
      });
      contents.on("before-input-event", (inputEvent, value) => {
        if (value.type !== "keyDown") return;
        const find =
          (value.control || value.meta) && value.key.toLowerCase() === "f";
        if (value.key !== "F6" && !find) return;
        inputEvent.preventDefault();
        this.report(preview, {
          id: preview.id,
          type: find ? "find" : "return-focus",
        });
      });
      contents.on("unresponsive", stopped);
      contents.on("render-process-gone", stopped);
      contents.once("destroyed", () => {
        document.abort();
        preview.contents.delete(contents);
        if (active() && contents === preview.guest)
          fail("HTML Preview closed. Reload the preview to continue.");
      });
    };
    /** 所有側のメインフレームが別文書へ移った時点で、元の文書に属するマウントを破棄する。 */
    const ownerNavigate = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (details.isMainFrame && !details.isSameDocument) dispose();
    };
    /** 管理対象からのダウンロードだけに保存ダイアログを設定し、マウント終了時の取消に備える。 */
    const download = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => {
      if (!active() || !preview.contents.has(contents)) {
        item.cancel();
        return;
      }
      // 保存先と上書きは Electron の保存ダイアログで確認する。保存先を自動で決めない。
      item.setSaveDialogOptions({ title: "Save HTML preview download" });
      downloads.add(item);
      item.once("done", (_doneEvent, state) => {
        downloads.delete(item);
        if (active() && state === "interrupted")
          warn("The download was interrupted.");
      });
    };
    const preview: Preview = {
      id: request.id,
      owner,
      partition,
      session: browserSession,
      url,
      contents: new Set(),
      windows: new Set(),
      prompts: [],
      attach,
      /** ゲスト・確認・ダウンロードを終了し、専用セッションの配信と通信を止めて状態を消去する。 */
      cleanup: () => {
        mounts.delete(partition);
        this.cancelPrompts(preview);
        for (const item of downloads) item.cancel();
        for (const window of preview.windows)
          if (!window.isDestroyed()) window.destroy();
        for (const contents of preview.contents)
          if (!contents.isDestroyed())
            contents.close({ waitForBeforeUnload: false });
        permissions();
        browserSession.protocol.unhandle(HTML_PREVIEW_SCHEME);
        browserSession.webRequest.onBeforeRequest((_details, callback) =>
          callback({ cancel: true }),
        );
        void Promise.all([
          browserSession.clearStorageData(),
          browserSession.clearCache(),
          browserSession.closeAllConnections(),
        ]).catch(() => {
          /* この非永続の専用パーティションは再利用しない。 */
        });
        browserSession.removeListener("will-download", download);
        owner.removeListener("closed", dispose);
        if (!ownerContents.isDestroyed()) {
          ownerContents.removeListener("did-start-navigation", ownerNavigate);
          ownerContents.removeListener("render-process-gone", dispose);
        }
      },
    };
    this.previews.set(key, preview);
    mounts.set(partition, preview);
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const pending =
        details.webContentsId === undefined
          ? undefined
          : pendingWindows.get(details.webContentsId);
      /** 子ウィンドウの確認待ちが終わった後も、マウントの有効性と要求元を再判定する。 */
      const allowed = () =>
        active() &&
        !details.url.startsWith("file:") &&
        (details.webContentsId === undefined ||
          details.webContentsId <= 0 ||
          [...preview.contents].some(
            (contents) => contents.id === details.webContentsId,
          ));
      if (pending)
        void pending.then((approved) =>
          callback({ cancel: !approved || !allowed() }),
        );
      else callback({ cancel: !allowed() });
    });
    browserSession.protocol.handle(HTML_PREVIEW_SCHEME, async (incoming) => {
      const target = new URL(incoming.url);
      if (!active() || target.host !== token)
        return new Response(null, { status: 403 });
      if (incoming.method !== "GET" && incoming.method !== "HEAD")
        return new Response(null, { status: 405 });
      try {
        await authorize();
        if (!active()) return new Response(null, { status: 403 });
        const resource =
          target.pathname === resources.pathname
            ? new Response(incoming.method === "HEAD" ? null : request.html, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              })
            : await resources.read(target.pathname, incoming);
        try {
          await authorize();
        } catch (error) {
          await resource.body?.cancel();
          throw error;
        }
        if (!active()) {
          await resource.body?.cancel();
          return new Response(null, { status: 403 });
        }
        resource.headers.set("Cache-Control", "no-store");
        resource.headers.set("X-Content-Type-Options", "nosniff");
        resource.headers.set("Referrer-Policy", "no-referrer");
        resource.headers.set("Cross-Origin-Resource-Policy", "same-origin");
        return resource;
      } catch {
        return new Response(
          "HTML resource is unavailable or no longer authorized.",
          { status: 403 },
        );
      }
    });
    browserSession.on("will-download", download);
    owner.once("closed", dispose);
    ownerContents.on("did-start-navigation", ownerNavigate);
    ownerContents.once("render-process-gone", dispose);
    return { url, partition };
  }

  /** 呼び出し元の所有ウィンドウに属するマウントだけを破棄する。 */
  dispose(event: IpcMainInvokeEvent, id: string): void {
    this.remove(this.key(this.owner(event), id));
  }

  /** 後処理を始める前にマウントを登録から外し、進行中の処理から無効と判定されるようにする。 */
  private remove(key: string): void {
    const preview = this.previews.get(key);
    if (!preview) return;
    this.previews.delete(key);
    preview.cleanup();
  }
}
