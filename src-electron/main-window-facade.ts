import type { BrowserWindow } from "electron";

import type { DiffPreviewPayload } from "../src/session-state.js";
import type {
  SessionFilePreviewWindowPayload,
  SessionFileResourceRequest,
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

  async openCoordinationWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCoordinationWindow();
  }

  isCoordinationWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isCoordinationWindow(window);
  }

  isMemoryV6ReviewWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isMemoryV6ReviewWindow(window);
  }

  isSettingsWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isSettingsWindow(window);
  }

  async openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCharacterEditorWindow(characterId);
  }

  async openSessionWindow(sessionId: string): Promise<BrowserWindow> {
    return this.deps.getSessionWindowBridge().openSessionWindow(sessionId);
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
  ): SessionFileResourceRequest | null {
    return this.deps.getAuxWindowService().getFilePreviewWindowResource(window, sessionId);
  }

  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean {
    return this.deps.getAuxWindowService().isFilePreviewTokenWindow(window, token);
  }

  closeFilePreviewWindowsForSession(sessionId: string): void {
    this.deps.getAuxWindowService().closeFilePreviewWindowsForSession(sessionId);
  }

  async openCompanionReviewWindow(sessionId: string): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCompanionReviewWindow(sessionId);
  }

  async openCompanionMergeWindow(sessionId: string): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCompanionMergeWindow(sessionId);
  }

  listOpenSessionWindowIds(): string[] {
    return this.deps.getSessionWindowBridge().listOpenSessionWindowIds();
  }

  listOpenCompanionReviewWindowIds(): string[] {
    return this.deps.getAuxWindowService().listOpenCompanionReviewWindowIds();
  }

  getCompanionReviewWindow(sessionId: string): BrowserWindow | null {
    return this.deps.getAuxWindowService().getCompanionReviewWindow(sessionId);
  }

  closeResetTargetWindows(): void {
    this.deps.getSessionWindowBridge().closeAllSessionWindows();
    this.deps.getAuxWindowService().closeResetTargetWindows();
  }
}
