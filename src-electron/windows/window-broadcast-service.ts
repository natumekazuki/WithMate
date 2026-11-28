import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { PromptTemplate } from "../../src-shared/prompt-template.js";
import {
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT,
  WITHMATE_AUXILIARY_SESSION_SELECTION_EVENT,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_SESSION_WINDOW_RESTORE_SET_CHANGED_EVENT,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_PROMPT_TEMPLATES_CHANGED_EVENT,
  WITHMATE_SESSIONS_INVALIDATED_EVENT,
  WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
  WITHMATE_SESSION_TURN_UPDATED_EVENT,
  WITHMATE_SESSION_TURN_QUEUE_CHANGED_EVENT,
  WITHMATE_SESSION_SENT_DELIVERIES_CHANGED_EVENT,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX,
  type OpenSessionWindowIdsChangedPayload,
} from "../../src-shared/window/withmate-window-types.js";

/** Main からの通知を配送するウィンドウに必要な操作。 */
type WindowLike = {
  /** 既に閉じられたウィンドウへ通知しないための状態確認。 */
  isDestroyed(): boolean;
  webContents: {
    /** 指定チャンネルで renderer に通知を送る。 */
    send(channel: string, payload: unknown): void;
  };
};

/** 通知種別ごとに最新の宛先を解決し、配送失敗を診断するための設定。 */
type WindowBroadcastServiceOptions<TWindow extends WindowLike> = {
  /** アプリ全体への通知で使うウィンドウ一覧を取得する。 */
  getAllWindows(): TWindow[];
  /** Session 概要の再取得を知らせる Home 系ウィンドウを取得する。 */
  getHomeWindows(): TWindow[];
  /** 復元候補の更新を知らせる主 Home を取得する。未生成なら null。 */
  getPrimaryHomeWindow(): TWindow | null;
  /** Session の状態変更を受け取る個別の会話ウィンドウを列挙する。 */
  getSessionWindows(): TWindow[];
  /** 実行本文ではなく縮約した稼働状態を受け取るウィンドウを取得する。 */
  getLiveSessionRunStatusWindows(): TWindow[];
  /** 実行を所有する Session のウィンドウを、Main 側の識別情報で解決する。 */
  getLiveSessionRunWindow(sessionId: string): TWindow | null;
  /** 生きているウィンドウの中から、現在 renderer に送信できる宛先を選別する。 */
  canSendToWindow?(window: TWindow): boolean;
  /** 通知を配送できなかった際の診断処理。 */
  onSendFailed?(): void;
};

/** 通知内容に応じて renderer への配送先を分離し、個々の送信失敗を他の宛先へ波及させない。 */
export class WindowBroadcastService<TWindow extends WindowLike> {
  private homeCrewRevision = 0;

  /** 宛先の取得口を保持し、実際のウィンドウは各通知時に取得する。 */
  public constructor(
    private readonly options: WindowBroadcastServiceOptions<TWindow>,
  ) {}

  /** Session の概要または開閉集合の変更を反映した Home Crew のリビジョンを返す。 */
  public getHomeCrewRevision(): number {
    return this.homeCrewRevision;
  }

  /** Home Crew の版を進め、Home と会話ウィンドウに Session 概要の再取得範囲を通知する。 */
  public broadcastSessionInvalidation(
    payload: SessionSummaryInvalidation,
  ): void {
    this.homeCrewRevision++;
    this.broadcastTo(
      [...this.options.getHomeWindows(), ...this.options.getSessionWindows()],
      WITHMATE_SESSIONS_INVALIDATED_EVENT,
      payload,
    );
  }

  /** 更新されたモデル一覧をアプリのウィンドウへ配信する。 */
  public broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void {
    this.broadcast(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, snapshot);
  }

  /** 確定したアプリ設定を各ウィンドウの表示に反映できるよう通知する。 */
  public broadcastAppSettings(settings: AppSettings): void {
    this.broadcast(WITHMATE_APP_SETTINGS_CHANGED_EVENT, settings);
  }

  /** 更新後のプロンプトテンプレート一覧をアプリのウィンドウへ配信する。 */
  public broadcastPromptTemplates(templates: PromptTemplate[]): void {
    this.broadcast(WITHMATE_PROMPT_TEMPLATES_CHANGED_EVENT, templates);
  }

