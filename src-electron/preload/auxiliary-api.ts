import type { WithMateWindowAuxiliaryApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

/** 親 Session の renderer から、Auxiliary の表示・作成・下書き・Turn 操作を Main に要求する窓口。 */
export function createAuxiliaryApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowAuxiliaryApi {
  return {
    /** 指定した親に所属する Auxiliary の概要一覧を取得する。 */
    listAuxiliarySessions(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
        parentSessionId,
      );
    },
    /** 開いている Auxiliary の概要を Main からまとめて取得する。 */
    listOpenAuxiliarySessionSummaries() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
      );
    },
    /** 対象の親に紐付く最後の Auxiliary の表示データを取得する。 */
    getLatestAuxiliarySession(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_LATEST_AUXILIARY_SESSION_CHANNEL,
        parentSessionId,
      );
    },
    /** Auxiliary の識別子から、対象の会話の表示データを取得する。 */
    getAuxiliarySession(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
        auxiliarySessionId,
      );
    },
    /** 指定 Auxiliary の未送信下書きを取得する。 */
    getAuxiliaryDraft(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL,
        auxiliarySessionId,
      );
    },
    /** 対象と変更の識別情報を含む下書きの保存要求を渡す。 */
    saveAuxiliaryDraft(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
        input,
      );
    },
    /** Auxiliary の表示時に必要な現在の実行状態を照会する。 */
    getAuxiliarySessionStatus(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL,
        auxiliarySessionId,
      );
    },
    /** 選んだ親・設定を含む Auxiliary の作成要求を Main に渡す。 */
    createAuxiliarySession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
        input,
      );
    },
    /** 親に対する新規作成に必要な現在の受付コンテキストを取得する。 */
    getAuxiliaryCreationContext(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL,
        parentSessionId,
      );
    },
    /** 指定した作成要求を取り消せるか Main に問い合わせる。 */
    cancelAuxiliaryCreation(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL,
        request,
      );
    },
    /** 同じ作成要求の確定結果を照会し、状態を確認する。 */
    getAuxiliaryCreation(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_CREATION_CHANNEL,
        request,
      );
    },
    /** Auxiliary の更新候補を渡す。保存先と履歴の扱いは Main が決める。 */
    updateAuxiliarySession(session) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
        session,
      );
    },
    /** 対象 Auxiliary の今後の実行設定だけを変更する。 */
    setAuxiliaryExecutionOptions(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL,
        request,
      );
    },
    /** 対象 Auxiliary の件名を更新する。 */
    setAuxiliaryTitle(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_AUXILIARY_TITLE_CHANNEL,
        request,
      );
    },
    /** 指定された保存済みメッセージのブックマークを更新する。 */
    setAuxiliaryMessageBookmark(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL,
        request,
      );
    },
    /** 指定 Auxiliary に新しい Turn の入力を送る。 */
    runAuxiliarySessionTurn(auxiliarySessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
        auxiliarySessionId,
        request,
      );
    },
    /** 実行中の Auxiliary Turn へ、対象を明示して追加入力を送る。 */
    steerAuxiliarySessionTurn(auxiliarySessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL,
        auxiliarySessionId,
        request,
      );
    },
    /** 対象の Auxiliary 実行に停止を要求する。 */
    cancelAuxiliarySessionRun(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
        request,
      );
    },
  };
}
