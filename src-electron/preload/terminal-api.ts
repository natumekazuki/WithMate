import type { WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

/** 対象端末の生成・入出力・解放と、端末イベントの購読を Main へ接続する。 */
export function createTerminalApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowTerminalApi {
  return {
    /** 作業ディレクトリと表示寸法などを渡し、新しい端末の作成結果を待つ。 */
    createTerminal: (request) =>
      ipcRenderer.invoke(channels.WITHMATE_CREATE_TERMINAL_CHANNEL, request),
    /** 入力を上限内に分割して送る。UTF-16 のサロゲートペアを区切りで切らない。 */
    writeTerminalInput: (id, data) => {
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 32_768, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
        ipcRenderer.send(
          channels.WITHMATE_WRITE_TERMINAL_INPUT_CHANNEL,
          id,
          data.slice(start, end),
        );
        start = end;
      }
    },
    /** 画面の列数と行数の変更を、応答を待たず指定端末へ送る。 */
    resizeTerminal: (id, cols, rows) =>
      ipcRenderer.send(
        channels.WITHMATE_RESIZE_TERMINAL_CHANNEL,
        id,
        cols,
        rows,
      ),
    /** renderer が受け取った出力の文字数を Main に返し、出力制御に使えるようにする。 */
    acknowledgeTerminalOutput: (id, characters) =>
      ipcRenderer.send(
        channels.WITHMATE_ACKNOWLEDGE_TERMINAL_OUTPUT_CHANNEL,
        id,
        characters,
      ),
    /** 指定した端末に明示的な終了を要求し、Main の処理結果を待つ。 */
    closeTerminal: (id) =>
      ipcRenderer.invoke(channels.WITHMATE_CLOSE_TERMINAL_CHANNEL, id),
    /** renderer が使用を終えた端末の解放を要求する。 */
    releaseTerminal: (id) =>
      ipcRenderer.invoke(channels.WITHMATE_RELEASE_TERMINAL_CHANNEL, id),
    /** 端末の出力・状態・終了などのイベントを購読する。 */
    subscribeTerminalEvents: (listener) =>
      subscribe(ipcRenderer, channels.WITHMATE_TERMINAL_EVENT, listener),
  };
}
