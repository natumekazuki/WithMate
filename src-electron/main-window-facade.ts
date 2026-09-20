import type { BrowserWindow } from "electron";

import type { DiffPreviewPayload } from "../src/session-state.js";
import type {
  SessionFilePreviewWindowPayload,
  SessionFilePreviewResourceRequest,
} from "../src/file-explorer/file-explorer-contract.js";
import type { AuxWindowService } from "./aux-window-service.js";
import type { SessionWindowBridge } from "./session-window-bridge.js";

type MainWindowFacadeDeps = {
  getAuxWindowService(): AuxWindowService<BrowserWindow>;
  getSessionWindowBridge(): SessionWindowBridge<BrowserWindow>;
};

export class MainWindowFacade {
  constructor(private readonly deps: MainWindowFacadeDeps) {}

  async openHomeWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openHomeWindow();
  }

  async openSessionMonitorWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openSessionMonitorWindow();
  }

  async openSettingsWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openSettingsWindow();
  }

  async openMemoryV6ReviewWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openMemoryV6ReviewWindow();
  }

  isMemoryV6ReviewWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isMemoryV6ReviewWindow(window);
  }

  isSettingsWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isSettingsWindow(window);
  }

  isSessionMonitorWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isSessionMonitorWindow(window);
  }

  async openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCharacterEditorWindow(characterId);
  }

  async openSessionWindow(sessionId: string, auxiliarySessionId?: string): Promise<BrowserWindow> {
    return this.deps.getSessionWindowBridge().openSessionWindow(sessionId, { auxiliarySessionId });
  }

  closeSessionWindow(sessionId: string): void {
    this.deps.getSessionWindowBridge().closeSessionWindow(sessionId);
  }

  requestCloseSessionWindow(sessionId: string): Promise<boolean> {
    return this.deps.getSessionWindowBridge().requestCloseSessionWindow(sessionId);
  }

  async openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openDiffWindow(diffPreview);
  }

  async openFilePreviewWindow(
    payload: SessionFilePreviewWindowPayload,
  ): Promise<{ window: BrowserWindow; disposition: "created" | "focused" }> {
    return this.deps.getAuxWindowService().openFilePreviewWindow(payload);
  }

  getFilePreviewPayload(token: string): SessionFilePreviewWindowPayload | null {
    return this.deps.getAuxWindowService().getFilePreviewPayload(token);
  }

  isFilePreviewWindow(window: BrowserWindow, sessionId: string): boolean {
    return this.deps.getAuxWindowService().isFilePreviewWindow(window, sessionId);
  }

  getFilePreviewWindowResource(
    window: BrowserWindow,
    sessionId: string,
  ): SessionFilePreviewResourceRequest | null {
    return this.deps.getAuxWindowService().getFilePreviewWindowResource(window, sessionId);
  }

  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean {
    return this.deps.getAuxWindowService().isFilePreviewTokenWindow(window, token);
  }

  closeFilePreviewWindowsForSession(sessionId: string): void {
    this.deps.getAuxWindowService().closeFilePreviewWindowsForSession(sessionId);
  }

  listOpenSessionWindowIds(): string[] {
    return this.deps.getSessionWindowBridge().listOpenSessionWindowIds();
  }

  closeResetTargetWindows(): void {
    this.deps.getSessionWindowBridge().closeAllSessionWindows();
    this.deps.getAuxWindowService().closeResetTargetWindows();
  }
}
