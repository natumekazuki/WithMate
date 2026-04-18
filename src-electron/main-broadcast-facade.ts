import type { AppSettings } from "../src/provider-settings-state.js";
import type { CharacterProfile, SessionSummary } from "../src/app-state.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { WindowBroadcastService } from "./window-broadcast-service.js";

type BroadcastWindowLike = {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
};

type MainBroadcastFacadeDeps<TWindow extends BroadcastWindowLike> = {
  getWindowBroadcastService(): WindowBroadcastService<TWindow>;
  listSessionSummaries(): SessionSummary[];
  listCharacters(): CharacterProfile[];
  getModelCatalog(): ModelCatalogSnapshot | null;
  getAppSettings(): AppSettings;
  listOpenSessionWindowIds(): string[];
};

export class MainBroadcastFacade<TWindow extends BroadcastWindowLike> {
  constructor(private readonly deps: MainBroadcastFacadeDeps<TWindow>) {}

  broadcastSessions(sessionIds?: Iterable<string>): void {
    const summaries = this.deps.listSessionSummaries();
    const invalidatedSessionIds = Array.from(new Set(sessionIds ?? summaries.map((session) => session.id)));
    const windowBroadcastService = this.deps.getWindowBroadcastService();
    windowBroadcastService.broadcastSessionSummaries(summaries);
    windowBroadcastService.broadcastSessionInvalidation(invalidatedSessionIds);
  }

  broadcastCharacters(): void {
    this.deps.getWindowBroadcastService().broadcastCharacters(this.deps.listCharacters());
  }

  broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void {
    const payload = snapshot ?? this.deps.getModelCatalog();
    if (!payload) {
      return;
    }

    this.deps.getWindowBroadcastService().broadcastModelCatalog(payload);
  }

  broadcastAppSettings(settings?: AppSettings): void {
    const payload = settings ?? this.deps.getAppSettings();
    this.deps.getWindowBroadcastService().broadcastAppSettings(payload);
  }

  broadcastOpenSessionWindowIds(): void {
    this.deps
      .getWindowBroadcastService()
      .broadcastOpenSessionWindowIds(this.deps.listOpenSessionWindowIds());
  }
}
