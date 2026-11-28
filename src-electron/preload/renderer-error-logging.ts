import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import { WITHMATE_RENDERER_LOG_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

/** renderer の実行時エラーを、本文と発生位置を含む診断に変換するための項目。 */
type PreloadErrorEvent = {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
};
/** 未処理の Promise 拒否から診断用に受け取る理由。 */
type PreloadUnhandledRejectionEvent = { reason?: unknown };
/** ログに記録するページと、グローバルエラー通知を受け取る最小の Window 契約。 */
type PreloadWindow = {
  location: { href: string };
  /** 実行時エラーの本文や発生位置を受け取るために購読する。 */
  addEventListener(
    type: "error",
    listener: (event: PreloadErrorEvent) => void,
  ): void;
  /** 未処理の Promise 拒否から reason を受け取るために購読する。 */
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PreloadUnhandledRejectionEvent) => void,
  ): void;
};

declare const window: PreloadWindow | undefined;

let rendererErrorLoggingInstalled = false;

/** 変換済みの renderer 診断を、応答を待たず Main のロガーへ渡す。 */
function reportRendererLog(
  ipcRenderer: IpcRendererLike,
  input: RendererLogInput,
): void {
  ipcRenderer.send(WITHMATE_RENDERER_LOG_CHANNEL, input);
}

/** ブラウザーの Window が利用可能なら、未捕捉エラーと未処理拒否の診断転送を一度だけ登録する。 */
export function installRendererErrorLogging(
  ipcRenderer: IpcRendererLike,
): void {
  if (rendererErrorLoggingInstalled || typeof window === "undefined") {
    return;
  }

  rendererErrorLoggingInstalled = true;
  window.addEventListener("error", (event) => {
    reportRendererLog(ipcRenderer, {
      level: "error",
      kind: "renderer.error",
      message: event.message || "Renderer error",
      url: window.location.href,
      data: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
      error:
        event.error instanceof Error
          ? {
              name: event.error.name,
              message: event.error.message,
              stack: event.error.stack,
            }
          : { message: event.message || "Renderer error" },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    reportRendererLog(ipcRenderer, {
      level: "error",
      kind: "renderer.unhandled-rejection",
      message:
        reason instanceof Error
          ? reason.message
          : "Renderer unhandled rejection",
      url: window.location.href,
      error:
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : {
              message:
                typeof reason === "string"
                  ? reason
                  : "Renderer unhandled rejection",
            },
      data: reason instanceof Error ? undefined : { reason },
    });
  });
}
