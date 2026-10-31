import type { IpcRenderer } from "electron";

export type IpcRendererLike = Pick<
  IpcRenderer,
  "invoke" | "on" | "removeListener" | "send"
>;
export type ListenerDisposer = () => void;

export function subscribe<EventArgs extends unknown[]>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  listener: (...args: EventArgs) => void,
): ListenerDisposer {
  const wrapped = (_event: unknown, ...args: EventArgs) => {
    listener(...args);
  };

  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}
