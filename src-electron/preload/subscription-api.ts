import type {
  WithMateWindowApi,
  WithMateWindowSubscriptionApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeAuxiliarySessionNavigationPayload,
  normalizeAuxiliarySessionSelectionPayload,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
  OPEN_SESSION_WINDOW_IDS_PAGE_MAX,
} from "../../src-shared/window/withmate-window-types.js";
import { normalizeSessionWindowRestoreIds } from "../../src-shared/window/session-window-restore.js";
import { normalizeSessionSummaryInvalidation } from "../../src-shared/session/session-summary-invalidation.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import type { LiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import { subscribe } from "./ipc.js";

/** 変更通知で扱うモデル一覧。取得 API と同じ値の形を使う。 */
type ModelCatalogChangedPayload = Awaited<
  ReturnType<WithMateWindowApi["getModelCatalog"]>
>;
/** 実行を所有するウィンドウに渡す Session ID と詳細な実行状態。 */
type LiveSessionRunPayload = {
  sessionId: string;
  state: Awaited<ReturnType<WithMateWindowApi["getLiveSessionRun"]>>;
};

/** 監視などへ通知する、Session ID と縮約した実行状態。 */
type LiveSessionRunStatusPayload = {
  sessionId: string;
  status: LiveSessionRunStatus | null;
};
/** プロバイダー単位で識別する利用枠の観測値と、その解除を含む通知。 */
type ProviderQuotaTelemetryPayload = {
  providerId: string;
  telemetry: Awaited<
    ReturnType<WithMateWindowApi["getProviderQuotaTelemetry"]>
  >;
};
/** Session 単位で識別する会話コンテキストの観測結果。 */
type SessionContextTelemetryPayload = {
  sessionId: string;
  telemetry: Awaited<
    ReturnType<WithMateWindowApi["getSessionContextTelemetry"]>
  >;
};

