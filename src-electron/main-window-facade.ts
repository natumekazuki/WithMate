import type { BrowserWindow } from "electron";

import type { DiffPreviewPayload } from "../src/session-state.js";
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

  async openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCharacterEditorWindow(characterId);
  }

  async openSessionWindow(sessionId: string): Promise<BrowserWindow> {
    return this.deps.getSessionWindowBridge().openSessionWindow(sessionId);
  }

  async openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openDiffWindow(diffPreview);
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

  closeResetTargetWindows(): void {
    this.deps.getSessionWindowBridge().closeAllSessionWindows();
    this.deps.getAuxWindowService().closeResetTargetWindows();
  }
}
