import { screen, BrowserWindow } from "electron";
import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import { WITHMATE_APP_BOOT_STATUS_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { resolveCursorAnchoredPosition } from "./window-placement.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";
import { configureHtmlPreviewHost } from "../files/html-preview-service.js";

/** 共通ウィンドウ設定に重ねる Electron の生成オプション。 */
type WindowOptions = ConstructorParameters<typeof BrowserWindow>[0];

/** アプリ共通の BrowserWindow を生成し、起動画面の参照と進捗通知を管理する。 */
export class MainWindowComposition {
  private bootWindow: BrowserWindow | null = null;
  /** 共通の preload、ウィンドウ診断の接続、起動画面の読み込み方法を受け取る。 */
  public constructor(
    private readonly preloadPath: string,
    private readonly attachLogHandlers: (window: BrowserWindow) => void,
    private readonly loadBootEntry: (window: BrowserWindow) => Promise<void>,
  ) {}

  /** 非表示での生成を既定にし、個別オプションを重ねてからプレビューと診断のハンドラーを接続する。 */
  public createBaseWindow(options: WindowOptions): BrowserWindow {
    const window = new BrowserWindow({
      backgroundColor: "#0e131b",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: false,
        webviewTag: true,
      },
      ...options,
    });
    configureHtmlPreviewHost(window.webContents);
    this.attachLogHandlers(window);
    return window;
  }

  /** カーソルに最も近いディスプレイの作業領域を使い、指定サイズのウィンドウの位置を決める。 */
  public createCursorPlacedWindow(
    options: WindowOptions & { width: number; height: number },
  ): BrowserWindow {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y } = resolveCursorAnchoredPosition({
      cursor,
      workArea: display.workArea,
      width: options.width,
      height: options.height,
    });
    return this.createBaseWindow({ ...options, x, y });
  }

  /** 起動画面が稼働中の場合だけ、初期化の進捗を renderer に通知する。 */
  public publishBootStatus(status: AppBootStatus): void {
    if (this.bootWindow && !this.bootWindow.isDestroyed()) {
      this.bootWindow.webContents.send(WITHMATE_APP_BOOT_STATUS_EVENT, status);
    }
  }

  /** 既存の起動画面を再利用する。新規作成時は文書の読み込みが済んでから現在の進捗を送る。 */
  public async openBootWindow(
    getStatus: () => AppBootStatus,
  ): Promise<BrowserWindow> {
    if (this.bootWindow && !this.bootWindow.isDestroyed())
      return this.bootWindow;
    const window = this.createBaseWindow({
      ...HOME_WINDOW_DEFAULT_BOUNDS,
      title: "Starting WithMate",
    });
    this.bootWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (this.bootWindow === window) this.bootWindow = null;
    });
    await this.loadBootEntry(window);
    this.publishBootStatus(getStatus());
    return window;
  }

  /** 起動画面が存在し、まだ破棄されていない場合だけ返す。 */
  public getBootWindow(): BrowserWindow | null {
    return this.bootWindow && !this.bootWindow.isDestroyed()
      ? this.bootWindow
      : null;
  }

  /** 指定ウィンドウが現在の起動画面と一致すれば、閉じずに管理対象から外す。 */
  public releaseBootWindow(window: BrowserWindow): void {
    if (this.bootWindow === window) this.bootWindow = null;
  }

  /** 起動画面の参照を先に手放し、まだ存在する場合だけ閉鎖を要求する。 */
  public closeBootWindow(): void {
    if (!this.bootWindow || this.bootWindow.isDestroyed()) {
      this.bootWindow = null;
      return;
    }
    const window = this.bootWindow;
    this.bootWindow = null;
    window.close();
  }
}
