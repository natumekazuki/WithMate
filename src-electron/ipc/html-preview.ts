import type { IpcMain } from "electron";
import { HTML_PREVIEW_DISPOSE, HTML_PREVIEW_MOUNT } from "../../src-shared/window/html-preview.js";
import { HtmlPreviewService } from "../files/html-preview-service.js";

export function registerHtmlPreviewHandlers(ipc: IpcMain): void {
  const service = new HtmlPreviewService();
  ipc.handle(HTML_PREVIEW_MOUNT, (event, request) => service.mount(event, request));
  ipc.handle(HTML_PREVIEW_DISPOSE, (event, id) => service.dispose(event, id));
}
