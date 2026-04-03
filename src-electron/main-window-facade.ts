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

  async openMemoryManagementWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openMemoryManagementWindow();
  }

  async openSessionWindow(sessionId: string): Promise<BrowserWindow> {
    return this.deps.getSessionWindowBridge().openSessionWindow(sessionId);
  }

  async openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openCharacterEditorWindow(characterId);
  }

  async openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openDiffWindow(diffPreview);
  }

  listOpenSessionWindowIds(): string[] {
    return this.deps.getSessionWindowBridge().listOpenSessionWindowIds();
  }

  closeResetTargetWindows(): void {
    this.deps.getSessionWindowBridge().closeAllSessionWindows();
    this.deps.getAuxWindowService().closeResetTargetWindows();
  }
}
