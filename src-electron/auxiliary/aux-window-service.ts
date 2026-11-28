import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import type {
  FileRootGitHistoryDiffRequest,
  SessionFilePreviewWindowPayload,
  SessionFilePreviewResourceRequest,
  SessionFilePreviewWindowSummary,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileAbsoluteResource,
  isSessionFileGitCommitResource,
  resolveSessionFilePreviewWindowTitle,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type {
  ChatEntryMode,
  HomeEntryMode,
  WindowLike,
} from "../windows/window-entry-loader.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
  FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
} from "../windows/window-defaults.js";

/** Home や独立したプレビューを読み込み、表示・再利用・閉鎖するためのウィンドウ操作。 */
type BaseWindowLike = WindowLike & {
  /** 現在の参照が再利用できるウィンドウか判定する。 */
  isDestroyed(): boolean;
  /** 画面を再利用する前に最小化状態を確認する。 */
  isMinimized(): boolean;
  /** 前面へ戻す前に最小化を解除する。 */
  restore(): void;
  /** 再利用するウィンドウへフォーカスを移す。 */
  focus(): void;
  /** 読み込み後にウィンドウを可視にする。 */
  show(): void;
  /** 対象ウィンドウの通常の閉鎖を要求する。 */
  close(): void;
  /** 監視ウィンドウの最前面表示とそのレベルを設定する。 */
  setAlwaysOnTop(flag: boolean, level?: string): void;
  /** 初回表示が可能になった時点の処理を一度だけ登録する。 */
  once(event: "ready-to-show", listener: () => void): void;
  /** 閉鎖後にウィンドウと参照データの登録を外すための通知を受け取る。 */
  on(event: "closed", listener: () => void): void;
};

/** 通常ファイルと履歴差分のどちらでも、表示内容の参照元となる Session ID を取得する。 */
function getFilePreviewPayloadSessionId(
  payload: SessionFilePreviewWindowPayload,
): string {
  return "historyDiff" in payload
    ? payload.historyDiff.request.sessionId
    : payload.resource.sessionId;
}

/** 表示中のファイル参照を返す。履歴差分では選択された参照、その後側、前側の順に探す。 */
function getFilePreviewPayloadResource(
  payload: SessionFilePreviewWindowPayload,
): SessionFilePreviewResourceRequest | null {
  if ("historyDiff" in payload) {
    return (
      payload.historyDiff.previewResource ??
      payload.historyDiff.previewAfterResource ??
      payload.historyDiff.previewBeforeResource
    );
  }
  return payload.resource;
}

/** Home 系ウィンドウの生成、renderer の読み込みと、プレビュー操作に必要な依存関係。 */
export type AuxWindowServiceDeps<TWindow extends BaseWindowLike> = {
  /** 用途ごとの表示寸法、タイトル、最前面設定や Home 用の枠指定でウィンドウを作る。 */
  createWindow(options: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    title: string;
    alwaysOnTop?: boolean;
    homeBounds?: boolean;
  }): TWindow;
  /** 同じ renderer エントリを Home、監視または設定の表示として読み込む。 */
  loadHomeEntry(window: TWindow, mode: HomeEntryMode): Promise<void>;
  /** 差分表示のトークンを専用 renderer の初回読み込みに渡す。 */
  loadDiffEntry(window: TWindow, token: string): Promise<void>;
  /** ファイルプレビューのトークンを読み込み時に渡し、表示する参照を解決できるようにする。 */
  loadFilePreviewEntry(window: TWindow, token: string): Promise<void>;
  /** 既存のプレビューを読み込み直さず、renderer 内で対象を切り替える。 */
  navigateFilePreviewWindow?(
    window: TWindow,
    payload: SessionFilePreviewWindowPayload,
  ): void;
  /** 対象 Session を指定して会話エントリを読み込む。 */
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  /** Character ID を指定する編集、または未指定の新規作成の画面を読み込む。 */
  loadCharacterEditorEntry(
    window: TWindow,
    characterId?: string | null,
  ): Promise<void>;
  /** 差分またはファイルプレビューのウィンドウと内容を結び付けるトークンを発行する。 */
  generateDiffToken(): string;
  /** プレビューの開閉や表示内容の変化があったことを購読側へ知らせる。 */
  onFilePreviewWindowsChanged?(): void;
};

