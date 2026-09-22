import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import type {
  FileRootGitHistoryDiffRequest,
  SessionFilePreviewWindowPayload,
  SessionFilePreviewResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileAbsoluteResource,
  isSessionFileGitCommitResource,
  resolveSessionFilePreviewWindowTitle,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { ChatEntryMode, HomeEntryMode, WindowLike } from "../windows/window-entry-loader.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
  FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
} from "../windows/window-defaults.js";

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

function getFilePreviewPayloadSessionId(payload: SessionFilePreviewWindowPayload): string {
  return "historyDiff" in payload
    ? payload.historyDiff.request.sessionId
    : payload.resource.sessionId;
}

function getFilePreviewPayloadResource(
  payload: SessionFilePreviewWindowPayload,
): SessionFilePreviewResourceRequest | null {
  if ("historyDiff" in payload) {
    return payload.historyDiff.previewResource
      ?? payload.historyDiff.previewAfterResource
      ?? payload.historyDiff.previewBeforeResource;
  }
  return payload.resource;
}

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
  loadFilePreviewEntry(window: TWindow, token: string): Promise<void>;
  navigateFilePreviewWindow?(
    window: TWindow,
    payload: SessionFilePreviewWindowPayload,
  ): void;
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  loadCharacterEditorEntry(window: TWindow, characterId?: string | null): Promise<void>;
  generateDiffToken(): string;
};

export class AuxWindowService<TWindow extends BaseWindowLike> {
  private homeWindow: TWindow | null = null;
  private sessionMonitorWindow: TWindow | null = null;
  private settingsWindow: TWindow | null = null;
  private memoryV6ReviewWindow: TWindow | null = null;
  private readonly diffWindows = new Map<string, TWindow>();
  private readonly filePreviewWindows = new Map<string, TWindow>();
  private readonly filePreviewResourceTokens = new Map<string, string>();
  private readonly filePreviewLoads = new Map<string, Promise<void>>();
  private readonly closedFilePreviewSessionIds = new Set<string>();
  private readonly characterEditorWindows = new Map<string, TWindow>();
  private readonly diffPreviewStore = new Map<string, DiffPreviewPayload>();
  private readonly filePreviewStore = new Map<string, SessionFilePreviewWindowPayload>();

  constructor(private readonly deps: AuxWindowServiceDeps<TWindow>) {}

  getHomeWindow(): TWindow | null {
    return this.homeWindow && !this.homeWindow.isDestroyed() ? this.homeWindow : null;
  }

  isMemoryV6ReviewWindow(window: TWindow): boolean {
    return this.memoryV6ReviewWindow === window && !window.isDestroyed();
  }

  isSettingsWindow(window: TWindow): boolean {
    return this.settingsWindow === window && !window.isDestroyed();
  }

  isSessionMonitorWindow(window: TWindow): boolean {
    return this.sessionMonitorWindow === window && !window.isDestroyed();
  }

  listHomeWindows(): TWindow[] {
    return [
      this.homeWindow,
      this.sessionMonitorWindow,
      this.settingsWindow,
      this.memoryV6ReviewWindow,
    ].filter((window): window is TWindow => !!window && !window.isDestroyed());
  }

  getDiffPreview(token: string): DiffPreviewPayload | null {
    return this.diffPreviewStore.get(token) ?? null;
  }

  getFilePreviewPayload(token: string): SessionFilePreviewWindowPayload | null {
    return this.filePreviewStore.get(token) ?? null;
  }

  isFilePreviewWindow(window: TWindow, sessionId: string): boolean {
    for (const [token, candidate] of this.filePreviewWindows.entries()) {
      const payload = this.filePreviewStore.get(token);
      if (
        candidate === window
        && !candidate.isDestroyed()
        && payload
        && getFilePreviewPayloadSessionId(payload) === sessionId
      ) {
        return true;
      }
    }
    return false;
  }

  getFilePreviewWindowResource(
    window: TWindow,
    sessionId: string,
  ): SessionFilePreviewResourceRequest | null {
    for (const [token, candidate] of this.filePreviewWindows.entries()) {
      const payload = this.filePreviewStore.get(token);
      if (
        candidate === window
        && !candidate.isDestroyed()
        && payload
        && getFilePreviewPayloadSessionId(payload) === sessionId
      ) {
        return getFilePreviewPayloadResource(payload);
      }
    }
    return null;
  }

