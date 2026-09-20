import type { AppSettings } from "../src/provider-settings-state.js";
import type { SessionSummaryInvalidation } from "../src/app-state.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { PromptTemplate } from "../src/prompt-template.js";
import type { WindowBroadcastService } from "./window-broadcast-service.js";
import { SESSION_SUMMARY_ID_MAX_LENGTH, SESSION_SUMMARY_INVALIDATION_ID_MAX } from "./session-summary-query.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type BroadcastWindowLike = {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
};

type MainBroadcastFacadeDeps<TWindow extends BroadcastWindowLike> = {
  getWindowBroadcastService(): WindowBroadcastService<TWindow>;
  getModelCatalog(): Awaitable<ModelCatalogSnapshot | null>;
  getAppSettings(): Awaitable<AppSettings>;
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  listOpenSessionWindowIds(): string[];
};

export class MainBroadcastFacade<TWindow extends BroadcastWindowLike> {
  constructor(private readonly deps: MainBroadcastFacadeDeps<TWindow>) {}

  broadcastSessions(sessionIds?: Iterable<string>): void {
    const invalidatedSessionIds = sessionIds === undefined
      ? []
      : Array.from(new Set(Array.from(sessionIds).map((sessionId) => sessionId.trim()).filter(Boolean)));
    const invalidation: SessionSummaryInvalidation = sessionIds === undefined
      || invalidatedSessionIds.length === 0
      || invalidatedSessionIds.length > SESSION_SUMMARY_INVALIDATION_ID_MAX
      || invalidatedSessionIds.some((sessionId) => sessionId.length > SESSION_SUMMARY_ID_MAX_LENGTH)
      ? { scope: "all" }
      : { scope: "ids", sessionIds: invalidatedSessionIds };
    const windowBroadcastService = this.deps.getWindowBroadcastService();
    windowBroadcastService.broadcastSessionInvalidation(invalidation);
  }

  async broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): Promise<void> {
    const payload = snapshot ?? await this.deps.getModelCatalog();
    if (!payload) {
      return;
    }

    this.deps.getWindowBroadcastService().broadcastModelCatalog(payload);
  }

  async broadcastAppSettings(settings?: AppSettings): Promise<void> {
    const payload = settings ?? await this.deps.getAppSettings();
    this.deps.getWindowBroadcastService().broadcastAppSettings(payload);
  }

  async broadcastPromptTemplates(templates?: PromptTemplate[]): Promise<void> {
    const payload = templates ?? await this.deps.listPromptTemplates();
    this.deps.getWindowBroadcastService().broadcastPromptTemplates(payload);
  }

  broadcastOpenSessionWindowIds(): void {
    this.deps
      .getWindowBroadcastService()
      .broadcastOpenSessionWindowIds(this.deps.listOpenSessionWindowIds());
  }

  broadcastAuxiliarySessionSelection(parentSessionId: string, auxiliarySessionId: string): void {
    this.deps
      .getWindowBroadcastService()
      .broadcastAuxiliarySessionSelection(parentSessionId, auxiliarySessionId);
  }
}
