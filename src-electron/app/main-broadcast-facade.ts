import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { PromptTemplate } from "../../src-shared/prompt-template.js";
import type { WindowBroadcastService } from "../windows/window-broadcast-service.js";
import {
  SESSION_SUMMARY_ID_MAX_LENGTH,
  SESSION_SUMMARY_INVALIDATION_ID_MAX,
} from "../session/session-summary-query.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** Main の通知を届ける Electron ウィンドウに必要な最小の操作。 */
type BroadcastWindowLike = {
  /** 破棄されたウィンドウを通知の対象から外すための状態。 */
  isDestroyed(): boolean;
  webContents: {
    /** IPC チャンネルを介して、このウィンドウの renderer に通知する。 */
    send(channel: string, payload: unknown): void;
  };
};

/** 通知の配送先と、通知を組み立てるための最新状態の取得口。 */
type MainBroadcastFacadeDeps<TWindow extends BroadcastWindowLike> = {
  /** 実際のウィンドウへの通知を担うサービスを取得する。 */
  getWindowBroadcastService(): WindowBroadcastService<TWindow>;
  /** スナップショット未指定時に、現在のモデル一覧を取得する。 */
  getModelCatalog(): Awaitable<ModelCatalogSnapshot | null>;
  /** 通知に設定が添付されていない場合、現在の設定を読み直す。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 通知にテンプレートが添付されていない場合、現在の一覧を読み直す。 */
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  /** 開いている Session ウィンドウの通知に使う ID を列挙する。 */
  listOpenSessionWindowIds(): string[];
};

/** Main が保有する状態を通知用の値に整え、各ウィンドウへの配送を委ねる。 */
export class MainBroadcastFacade<TWindow extends BroadcastWindowLike> {
  /** 状態を通知時に取得できるよう、読み取り口と配送サービスの取得口を保持する。 */
  constructor(private readonly deps: MainBroadcastFacadeDeps<TWindow>) {}

  /** Session ID を整形・重複排除し、有効な対象を上限内で特定できなければ全件の再取得を通知する。 */
  broadcastSessions(
    sessionIds?: Iterable<string>,
    detailChanged?: false,
  ): void {
    const invalidatedSessionIds =
      sessionIds === undefined
        ? []
        : Array.from(
            new Set(
              Array.from(sessionIds)
                .map((sessionId) => sessionId.trim())
                .filter(Boolean),
            ),
          );
    const invalidation: SessionSummaryInvalidation =
      sessionIds === undefined ||
      invalidatedSessionIds.length === 0 ||
      invalidatedSessionIds.length > SESSION_SUMMARY_INVALIDATION_ID_MAX ||
      invalidatedSessionIds.some(
        (sessionId) => sessionId.length > SESSION_SUMMARY_ID_MAX_LENGTH,
      )
        ? { scope: "all" }
        : { scope: "ids", sessionIds: invalidatedSessionIds };
    const windowBroadcastService = this.deps.getWindowBroadcastService();
    windowBroadcastService.broadcastSessionInvalidation(
      detailChanged === false
        ? { ...invalidation, detailChanged }
        : invalidation,
    );
  }

  /** 指定値か現在のモデル一覧を通知する。取得結果がなければ空の一覧に置き換えず、通知しない。 */
  async broadcastModelCatalog(
    snapshot?: ModelCatalogSnapshot | null,
  ): Promise<void> {
    const payload = snapshot ?? (await this.deps.getModelCatalog());
    if (!payload) {
      return;
    }

    this.deps.getWindowBroadcastService().broadcastModelCatalog(payload);
  }

  /** 指定された設定を通知する。省略時は現在の設定を読み取って通知する。 */
  async broadcastAppSettings(settings?: AppSettings): Promise<void> {
    const payload = settings ?? (await this.deps.getAppSettings());
    this.deps.getWindowBroadcastService().broadcastAppSettings(payload);
  }

  /** 指定されたテンプレート一覧を通知する。省略時だけ保存済み一覧を取得する。 */
  async broadcastPromptTemplates(templates?: PromptTemplate[]): Promise<void> {
    const payload = templates ?? (await this.deps.listPromptTemplates());
    this.deps.getWindowBroadcastService().broadcastPromptTemplates(payload);
  }

  /** 今開いている Session ウィンドウの ID 一覧を通知する。 */
  broadcastOpenSessionWindowIds(): void {
    this.deps
      .getWindowBroadcastService()
      .broadcastOpenSessionWindowIds(this.deps.listOpenSessionWindowIds());
  }

  /** 選択された Auxiliary を、所属する親 Session の ID と共に通知する。 */
  broadcastAuxiliarySessionSelection(
    parentSessionId: string,
    auxiliarySessionId: string,
  ): void {
    this.deps
      .getWindowBroadcastService()
      .broadcastAuxiliarySessionSelection(parentSessionId, auxiliarySessionId);
  }
}