/** 会話ウィンドウ以外のアプリ画面を所有し、用途や参照内容に応じて再利用、起動、閉鎖する。 */
export class AuxWindowService<TWindow extends BaseWindowLike> {
  private homeWindow: TWindow | null = null;
  private sessionMonitorWindow: TWindow | null = null;
  private settingsWindow: TWindow | null = null;
  private readonly diffWindows = new Map<string, TWindow>();
  private readonly filePreviewWindows = new Map<string, TWindow>();
  private readonly filePreviewResourceTokens = new Map<string, string>();
  private readonly filePreviewLoads = new Map<string, Promise<void>>();
  private readonly closedFilePreviewSessionIds = new Set<string>();
  private readonly characterEditorWindows = new Map<string, TWindow>();
  private readonly diffPreviewStore = new Map<string, DiffPreviewPayload>();
  private readonly filePreviewStore = new Map<
    string,
    SessionFilePreviewWindowPayload
  >();

  /** ウィンドウの生成・読み込みと、プレビュー変更通知への接続を保持する。 */
  constructor(private readonly deps: AuxWindowServiceDeps<TWindow>) {}

  /** 管理している主 Home を返す。破棄済みの場合は null。 */
  getHomeWindow(): TWindow | null {
    return this.homeWindow && !this.homeWindow.isDestroyed()
      ? this.homeWindow
      : null;
  }

  /** 指定ウィンドウが現在生きている設定画面と一致するか調べる。 */
  isSettingsWindow(window: TWindow): boolean {
    return this.settingsWindow === window && !window.isDestroyed();
  }

  /** 指定ウィンドウが現在生きている Session Monitor と一致するか調べる。 */
  isSessionMonitorWindow(window: TWindow): boolean {
    return this.sessionMonitorWindow === window && !window.isDestroyed();
  }

  /** Home、Session Monitor、設定のうち現在生きているものを列挙する。 */
  listHomeWindows(): TWindow[] {
    return [
      this.homeWindow,
      this.sessionMonitorWindow,
      this.settingsWindow,
    ].filter((window): window is TWindow => !!window && !window.isDestroyed());
  }

  /** 軽量の実行状態通知を受ける Home と Session Monitor を列挙し、設定画面は含めない。 */
  listLiveSessionRunStatusWindows(): TWindow[] {
    return [this.homeWindow, this.sessionMonitorWindow].filter(
      (window): window is TWindow => !!window && !window.isDestroyed(),
    );
  }

  /** 差分ウィンドウのトークンに紐付く表示内容を返す。対応がなければ null。 */
  getDiffPreview(token: string): DiffPreviewPayload | null {
    return this.diffPreviewStore.get(token) ?? null;
  }

  /** ファイルプレビューのトークンに紐付く現在の表示内容を返す。 */
  getFilePreviewPayload(token: string): SessionFilePreviewWindowPayload | null {
    return this.filePreviewStore.get(token) ?? null;
  }

  /** 開いているプレビューを所有 Session でまとめ、履歴参照では表示パスに版を添える。 */
  listFilePreviewWindows(): Array<{
    ownerSessionId: string;
    previews: SessionFilePreviewWindowSummary[];
  }> {
    const groups = new Map<string, SessionFilePreviewWindowSummary[]>();
    for (const [token, window] of this.filePreviewWindows) {
      const payload = this.filePreviewStore.get(token);
      if (!payload || window.isDestroyed()) continue;
      let previewPath: string;
      if ("historyDiff" in payload) {
        const request = payload.historyDiff.request;
        const revision =
          "comparison" in request
            ? `${request.comparison.baseCommitId} → ${request.comparison.targetCommitId}`
            : request.commitId;
        previewPath = `${payload.displayPath} @ ${revision}`;
      } else {
        const resource = payload.resource;
        previewPath = payload.displayPath;
        if (isSessionFileGitCommitResource(resource)) {
          previewPath = `${payload.displayPath} @ ${resource.commitId}`;
        }
      }
      const previews = groups.get(payload.ownerSessionId) ?? [];
      previews.push({ token, title: payload.windowTitle, path: previewPath });
      groups.set(payload.ownerSessionId, previews);
    }
    return [...groups].map(([ownerSessionId, previews]) => ({
      ownerSessionId,
      previews,
    }));
  }

