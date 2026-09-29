import type { WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

export function createTerminalApi(ipcRenderer: IpcRendererLike): WithMateWindowTerminalApi {
  return {
    createTerminal: (request) => ipcRenderer.invoke(channels.WITHMATE_CREATE_TERMINAL_CHANNEL, request),
    writeTerminalInput: (id, data) => {
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 32_768, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
        ipcRenderer.send(channels.WITHMATE_WRITE_TERMINAL_INPUT_CHANNEL, id, data.slice(start, end));
        start = end;
      }
    },
    resizeTerminal: (id, cols, rows) => ipcRenderer.send(channels.WITHMATE_RESIZE_TERMINAL_CHANNEL, id, cols, rows),
    acknowledgeTerminalOutput: (id, characters) => ipcRenderer.send(channels.WITHMATE_ACKNOWLEDGE_TERMINAL_OUTPUT_CHANNEL, id, characters),
    closeTerminal: (id) => ipcRenderer.invoke(channels.WITHMATE_CLOSE_TERMINAL_CHANNEL, id),
    releaseTerminal: (id) => ipcRenderer.invoke(channels.WITHMATE_RELEASE_TERMINAL_CHANNEL, id),
    subscribeTerminalEvents: (listener) => subscribe(ipcRenderer, channels.WITHMATE_TERMINAL_EVENT, listener),
  };
}