/** 生の IPC イベントを公開せず、画面ごとに必要な更新通知と解除手段を提供する。 */
export function createSubscriptionApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowSubscriptionApi {
  return {
    /** 別ウィンドウで開いているファイルプレビューの一覧が変わったことを知らせる。 */
    subscribeSessionFilePreviewWindowsChanged(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_FILE_PREVIEW_WINDOWS_CHANGED_EVENT,
        () => listener(),
      );
    },
    /** キューの再取得が必要な Session ID を、空でない文字列の通知だけから受け取る。 */
    onSessionTurnQueueChanged(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_TURN_QUEUE_CHANGED_EVENT,
        (payload: unknown) => {
          if (typeof payload === "string" && payload) listener(payload);
        },
      );
    },
    /** 送信済みの内容に変更があった送信元 Session ID を受け取る。 */
    onSessionSentDeliveriesChanged(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_SENT_DELIVERIES_CHANGED_EVENT,
        (payload: unknown) => {
          if (typeof payload === "string" && payload) listener(payload);
        },
      );
    },
    /** 保存済みの Turn が更新された Session ID を受け取る。 */
    onSessionTurnUpdated(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_TURN_UPDATED_EVENT,
        (payload: unknown) => {
          if (typeof payload === "string" && payload) listener(payload);
        },
      );
    },
    /** ウィンドウ閉鎖またはアプリ終了前に、Main からの下書き保存要求を受け取る。 */
    subscribeSessionDraftFlushRequest(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
        listener,
      );
    },
    /** 保留していた下書き保存操作で入力制限を解除する通知を受け取る。 */
    subscribeSessionDraftFlushRelease(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
        listener,
      );
    },
    /** 保存の確認結果を、元の要求 ID に対応付けて Main へ返す。 */
    acknowledgeSessionDraftFlush(requestId, success) {
      ipcRenderer.send(channels.WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL, {
        requestId,
        success,
      });
    },
    /** 起動画面が表示する、現在の起動段階と進捗を取得する。 */
    getAppBootStatus() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_APP_BOOT_STATUS_CHANNEL);
    },
    /** 起動段階の変更通知を購読する。現在状態の取得とは別に行う。 */
    subscribeAppBootStatus(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_APP_BOOT_STATUS_EVENT,
        listener,
      );
    },
    /** 開いているファイルプレビューの表示対象を切り替える通知を受け取る。 */
    subscribeSessionFilePreviewNavigation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
        listener,
      );
    },
    /** 正規化できる Auxiliary の移動指示だけを、親と対象の識別情報付きで受け取る。 */
    subscribeAuxiliarySessionNavigation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
        (payload: unknown) => {
          const normalized =
            normalizeAuxiliarySessionNavigationPayload(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    /** 有効な Session 概要の再取得範囲だけを画面に渡す。 */
    subscribeSessionInvalidation(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSIONS_INVALIDATED_EVENT,
        (payload: unknown) => {
          const normalized = normalizeSessionSummaryInvalidation(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    /** 空の通知を除き、更新後のモデル一覧を受け取る。 */
    subscribeModelCatalog(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
        (catalog: ModelCatalogChangedPayload) => {
          if (catalog) listener(catalog);
        },
      );
    },
    /** 保存を経たアプリ設定の変更を購読する。 */
    subscribeAppSettings(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_APP_SETTINGS_CHANGED_EVENT,
        listener,
      );
    },
    /** 所有ウィンドウに届く実行の詳細を受け取る。詳細のない通知は null として渡す。 */
    subscribeLiveSessionRun(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_LIVE_SESSION_RUN_EVENT,
        (payload: LiveSessionRunPayload) =>
          listener(payload.sessionId, payload.state ?? null),
      );
    },
    /** Session ごとの稼働状態だけを受け取る。実行本文は受け取らない。 */
    subscribeLiveSessionRunStatus(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_LIVE_SESSION_RUN_STATUS_EVENT,
        (payload: LiveSessionRunStatusPayload) =>
          listener(payload.sessionId, payload.status ?? null),
      );
    },
    /** 親 Session に属する選択済み Auxiliary の変更を、形式を検証して受け取る。 */
    subscribeAuxiliarySessionSelection(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_AUXILIARY_SESSION_SELECTION_EVENT,
        (payload: unknown) => {
          const normalized = normalizeAuxiliarySessionSelectionPayload(payload);
          if (normalized) listener(normalized);
        },
      );
    },
    /** 利用枠の観測値をプロバイダー ID とともに受け取る。値の解除は null で表す。 */
    subscribeProviderQuotaTelemetry(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
        (payload: ProviderQuotaTelemetryPayload) =>
          listener(payload.providerId, payload.telemetry ?? null),
      );
    },
    /** 会話コンテキストの観測結果を Session ID とともに受け取る。 */
    subscribeSessionContextTelemetry(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
        (payload: SessionContextTelemetryPayload) =>
          listener(payload.sessionId, payload.telemetry ?? null),
      );
    },
    /** Session 用語集の表示を更新するために変更通知を購読する。 */
    subscribeSessionGlossary(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
        listener,
      );
    },
    /** 開閉集合の変更を受け取る。全件の再取得通知ならページを読み切ってから渡す。 */
    subscribeOpenSessionWindowIds(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
        (payload: unknown) => {
          const normalized =
            normalizeOpenSessionWindowIdsChangedPayload(payload);
          if (!normalized) return;
          if (normalized.scope === "ids") {
            listener(normalized.sessionIds);
            return;
          }
          void listAllOpenSessionWindowIds(ipcRenderer).then(listener);
        },
      );
    },
    /** 復元候補の通知を正規化し、不正な通知を画面に流さない。 */
    subscribeSessionWindowRestoreSet(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_SESSION_WINDOW_RESTORE_SET_CHANGED_EVENT,
        (payload: unknown) => {
          const sessionIds = normalizeSessionWindowRestoreIds(payload);
          if (sessionIds) listener(sessionIds);
        },
      );
    },
  };
}

/** 開いている Session ID の再取得で、各ページの形式とカーソルの前進を確認して重複なく集める。 */
async function listAllOpenSessionWindowIds(
  ipcRenderer: IpcRendererLike,
): Promise<string[]> {
  const sessionIds: string[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = normalizeOpenSessionWindowIdsPageResult(
      await ipcRenderer.invoke(
        channels.WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
        { cursor, limit: OPEN_SESSION_WINDOW_IDS_PAGE_MAX },
      ),
    );
    if (!page) throw new Error("Invalid open Session Window ID page response.");
    sessionIds.push(...page.sessionIds);
    if (!page.hasMore) return Array.from(new Set(sessionIds));
    if (page.nextCursor === null || page.nextCursor === cursor)
      throw new Error(
        "The open Session Window ID page cursor did not advance.",
      );
    cursor = page.nextCursor;
  }
}
