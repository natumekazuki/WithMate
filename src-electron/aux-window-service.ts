import type { DiffPreviewPayload } from "../src/session-state.js";
import type { ChatEntryMode, HomeEntryMode, WindowLike } from "./window-entry-loader.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  COMPANION_CHAT_WINDOW_DEFAULT_BOUNDS,
  COMPANION_REVIEW_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
} from "./window-defaults.js";

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
  loadDiffEntry(window: TWindow, token: string): Promise<void>;
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  loadCompanionMergeReviewEntry(window: TWindow, sessionId: string): Promise<void>;
  loadCharacterEditorEntry(window: TWindow, characterId?: string | null): Promise<void>;
  generateDiffToken(): string;
  onCompanionReviewWindowsChanged(): void;
};

export class AuxWindowService<TWindow extends BaseWindowLike> {
  private homeWindow: TWindow | null = null;
  private sessionMonitorWindow: TWindow | null = null;
  private settingsWindow: TWindow | null = null;
  private readonly diffWindows = new Map<string, TWindow>();
  private readonly companionReviewWindows = new Map<string, TWindow>();
  private readonly companionMergeWindows = new Map<string, TWindow>();
  private readonly characterEditorWindows = new Map<string, TWindow>();
  private readonly diffPreviewStore = new Map<string, DiffPreviewPayload>();

  constructor(private readonly deps: AuxWindowServiceDeps<TWindow>) {}

  getHomeWindow(): TWindow | null {
    return this.homeWindow && !this.homeWindow.isDestroyed() ? this.homeWindow : null;
  }

  listHomeWindows(): TWindow[] {
    return [
      this.homeWindow,
      this.sessionMonitorWindow,
      this.settingsWindow,
    ].filter((window): window is TWindow => !!window && !window.isDestroyed());
  }

  getDiffPreview(token: string): DiffPreviewPayload | null {
    return this.diffPreviewStore.get(token) ?? null;
  }

  listOpenCompanionReviewWindowIds(): string[] {
    const sessionIds: string[] = [];
    for (const [sessionId, window] of this.companionReviewWindows.entries()) {
      if (!window.isDestroyed()) {
        sessionIds.push(sessionId);
      }
    }
    return sessionIds;
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

  async openCharacterEditorWindow(characterId?: string | null): Promise<TWindow> {
    const normalizedCharacterId = characterId?.trim() ?? "";
    const windowKey = normalizedCharacterId ? `character:${normalizedCharacterId}` : "character:new";
    const existing = this.reuseWindow(this.characterEditorWindows.get(windowKey) ?? null);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: normalizedCharacterId ? "WithMate Character Editor" : "WithMate New Character",
    });
    this.characterEditorWindows.set(windowKey, window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.characterEditorWindows.delete(windowKey);
    });
    await this.deps.loadCharacterEditorEntry(window, normalizedCharacterId || null);
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

  async openCompanionReviewWindow(sessionId: string): Promise<TWindow> {
    const existing = this.reuseWindow(this.companionReviewWindows.get(sessionId) ?? null);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      ...COMPANION_CHAT_WINDOW_DEFAULT_BOUNDS,
      title: `Companion - ${sessionId}`,
    });
    this.companionReviewWindows.set(sessionId, window);
    this.deps.onCompanionReviewWindowsChanged();
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.companionReviewWindows.delete(sessionId);
      this.deps.onCompanionReviewWindowsChanged();
    });
    await this.deps.loadChatEntry(window, { kind: "companion", sessionId });
    return window;
  }

  async openCompanionMergeWindow(sessionId: string): Promise<TWindow> {
    const existing = this.reuseWindow(this.companionMergeWindows.get(sessionId) ?? null);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      ...COMPANION_REVIEW_WINDOW_DEFAULT_BOUNDS,
      title: `Companion Merge - ${sessionId}`,
    });
    this.companionMergeWindows.set(sessionId, window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.companionMergeWindows.delete(sessionId);
    });
    await this.deps.loadCompanionMergeReviewEntry(window, sessionId);
    return window;
  }

  closeResetTargetWindows(): void {
    for (const [token, window] of this.diffWindows.entries()) {
      if (!window.isDestroyed()) {
        window.close();
      }
      this.diffPreviewStore.delete(token);
    }
    this.diffWindows.clear();
    for (const window of this.companionReviewWindows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.companionReviewWindows.clear();
    for (const window of this.companionMergeWindows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.companionMergeWindows.clear();
    for (const window of this.characterEditorWindows.values()) {
      if (!window.isDestroyed()) {
        window.close();
      }
    }
    this.characterEditorWindows.clear();
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