  /** プレビューのトークンで生きているウィンドウを探し、前面へ戻す。 */
  focusFilePreviewWindow(token: string): void {
    this.reuseWindow(this.filePreviewWindows.get(token) ?? null);
  }

  /** トークンで指定されたプレビューがまだ開いていれば閉鎖する。 */
  closeFilePreviewWindow(token: string): void {
    const window = this.filePreviewWindows.get(token);
    if (window && !window.isDestroyed()) window.close();
  }

  /** 指定 Session が所有するプレビューだけをまとめて閉じる。 */
  closeFilePreviewWindowsForOwner(ownerSessionId: string): void {
    for (const [token, payload] of this.filePreviewStore) {
      if (payload.ownerSessionId === ownerSessionId)
        this.closeFilePreviewWindow(token);
    }
  }

  /** ウィンドウが、指定 Session を表示内容の参照元とするプレビューに一致するか確認する。 */
  isFilePreviewWindow(window: TWindow, sessionId: string): boolean {
    for (const [token, candidate] of this.filePreviewWindows.entries()) {
      const payload = this.filePreviewStore.get(token);
      if (
        candidate === window &&
        !candidate.isDestroyed() &&
        payload &&
        getFilePreviewPayloadSessionId(payload) === sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  /** ウィンドウと参照元 Session が一致する場合だけ表示中の参照を返す。履歴の参照は絶対パス表現へ変換しない。 */
  getFilePreviewWindowResource(
    window: TWindow,
    sessionId: string,
    representation: "source" | "absolute" = "source",
  ): SessionFilePreviewResourceRequest | null {
    for (const [token, candidate] of this.filePreviewWindows.entries()) {
      const payload = this.filePreviewStore.get(token);
      if (
        candidate === window &&
        !candidate.isDestroyed() &&
        payload &&
        getFilePreviewPayloadSessionId(payload) === sessionId
      ) {
        if (representation === "absolute") {
          return !("historyDiff" in payload) &&
            !isSessionFileGitCommitResource(payload.resource)
            ? { sessionId, absolutePath: payload.displayPath }
            : null;
        }
        return getFilePreviewPayloadResource(payload);
      }
    }
    return null;
  }

  /** トークンが同じ生きているプレビューウィンドウに紐付くか照合する。 */
  isFilePreviewTokenWindow(window: TWindow, token: string): boolean {
    const candidate = this.filePreviewWindows.get(token);
    return candidate === window && !candidate.isDestroyed();
  }

  /** Session を閉鎖済みとして記録し、所有元または参照元として関連するプレビューを閉じる。 */
  closeFilePreviewWindowsForSession(sessionId: string): void {
    this.closedFilePreviewSessionIds.add(sessionId);
    for (const [token, window] of [...this.filePreviewWindows.entries()]) {
      const payload = this.filePreviewStore.get(token);
      if (
        payload &&
        (getFilePreviewPayloadSessionId(payload) === sessionId ||
          payload.ownerSessionId === sessionId) &&
        !window.isDestroyed()
      ) {
        window.close();
      }
    }
  }

  /** 現在の Home を再利用し、なければ Home 用の設定で作成してから文書を読み込む。 */
  async openHomeWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.homeWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 0,
      height: 0,
      title: "Home",
      homeBounds: true,
    });
    this.homeWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.homeWindow = null;
    });
    await this.deps.loadHomeEntry(window, "home");
    return window;
  }

  /** 既に作成されたウィンドウを主 Home として引き継ぐ。旧ウィンドウの閉鎖で新しい参照は消さない。 */
  adoptHomeWindow(window: TWindow): TWindow {
    if (this.homeWindow === window) return window;
    this.homeWindow = window;
    window.on("closed", () => {
      if (this.homeWindow === window) this.homeWindow = null;
    });
    return window;
  }

  /** Session Monitor を一つだけ開き、新規・再利用のどちらでも最前面表示を維持する。 */
  async openSessionMonitorWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.sessionMonitorWindow);
    if (existing) {
      existing.setAlwaysOnTop(true, "screen-saver");
      return existing;
    }

    const window = this.deps.createWindow({
      width: 360,
      height: 840,
      minWidth: 300,
      minHeight: 520,
      title: "Session Monitor",
      alwaysOnTop: true,
    });
    this.sessionMonitorWindow = window;
    window.setAlwaysOnTop(true, "screen-saver");
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.sessionMonitorWindow = null;
    });
    await this.deps.loadHomeEntry(window, "monitor");
    return window;
  }

  /** 設定画面を再利用するか、設定モードの renderer を開く。 */
  async openSettingsWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.settingsWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 920,
      height: 960,
      minWidth: 760,
      minHeight: 720,
      title: "Settings",
    });
    this.settingsWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.settingsWindow = null;
    });
    await this.deps.loadHomeEntry(window, "settings");
    return window;
  }

  /** Character ID ごとの編集画面と、新規作成の画面を別のキーで再利用する。 */
  async openCharacterEditorWindow(
    characterId?: string | null,
  ): Promise<TWindow> {
    const normalizedCharacterId = characterId?.trim() ?? "";
    const windowKey = normalizedCharacterId
      ? `character:${normalizedCharacterId}`
      : "character:new";
    const existing = this.reuseWindow(
      this.characterEditorWindows.get(windowKey) ?? null,
    );
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: normalizedCharacterId ? "Character Editor" : "New Character",
    });
    this.characterEditorWindows.set(windowKey, window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.characterEditorWindows.delete(windowKey);
    });
    await this.deps.loadCharacterEditorEntry(
      window,
      normalizedCharacterId || null,
    );
    return window;
  }

  /** 差分の表示内容をトークンで保持して専用ウィンドウを開き、閉鎖後は保持内容を破棄する。 */
  async openDiffWindow(diffPreview: DiffPreviewPayload): Promise<TWindow> {
    const token = this.deps.generateDiffToken();
    const window = this.deps.createWindow({
      ...DIFF_WINDOW_DEFAULT_BOUNDS,
      title: `Diff - ${diffPreview.file.path}`,
    });

    this.diffPreviewStore.set(token, diffPreview);
    this.diffWindows.set(token, window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.diffWindows.delete(token);
      this.diffPreviewStore.delete(token);
    });
    await this.deps.loadDiffEntry(window, token);
    return window;
  }

  /** 同じファイルや履歴のプレビューを再利用する。初回読み込みの完了後にも、所有元・参照元の失効を確認する。 */
  async openFilePreviewWindow(
    payload: SessionFilePreviewWindowPayload,
  ): Promise<{ window: TWindow; disposition: "created" | "focused" }> {
    const payloadSessionId = getFilePreviewPayloadSessionId(payload);
    if (
      this.closedFilePreviewSessionIds.has(payloadSessionId) ||
      this.closedFilePreviewSessionIds.has(payload.ownerSessionId)
    ) {
      throw new Error(
        "The Session is no longer active for file preview navigation.",
      );
    }
    const storedPayload = {
      ...payload,
      windowTitle: resolveSessionFilePreviewWindowTitle(payload.windowTitle),
    };
    const resourceKey =
      "historyDiff" in payload
        ? this.makeHistoryDiffResourceKey(payload.historyDiff.request)
        : this.makeFilePreviewResourceKey(payload.resource);
    const existingToken = this.filePreviewResourceTokens.get(resourceKey);
    const existing = existingToken
      ? this.reuseWindow(this.filePreviewWindows.get(existingToken) ?? null)
      : null;
    if (existing && existingToken) {
      await this.filePreviewLoads.get(existingToken);
      this.assertFilePreviewWindowActive(
        resourceKey,
        existingToken,
        existing,
        storedPayload,
      );
      this.deps.navigateFilePreviewWindow?.(existing, storedPayload);
      this.filePreviewStore.set(existingToken, storedPayload);
      this.deps.onFilePreviewWindowsChanged?.();
      return { window: existing, disposition: "focused" };
    }
    if (existingToken) {
      this.filePreviewResourceTokens.delete(resourceKey);
      this.filePreviewWindows.delete(existingToken);
      this.filePreviewStore.delete(existingToken);
      this.filePreviewLoads.delete(existingToken);
    }

    const token = this.deps.generateDiffToken();
    const window = this.deps.createWindow({
      ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
      title: storedPayload.windowTitle,
    });
    this.filePreviewResourceTokens.set(resourceKey, token);
    this.filePreviewWindows.set(token, window);
    this.filePreviewStore.set(token, storedPayload);
    this.deps.onFilePreviewWindowsChanged?.();
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.filePreviewResourceTokens.delete(resourceKey);
      this.filePreviewWindows.delete(token);
      this.filePreviewStore.delete(token);
      this.filePreviewLoads.delete(token);
      this.deps.onFilePreviewWindowsChanged?.();
    });
    const load = this.deps.loadFilePreviewEntry(window, token);
    this.filePreviewLoads.set(token, load);
    try {
      await load;
      this.assertFilePreviewWindowActive(resourceKey, token, window, payload);
      return { window, disposition: "created" };
    } catch (error) {
      if (!window.isDestroyed()) {
        window.close();
      }
      throw error;
    }
  }

  /** リセットの対象となる差分、プレビューと Character 編集画面を閉じ、関連する登録を消去する。 */
  closeResetTargetWindows(): void {
    for (const [token, window] of this.diffWindows.entries()) {
      if (!window.isDestroyed()) {
        window.close();
      }
      this.diffPreviewStore.delete(token);
    }
    this.diffWindows.clear();
    for (const window of this.filePreviewWindows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.filePreviewWindows.clear();
    this.filePreviewResourceTokens.clear();
    this.filePreviewStore.clear();
    this.filePreviewLoads.clear();
    for (const window of this.characterEditorWindows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.characterEditorWindows.clear();
  }

  /** 生きている既存ウィンドウなら最小化を解除してフォーカスを戻す。再利用できなければ null。 */
  private reuseWindow(window: TWindow | null): TWindow | null {
    if (!window || window.isDestroyed()) {
      return null;
    }

    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
    return window;
  }

  /** 読み込み待ちの間に Session が閉じられたり、資材・トークン・ウィンドウの紐付けが解除されたりしていないか確認する。 */
  private assertFilePreviewWindowActive(
    resourceKey: string,
    token: string,
    window: TWindow,
    requestedPayload: SessionFilePreviewWindowPayload,
  ): void {
    const storedPayload = this.filePreviewStore.get(token);
    if (
      this.closedFilePreviewSessionIds.has(
        getFilePreviewPayloadSessionId(requestedPayload),
      ) ||
      this.closedFilePreviewSessionIds.has(requestedPayload.ownerSessionId) ||
      !storedPayload ||
      this.closedFilePreviewSessionIds.has(
        getFilePreviewPayloadSessionId(storedPayload),
      ) ||
      this.closedFilePreviewSessionIds.has(storedPayload.ownerSessionId) ||
      window.isDestroyed() ||
      this.filePreviewResourceTokens.get(resourceKey) !== token ||
      this.filePreviewWindows.get(token) !== window
    ) {
      throw new Error(
        "The Session is no longer active for file preview navigation.",
      );
    }
  }

  /** Session と参照の種類・パス・版から再利用キーを作る。絶対パスは別の実ファイルと混同しないよう元の文字列を使う。 */
  private makeFilePreviewResourceKey(
    resource: SessionFilePreviewResourceRequest,
  ): string {
    if (isSessionFileAbsoluteResource(resource)) {
      return JSON.stringify([
        resource.sessionId,
        "absolute-file",
        resource.absolutePath,
      ]);
    }
    if (isSessionFileGitCommitResource(resource)) {
      return JSON.stringify([
        resource.sessionId,
        "git-commit-file",
        resource.rootId,
        resource.repositoryId,
        resource.commitId,
        resource.relativePath.replaceAll("\\", "/"),
      ]);
    }
    return JSON.stringify([
      resource.sessionId,
      resource.rootId,
      resource.relativePath.replaceAll("\\", "/"),
    ]);
  }

  /** 履歴差分の再利用キーにリポジトリと比較端点、指定時はファイルパスを含める。 */
  private makeHistoryDiffResourceKey(
    request: FileRootGitHistoryDiffRequest,
  ): string {
    return JSON.stringify([
      request.sessionId,
      "git-history-diff",
      request.rootId,
      request.repositoryId,
      "comparison" in request
        ? request.comparison
        : { commitId: request.commitId },
      request.relativePath?.replaceAll("\\", "/") ?? null,
    ]);
  }
}
