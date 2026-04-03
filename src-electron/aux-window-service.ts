import type { DiffPreviewPayload } from "../src/session-state.js";
import type { HomeEntryMode, WindowLike } from "./window-entry-loader.js";
import { DIFF_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";

type BaseWindowLike = WindowLike & {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  show(): void;
  close(): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  once(event: "ready-to-show", listener: () => void): void;
  on(event: "closed", listener: () => void): void;
};

export type AuxWindowServiceDeps<TWindow extends BaseWindowLike> = {
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
  loadHomeEntry(window: TWindow, mode: HomeEntryMode): Promise<void>;
  loadCharacterEntry(window: TWindow, characterId?: string | null): Promise<void>;
  loadDiffEntry(window: TWindow, token: string): Promise<void>;
  generateDiffToken(): string;
};

export class AuxWindowService<TWindow extends BaseWindowLike> {
  private homeWindow: TWindow | null = null;
  private sessionMonitorWindow: TWindow | null = null;
  private settingsWindow: TWindow | null = null;
  private memoryManagementWindow: TWindow | null = null;
  private readonly characterEditorWindows = new Map<string, TWindow>();
  private readonly diffWindows = new Map<string, TWindow>();
  private readonly diffPreviewStore = new Map<string, DiffPreviewPayload>();

  constructor(private readonly deps: AuxWindowServiceDeps<TWindow>) {}

  getHomeWindow(): TWindow | null {
    return this.homeWindow && !this.homeWindow.isDestroyed() ? this.homeWindow : null;
  }

  getDiffPreview(token: string): DiffPreviewPayload | null {
    return this.diffPreviewStore.get(token) ?? null;
  }

  async openHomeWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.homeWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 0,
      height: 0,
      title: "WithMate Home",
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
      maxWidth: 460,
      title: "WithMate Monitor",
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
      title: "WithMate Settings",
    });
    this.settingsWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.settingsWindow = null;
    });
    await this.deps.loadHomeEntry(window, "settings");
    return window;
  }

  async openMemoryManagementWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.memoryManagementWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 1180,
      height: 960,
      minWidth: 900,
      minHeight: 720,
      title: "WithMate Memory",
    });
    this.memoryManagementWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.memoryManagementWindow = null;
    });
    await this.deps.loadHomeEntry(window, "memory");
    return window;
  }

  async openCharacterEditorWindow(characterId?: string | null): Promise<TWindow> {
    const key = characterId ?? "__new__";
    const existing = this.reuseWindow(this.characterEditorWindows.get(key) ?? null);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 980,
      height: 840,
      minWidth: 760,
      minHeight: 680,
      title: characterId ? `Character Editor - ${characterId}` : "Character Editor - New",
    });
    this.characterEditorWindows.set(key, window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.characterEditorWindows.delete(key);
    });
    await this.deps.loadCharacterEntry(window, characterId ?? null);
    return window;
  }

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

  closeCharacterEditor(characterId: string): void {
    const window = this.characterEditorWindows.get(characterId);
    if (!window || window.isDestroyed()) {
      this.characterEditorWindows.delete(characterId);
      return;
    }
    window.close();
  }

  closeResetTargetWindows(): void {
    for (const [token, window] of this.diffWindows.entries()) {
      if (!window.isDestroyed()) {
        window.close();
      }
      this.diffPreviewStore.delete(token);
    }
    this.diffWindows.clear();
  }

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
}