  isFilePreviewTokenWindow(window: TWindow, token: string): boolean {
    const candidate = this.filePreviewWindows.get(token);
    return candidate === window && !candidate.isDestroyed();
  }

  closeFilePreviewWindowsForSession(sessionId: string): void {
    this.closedFilePreviewSessionIds.add(sessionId);
    for (const [token, window] of [...this.filePreviewWindows.entries()]) {
      const payload = this.filePreviewStore.get(token);
      if (
        payload
        && (getFilePreviewPayloadSessionId(payload) === sessionId || payload.ownerSessionId === sessionId)
        && !window.isDestroyed()
      ) {
        window.close();
      }
    }
  }

  async openHomeWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.homeWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 0,
      height: 0,
      title: "WithMateHome",
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
      title: "WithMateMonitor",
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
      title: "WithMateSettings",
    });
    this.settingsWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.settingsWindow = null;
    });
    await this.deps.loadHomeEntry(window, "settings");
    return window;
  }

  async openMemoryV6ReviewWindow(): Promise<TWindow> {
    const existing = this.reuseWindow(this.memoryV6ReviewWindow);
    if (existing) {
      return existing;
    }

    const window = this.deps.createWindow({
      width: 1120,
      height: 880,
      minWidth: 860,
      minHeight: 680,
      title: "WithMateMemoryReview",
    });
    this.memoryV6ReviewWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.memoryV6ReviewWindow = null;
    });
    await this.deps.loadHomeEntry(window, "memory-review");
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
      title: normalizedCharacterId ? "WithMateCharacterEditor" : "WithMateNewCharacter",
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

  async openFilePreviewWindow(
    payload: SessionFilePreviewWindowPayload,
  ): Promise<{ window: TWindow; disposition: "created" | "focused" }> {
    const payloadSessionId = getFilePreviewPayloadSessionId(payload);
    if (
      this.closedFilePreviewSessionIds.has(payloadSessionId)
      || this.closedFilePreviewSessionIds.has(payload.ownerSessionId)
    ) {
      throw new Error("The Session is no longer active for file preview navigation.");
    }
    const storedPayload = {
      ...payload,
      windowTitle: resolveSessionFilePreviewWindowTitle(payload.windowTitle),
    };
    const resourceKey = "historyDiff" in payload
      ? this.makeHistoryDiffResourceKey(payload.historyDiff.request)
      : this.makeFilePreviewResourceKey(payload.resource);
    const existingToken = this.filePreviewResourceTokens.get(resourceKey);
    const existing = existingToken ? this.reuseWindow(this.filePreviewWindows.get(existingToken) ?? null) : null;
    if (existing && existingToken) {
      await this.filePreviewLoads.get(existingToken);
      this.assertFilePreviewWindowActive(resourceKey, existingToken, existing, storedPayload);
      this.deps.navigateFilePreviewWindow?.(existing, storedPayload);
      this.filePreviewStore.set(existingToken, storedPayload);
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
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      this.filePreviewResourceTokens.delete(resourceKey);
      this.filePreviewWindows.delete(token);
      this.filePreviewStore.delete(token);
      this.filePreviewLoads.delete(token);
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

  closeResetTargetWindows(): void {
    if (this.memoryV6ReviewWindow && !this.memoryV6ReviewWindow.isDestroyed()) {
      this.memoryV6ReviewWindow.close();
    }
    this.memoryV6ReviewWindow = null;

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

  private assertFilePreviewWindowActive(
    resourceKey: string,
    token: string,
    window: TWindow,
    requestedPayload: SessionFilePreviewWindowPayload,
  ): void {
    const storedPayload = this.filePreviewStore.get(token);
    if (
      this.closedFilePreviewSessionIds.has(getFilePreviewPayloadSessionId(requestedPayload))
      || this.closedFilePreviewSessionIds.has(requestedPayload.ownerSessionId)
      || !storedPayload
      || this.closedFilePreviewSessionIds.has(getFilePreviewPayloadSessionId(storedPayload))
      || this.closedFilePreviewSessionIds.has(storedPayload.ownerSessionId)
      || window.isDestroyed()
      || this.filePreviewResourceTokens.get(resourceKey) !== token
      || this.filePreviewWindows.get(token) !== window
    ) {
      throw new Error("The Session is no longer active for file preview navigation.");
    }
  }

  private makeFilePreviewResourceKey(resource: SessionFilePreviewResourceRequest): string {
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

  private makeHistoryDiffResourceKey(request: FileRootGitHistoryDiffRequest): string {
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
