import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import {
  LOCAL_PR_CHANGED,
  LOCAL_PR_EXECUTE,
  LOCAL_PR_INSPECT_IMAGE,
  LOCAL_PR_PICK_ATTACHMENT,
  LOCAL_PR_READ_IMAGE_CHUNK,
  LOCAL_PR_SAVE_CLIPBOARD_IMAGE,
  LOCAL_PR_OPEN_ATTACHMENT,
} from "../../src-shared/local-pr/local-pr-ipc.js";

// 専用ウィンドウでは Session ウィンドウ向けのその他の preload 機能は不要。
contextBridge.exposeInMainWorld("withmateLocalPr", {
  /** 専用ウィンドウの操作名と入力を、認可と実行を担う Main の IPC へ渡す。 */
  execute: (operation, input) =>
    ipcRenderer.invoke(LOCAL_PR_EXECUTE, operation, input),
  /** Main が所有するダイアログで添付候補を選ぶ。 */
  pickAttachment: () => ipcRenderer.invoke(LOCAL_PR_PICK_ATTACHMENT),
  /** クリップボードから取得した File にローカルのパスがあれば Electron から取得する。 */
  clipboardFilePath: (file) => webUtils.getPathForFile(file),
  /** パスを持たない画像のバイト列を、Main が管理する添付ファイルに保存する。 */
  saveClipboardImage: (request) =>
    ipcRenderer.invoke(LOCAL_PR_SAVE_CLIPBOARD_IMAGE, request),
  /** 添付リンクを開く処理を、認可を検証する Main へ委譲する。 */
  openAttachment: (target) =>
    ipcRenderer.invoke(LOCAL_PR_OPEN_ATTACHMENT, target),
  /** 添付画像のサイズ・種別を取得する要求を Main に送る。 */
  inspectImage: (target) =>
    ipcRenderer.invoke(LOCAL_PR_INSPECT_IMAGE, { target }),
  /** 大きい画像を一括で渡さず、指定された範囲の読み取りを要求する。 */
  readImageChunk: (request) =>
    ipcRenderer.invoke(LOCAL_PR_READ_IMAGE_CHUNK, request),
  /** PR の再取得通知を購読する。指定した購読だけを解除する関数を返す。 */
  subscribeChanged(listener) {
    /** 生の IPC イベントや送信元を renderer の購読側へ公開せず、変更だけを通知する。 */
    const onChanged = () => listener();
    ipcRenderer.on(LOCAL_PR_CHANGED, onChanged);
    return () => ipcRenderer.removeListener(LOCAL_PR_CHANGED, onChanged);
  },
} satisfies LocalPrWindowApi);
