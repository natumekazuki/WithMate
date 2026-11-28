import type { IpcMain, IpcMainEvent } from "electron";
import type { CreateTerminalRequest } from "../../src-shared/terminal/terminal-contract.js";
import {
  WITHMATE_ACKNOWLEDGE_TERMINAL_OUTPUT_CHANNEL,
  WITHMATE_CLOSE_TERMINAL_CHANNEL,
  WITHMATE_CREATE_TERMINAL_CHANNEL,
  WITHMATE_RELEASE_TERMINAL_CHANNEL,
  WITHMATE_RESIZE_TERMINAL_CHANNEL,
  WITHMATE_TERMINAL_EVENT,
  WITHMATE_WRITE_TERMINAL_INPUT_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type {
  TerminalService,
  TerminalOwner,
} from "../terminal/terminal-service.js";

/** 端末の作成・入出力・サイズ変更・終了を端末サービスへつなぐ。invoke の失敗はそのまま伝播し、単方向イベントの失敗は操作エラーとして通知する。 */
export function registerTerminalHandlers<TWindow extends TerminalOwner>(
  ipcMain: IpcMain,
  service: TerminalService<TWindow>,
): void {
  /** 応答のないイベントで処理に失敗したとき、送信元が存続していれば対象端末 ID とエラーを通知する。 */
  const run = (event: IpcMainEvent, id: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(WITHMATE_TERMINAL_EVENT, {
          type: "operation-error",
          terminalId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  ipcMain.handle(
    WITHMATE_CREATE_TERMINAL_CHANNEL,
    (event, request: CreateTerminalRequest) => service.create(event, request),
  );
  ipcMain.on(
    WITHMATE_WRITE_TERMINAL_INPUT_CHANNEL,
    (event, id: string, data: string) =>
      run(event, id, () => service.write(event, id, data)),
  );
  ipcMain.on(
    WITHMATE_RESIZE_TERMINAL_CHANNEL,
    (event, id: string, cols: number, rows: number) =>
      run(event, id, () => service.resize(event, id, cols, rows)),
  );
  ipcMain.on(
    WITHMATE_ACKNOWLEDGE_TERMINAL_OUTPUT_CHANNEL,
    (event, id: string, characters: number) =>
      run(event, id, () => service.acknowledge(event, id, characters)),
  );
  ipcMain.handle(WITHMATE_CLOSE_TERMINAL_CHANNEL, (event, id: string) =>
    service.close(event, id),
  );
  ipcMain.handle(WITHMATE_RELEASE_TERMINAL_CHANNEL, (event, id: string) =>
    service.release(event, id),
  );
}
