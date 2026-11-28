import type {
  WithMateWindowCharacterApi,
  WithMateWindowMateApi,
  WithMateWindowSettingsApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

/** アプリの Mate プロフィールの表示と更新を Main に接続する。 */
export function createMateApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowMateApi {
  return {
    /** Mate プロフィールの保存状態を取得する。 */
    getMateState() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_MATE_STATE_CHANNEL);
    },
    /** 保存されている Mate プロフィールの詳細を取得する。 */
    getMateProfile() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_MATE_PROFILE_CHANNEL);
    },
    /** 初期情報を渡し、Mate プロフィールの作成を要求する。 */
    createMate(input) {
      return ipcRenderer.invoke(channels.WITHMATE_CREATE_MATE_CHANNEL, input);
    },
    /** 入力された Mate プロフィールの変更を保存先へ渡す。 */
    updateMate(input) {
      return ipcRenderer.invoke(channels.WITHMATE_UPDATE_MATE_CHANNEL, input);
    },
    /** Mate のアバター選択を Main 側の保存処理に渡す。 */
    setMateAvatar(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SET_MATE_AVATAR_CHANNEL,
        input,
      );
    },
    /** Mate プロフィールをリセットするよう要求する。 */
    resetMate() {
      return ipcRenderer.invoke(channels.WITHMATE_RESET_MATE_CHANNEL);
    },
  };
}

/** Character のカタログ・定義の更新と、作成用 Session の起動を Main に接続する。 */
export function createCharacterApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowCharacterApi {
  return {
    /** カタログを照会する。アーカイブ済みを含めるかの指定も渡せる。 */
    listCharacters(options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_CHARACTERS_CHANNEL,
        options ?? null,
      );
    },
    /** 指定 ID のカタログ項目と定義本文を含む詳細を取得する。 */
    getCharacter(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_CHARACTER_CHANNEL,
        characterId,
      );
    },
    /** Character のカタログ項目と定義ファイルの新規作成を要求する。 */
    createCharacter(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_CHARACTER_CHANNEL,
        input,
      );
    },
    /** 対象 Character の名前・説明・見た目などの変更を保存する。 */
    updateCharacterMetadata(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
        input,
      );
    },
    /** 対象 Character の定義とノートの更新を保存する。 */
    updateCharacterDefinition(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
        input,
      );
    },
    /** 指定 ID を、新規起動の候補から外れるアーカイブ状態にする。 */
    archiveCharacter(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
        characterId,
      );
    },
    /** 起動時に指定した Character が有効な候補か Main に解決させる。 */
    resolveLaunchCharacter(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
        input ?? null,
      );
    },
    /** Character の作成・改稿用 Session の開始を要求する。 */
    startCharacterAuthoringSession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
        input,
      );
    },
  };
}

/** アプリ設定、保存データの診断とユーザー操作による整理を Main に接続する。 */
export function createSettingsApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowSettingsApi {
  return {
    /** 実行中のアプリのバージョンを取得する。 */
    getAppVersion() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_APP_VERSION_CHANNEL);
    },
    /** 現在有効なアプリ設定を取得する。 */
    getAppSettings() {
      return ipcRenderer.invoke(channels.WITHMATE_GET_APP_SETTINGS_CHANNEL);
    },
    /** 設定画面の変更を、プロバイダーや永続ストアを調停する Main 側へ渡す。 */
    updateAppSettings(settings) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
        settings,
      );
    },
    /** チャットレイアウトで変更した単一項目を専用経路へ渡す。 */
    updateChatLayoutPreference(update) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
        update,
      );
    },
    /** アプリのデータベースに関する診断情報を取得する。 */
    getAppDatabaseDiagnostics() {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
      );
    },
    /** 指定条件の SessionFolder 整理候補を調べる。整理の実行とは別に呼ぶ。 */
    scanSessionFolderCleanup(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SCAN_SESSION_FOLDER_CLEANUP_CHANNEL,
        request,
      );
    },
    /** 指定条件で SessionFolder の整理を実行し、その結果を取得する。 */
    runSessionFolderCleanup(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RUN_SESSION_FOLDER_CLEANUP_CHANNEL,
        request,
      );
    },
    /** 選択された範囲のアプリデータのリセットを Main に要求する。 */
    resetAppDatabase(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RESET_APP_DATABASE_CHANNEL,
        request,
      );
    },
    /** 最終活動日時の条件を指定して Session の削除を要求する。 */
    deleteSessionsLastActiveBefore(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
        request,
      );
    },
  };
}
