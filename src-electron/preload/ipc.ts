import type { IpcRenderer } from "electron";

/** preload が使う IPC の要求、通知とイベント購読に限定したインターフェース。 */
export type IpcRendererLike = Pick<
  IpcRenderer,
  "invoke" | "on" | "removeListener" | "send"
>;
/** 登録した IPC 購読を解除するために呼び出す関数。 */
export type ListenerDisposer = () => void;

/** renderer へ生の IPC イベントを渡さずに購読し、登録したリスナーだけを解除する手段を返す。 */
export function subscribe<EventArgs extends unknown[]>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  listener: (...args: EventArgs) => void,
): ListenerDisposer {
  /** IPC イベント本体を除き、チャンネルが定める引数だけを画面側のリスナーへ渡す。 */
  const wrapped = (_event: unknown, ...args: EventArgs) => {
    listener(...args);
  };

  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}
