import type {
  WithMateWindowPromptTemplateApi,
  WithMateWindowPickerApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

/** 保存されたプロンプトテンプレートの一覧・編集と、更新通知の購読を接続する。 */
export function createPromptTemplateApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowPromptTemplateApi {
  return {
    /** 現在利用できるプロンプトテンプレートの一覧を取得する。 */
    listPromptTemplates() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL,
      );
    },
    /** 入力したテンプレートを新規作成するよう Main に要求する。 */
    createPromptTemplate(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
        input,
      );
    },
    /** 保存済みテンプレートを識別子で指定して変更する。 */
    updatePromptTemplate(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
        input,
      );
    },
    /** 指定されたテンプレートを削除するよう Main に要求する。 */
    deletePromptTemplate(id) {
      return ipcRenderer.invoke(
        channels.WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
        id,
      );
    },
    /** テンプレート一覧の変更を購読し、その購読だけを解除する手段を返す。 */
    subscribePromptTemplates(listener) {
      return subscribe(
        ipcRenderer,
        channels.WITHMATE_PROMPT_TEMPLATES_CHANGED_EVENT,
        listener,
      );
    },
  };
}

/** ネイティブのファイル選択と、Session 専用ファイル置き場への操作を接続する。 */
export function createPickerApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowPickerApi {
  return {
    /** パスを作業ディレクトリとして利用できるか、Main に検証を要求する。 */
    validateWorkspaceDirectory(targetPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
        targetPath,
      );
    },
    /** 初期位置を指定してディレクトリを一つ選ぶ。 */
    pickDirectory(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_DIRECTORY_CHANNEL,
        initialPath ?? null,
      );
    },
    /** 初期位置を指定してファイルを一つ選ぶ。 */
    pickFile(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_FILE_CHANNEL,
        initialPath ?? null,
      );
    },
    /** 初期位置を指定して複数ファイルを選べるダイアログを開く。 */
    pickFiles(initialPath) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_FILES_CHANNEL,
        initialPath ?? null,
      );
    },
    /** 対象 Session の文脈で、添付などに使うファイルを選ぶ。 */
    pickSessionFiles(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_FILES_CHANNEL,
        sessionId,
      );
    },
    /** 対象 Session の文脈で、フォルダーを一つ選ぶ。 */
    pickSessionFolder(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
        sessionId,
      );
    },
    /** 対象 Session の文脈で、添付画像に使うファイルを選ぶ。 */
    pickSessionImageFile(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
        sessionId,
      );
    },
    /** 用途に応じた画像フィルターを指定する。省略時は一般画像用を使う。 */
    pickImageFile(initialPath, purpose) {
      return ipcRenderer.invoke(
        channels.WITHMATE_PICK_IMAGE_FILE_CHANNEL,
        initialPath ?? null,
        purpose ?? "general",
      );
    },
    /** 選んだファイルを指定 Session の専用フォルダーにコピーする。 */
    copyFilesToSessionFiles(sessionId, sourcePaths) {
      return ipcRenderer.invoke(
        channels.WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
        sessionId,
        sourcePaths,
      );
    },
    /** 貼り付けたデータと衝突時の指定を、SessionFolder の保存処理へ渡す。 */
    savePastedSessionFile(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
        request,
      );
    },
    /** 指定 Session の専用フォルダーをファイルマネージャーで表示する。 */
    openSessionFilesDirectory(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
        sessionId,
      );
    },
    /** 指定 Session の専用フォルダーを作業ディレクトリとして端末を開く。 */
    openSessionFilesTerminal(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
        sessionId,
      );
    },
  };
}
