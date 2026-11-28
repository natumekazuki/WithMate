import type {
  WithMateWindowCatalogApi,
  WithMateWindowNavigationApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeSessionWindowRestoreIds,
  normalizeSessionWindowRestoreResult,
} from "../../src-shared/window/session-window-restore.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import { LOCAL_PR_OPEN_WINDOW } from "../../src-shared/local-pr/local-pr-ipc.js";
import type { IpcRendererLike } from "./ipc.js";

/** renderer の画面遷移、ネイティブメニューとローカルパス操作を Main に接続する。 */
export function createWindowApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowNavigationApi {
  return {
    /** Home で使う Crew のページを、カーソルなどの指定とともに取得する。 */
    listHomeCrewPage(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_HOME_CREW_PAGE_CHANNEL,
        request ?? null,
      );
    },
    /** Home の Crew 対象と画面上の位置を渡して、ネイティブメニューを開く。 */
    showHomeCrewContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_HOME_CREW_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** 独立したファイルプレビューに対する操作をネイティブメニューとして表示する。 */
    showSessionFilePreviewContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** 開いているファイルプレビューを所有 Session 別に取得する。 */
    listSessionFilePreviewWindows() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
      );
    },
    /** 指定トークンのプレビューウィンドウを前面に出す。 */
    focusSessionFilePreviewWindow(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
        token,
      );
    },
    /** 指定トークンに対応する一つのプレビューを閉じる。 */
    closeSessionFilePreviewWindow(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
        token,
      );
    },
    /** 指定した所有 Session のプレビューウィンドウをまとめて閉じる。 */
    closeSessionFilePreviewWindows(ownerSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
        ownerSessionId,
      );
    },
    /** Main Session を開き、Auxiliary を指定した場合は同じ会話ウィンドウで選択する。 */
    openSession(sessionId, auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_CHANNEL,
        sessionId,
        auxiliarySessionId ?? null,
      );
    },
    /** 対象 Session の所有ウィンドウから、Local PR の専用画面を開くよう要求する。 */
    openLocalPrWindow(target) {
      return ipcRenderer.invoke(LOCAL_PR_OPEN_WINDOW, target);
    },
    /** Session 監視画面で対象に対するネイティブメニューを表示する。 */
    showSessionMonitorContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** 未復元の Session ID を取得し、不正な IPC 応答を空集合として扱わない。 */
    async getSessionWindowRestoreSet() {
      const sessionIds = normalizeSessionWindowRestoreIds(
        await ipcRenderer.invoke(
          channels.WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL,
        ),
      );
      if (!sessionIds)
        throw new Error("Invalid Session Window restore set response.");
      return sessionIds;
    },
    /** 前回の会話ウィンドウを復元し、対象別の結果を検証してから返す。 */
    async restoreSessionWindows() {
      const result = normalizeSessionWindowRestoreResult(
        await ipcRenderer.invoke(
          channels.WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL,
        ),
      );
      if (!result) throw new Error("Invalid Session Window restore result.");
      return result;
    },
    /** アプリの主画面を表示するよう Main に要求する。 */
    openHomeWindow() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_HOME_WINDOW_CHANNEL);
    },
    /** 会話とは別に稼働状況を見る Session Monitor を表示する。 */
    openSessionMonitorWindow() {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
      );
    },
    /** アプリ設定を扱うウィンドウを表示する。 */
    openSettingsWindow() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL);
    },
    /** Character の編集を開く。ID を省略すると新規作成を選ぶ。 */
    openCharacterEditorWindow(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
        characterId ?? null,
      );
    },
    /** 比較する内容を渡し、差分専用ウィンドウで表示する。 */
    openDiffWindow(diffPreview) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
        diffPreview,
      );
    },
    /** ファイルプレビューの対象と文脈を渡し、既存画面の再利用か新規表示を要求する。 */
    openSessionFilePreviewWindow(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
        request,
      );
    },
    /** リンクやローカルパスの表示・選択を、オプションとともに Main に委譲する。 */
    openPath(target, options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_PATH_CHANNEL,
        target,
        options ?? null,
      );
    },
    /** リンクと位置情報を渡し、利用可能なコピー操作をメニューで選ぶ。 */
    showMarkdownLinkContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    /** アプリ診断ログの保存先を OS のファイルマネージャーで表示する。 */
    openAppLogFolder() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL);
    },
    /** ローカルのクラッシュダンプ保存先を表示する。 */
    openCrashDumpFolder() {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
      );
    },
    /** 指定 Session のワークスペースで外部端末を開くよう要求する。 */
    openSessionTerminal(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
        sessionId,
      );
    },
    /** 指定パスに対する外部端末の起動を Main に委譲する。 */
    openTerminalAtPath(target) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
        target,
      );
    },
  };
}

/** モデル一覧と、差分ウィンドウのトークンに紐付く表示内容を読む窓口。 */
export function createCatalogApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowCatalogApi {
  return {
    /** 指定されたプロバイダーやワークスペースの条件で候補一覧を取得する。 */
    getModelCatalog(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_MODEL_CATALOG_CHANNEL,
        request,
      );
    },
    /** 差分のトークンに対応する、本体から渡された表示用データを取得する。 */
    getDiffPreview(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
        token,
      );
    },
  };
}
