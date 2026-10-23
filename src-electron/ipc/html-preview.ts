import type { IpcMain } from "electron";
import { HTML_PREVIEW_DISPOSE, HTML_PREVIEW_FOCUS, HTML_PREVIEW_LAYOUT, HTML_PREVIEW_MOUNT } from "../../src-shared/window/html-preview.js";
import { HtmlPreviewService } from "../files/html-preview-service.js";

export function registerHtmlPreviewHandlers(ipc: IpcMain): void {
  const service = new HtmlPreviewService();
  ipc.handle(HTML_PREVIEW_MOUNT, (event, request) => service.mount(event, request));
  ipc.handle(HTML_PREVIEW_DISPOSE, (event, id) => service.dispose(event, id));
  // Fire-and-forget geometry/focus must not throw out of an EventEmitter listener.
  ipc.on(HTML_PREVIEW_LAYOUT, (event, id, layout) => { try { service.layout(event, id, layout); } catch { /* Invalid or departed sender. */ } });
  ipc.on(HTML_PREVIEW_FOCUS, (event, id) => { try { service.focus(event, id); } catch { /* Invalid or departed sender. */ } });
}
