import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import { WITHMATE_RENDERER_LOG_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

type PreloadErrorEvent = {
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
};
type PreloadUnhandledRejectionEvent = { reason?: unknown };
type PreloadWindow = {
  location: { href: string };
  addEventListener(
    type: "error",
    listener: (event: PreloadErrorEvent) => void,
  ): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PreloadUnhandledRejectionEvent) => void,
  ): void;
};

declare const window: PreloadWindow | undefined;

let rendererErrorLoggingInstalled = false;

function reportRendererLog(
  ipcRenderer: IpcRendererLike,
  input: RendererLogInput,
): void {
  ipcRenderer.send(WITHMATE_RENDERER_LOG_CHANNEL, input);
}

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
