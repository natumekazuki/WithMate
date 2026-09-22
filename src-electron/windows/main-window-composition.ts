import { screen, BrowserWindow } from "electron";
import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import { WITHMATE_APP_BOOT_STATUS_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { resolveCursorAnchoredPosition } from "./window-placement.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";

type WindowOptions = ConstructorParameters<typeof BrowserWindow>[0];

export class MainWindowComposition {
  private bootWindow: BrowserWindow | null = null;
  public constructor(
    private readonly preloadPath: string,
    private readonly attachLogHandlers: (window: BrowserWindow) => void,
    private readonly loadBootEntry: (window: BrowserWindow) => Promise<void>,
  ) {}

  public createBaseWindow(options: WindowOptions): BrowserWindow {
    const window = new BrowserWindow({
      backgroundColor: "#0e131b", autoHideMenuBar: true, show: false,
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
      ...options,
    });
    this.attachLogHandlers(window);
    return window;
  }

  public createCursorPlacedWindow(options: WindowOptions & { width: number; height: number }): BrowserWindow {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { x, y } = resolveCursorAnchoredPosition({ cursor, workArea: display.workArea, width: options.width, height: options.height });
    return this.createBaseWindow({ ...options, x, y });
  }

  public publishBootStatus(status: AppBootStatus): void {
    if (this.bootWindow && !this.bootWindow.isDestroyed()) {
      this.bootWindow.webContents.send(WITHMATE_APP_BOOT_STATUS_EVENT, status);
    }
  }

  public async openBootWindow(getStatus: () => AppBootStatus): Promise<BrowserWindow> {
    if (this.bootWindow && !this.bootWindow.isDestroyed()) return this.bootWindow;
    const window = this.createBaseWindow({ ...HOME_WINDOW_DEFAULT_BOUNDS, title: "Starting WithMate" });
    this.bootWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => { if (this.bootWindow === window) this.bootWindow = null; });
    await this.loadBootEntry(window);
    this.publishBootStatus(getStatus());
    return window;
  }

  public getBootWindow(): BrowserWindow | null {
    return this.bootWindow && !this.bootWindow.isDestroyed() ? this.bootWindow : null;
  }

  public releaseBootWindow(window: BrowserWindow): void {
    if (this.bootWindow === window) this.bootWindow = null;
  }

  public async reloadBootWindow(window: BrowserWindow): Promise<void> {
    await this.loadBootEntry(window);
  }

  public closeBootWindow(): void {
    if (!this.bootWindow || this.bootWindow.isDestroyed()) { this.bootWindow = null; return; }
    const window = this.bootWindow;
    this.bootWindow = null;
    window.close();
  }
}