  /** 開いている ID を重複排除して通知し、件数上限を超えれば全件の再取得を求める。 */
  public broadcastOpenSessionWindowIds(sessionIds: string[]): void {
    this.homeCrewRevision++;
    const uniqueSessionIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    );
    const payload: OpenSessionWindowIdsChangedPayload =
      uniqueSessionIds.length > OPEN_SESSION_WINDOW_IDS_BROADCAST_MAX
        ? { scope: "all" }
        : { scope: "ids", sessionIds: uniqueSessionIds };
    this.broadcast(WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT, payload);
  }

  /** 未復元の候補一覧を主 Home にだけ送る。主 Home がなければ配送しない。 */
  public broadcastSessionWindowRestoreSet(sessionIds: readonly string[]): void {
    const homeWindow = this.options.getPrimaryHomeWindow();
    if (!homeWindow) {
      return;
    }
    this.broadcastTo(
      [homeWindow],
      WITHMATE_SESSION_WINDOW_RESTORE_SET_CHANGED_EVENT,
      [...sessionIds],
    );
  }

  /** 稼働状態の要約と所有ウィンドウ向けの実行詳細を異なる宛先に送り、終了時には null を通知する。 */
  public broadcastLiveSessionRun(
    sessionId: string,
    state: LiveSessionRunState | null,
  ): void {
    this.broadcastTo(
      this.options.getLiveSessionRunStatusWindows(),
      WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT,
      { sessionId, status: projectLiveSessionRunStatus(state) },
    );
    // renderer の選択状態ではなく、Main が所有する実行識別情報から解決する。
    try {
      const window = this.options.getLiveSessionRunWindow(sessionId);
      if (window)
        this.broadcastTo([window], WITHMATE_LIVE_SESSION_RUN_EVENT, {
          sessionId,
          state,
        });
    } catch {
      try {
        this.options.onSendFailed?.();
      } catch {
        /* 診断によって通知処理を中断しない。 */
      }
    }
  }

  /** Turn が更新された Session の ID を通知し、画面が保存内容を取得し直せるようにする。 */
  public broadcastSessionTurnUpdated(sessionId: string): void {
    this.broadcast(WITHMATE_SESSION_TURN_UPDATED_EVENT, sessionId);
  }

  /** 所有ウィンドウだけにキューの変更を通知する。Auxiliary では宛先の親 ID と対象の ID を分ける。 */
  public broadcastSessionTurnQueueChanged(
    sessionId: string,
    ownerSessionId = sessionId,
  ): void {
    const window = this.options.getLiveSessionRunWindow(ownerSessionId);
    if (window)
      this.broadcastTo(
        [window],
        WITHMATE_SESSION_TURN_QUEUE_CHANGED_EVENT,
        sessionId,
      );
  }

  /** 送信元を所有するウィンドウだけに、送信済み配送情報の再取得を知らせる。 */
  public broadcastSessionSentDeliveriesChanged(
    sourceSessionId: string,
    ownerSessionId = sourceSessionId,
  ): void {
    const window = this.options.getLiveSessionRunWindow(ownerSessionId);
    if (window)
      this.broadcastTo(
        [window],
        WITHMATE_SESSION_SENT_DELIVERIES_CHANGED_EVENT,
        sourceSessionId,
      );
  }

  /** 選択された Auxiliary と、その所属先の Session ID をまとめて通知する。 */
  public broadcastAuxiliarySessionSelection(
    parentSessionId: string,
    auxiliarySessionId: string,
  ): void {
    this.broadcast(WITHMATE_AUXILIARY_SESSION_SELECTION_EVENT, {
      parentSessionId,
      auxiliarySessionId,
    });
  }

  /** 利用枠の観測値またはその解除を、プロバイダー ID 付きで通知する。 */
  public broadcastProviderQuotaTelemetry(
    providerId: string,
    telemetry: ProviderQuotaTelemetry | null,
  ): void {
    this.broadcast(WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT, {
      providerId,
      telemetry,
    });
  }

  /** 会話コンテキストの観測値またはその解除を、対象 Session の ID 付きで通知する。 */
  public broadcastSessionContextTelemetry(
    sessionId: string,
    telemetry: SessionContextTelemetry | null,
  ): void {
    this.broadcast(WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT, {
      sessionId,
      telemetry,
    });
  }

  /** 宛先が限定されない通知を、現在の全ウィンドウに対する配送処理へ渡す。 */
  private broadcast(channel: string, payload: unknown): void {
    this.broadcastTo(this.options.getAllWindows(), channel, payload);
  }

  /** 送信可能な候補に一つずつ配送し、失敗した宛先があっても残る配送を続ける。 */
  private broadcastTo(
    windows: TWindow[],
    channel: string,
    payload: unknown,
  ): void {
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      try {
        if (
          this.options.canSendToWindow &&
          !this.options.canSendToWindow(window)
        )
          continue;
        window.webContents.send(channel, payload);
      } catch {
        // renderer への配送は、プロバイダーの出力や永続化を所有しない。
        try {
          this.options.onSendFailed?.();
        } catch {
          /* 診断によって通知処理を中断しない。 */
        }
      }
    }
  }
}
