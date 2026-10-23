import type { WithMateHtmlPreviewApi } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_DISPOSE, HTML_PREVIEW_EVENT, HTML_PREVIEW_FOCUS, HTML_PREVIEW_LAYOUT, HTML_PREVIEW_MOUNT } from "../../src-shared/window/html-preview.js";
import { subscribe, type IpcRendererLike } from "./ipc.js";

export function createHtmlPreviewApi(ipc: IpcRendererLike): WithMateHtmlPreviewApi {
  return {
    mountHtmlPreview: (request) => ipc.invoke(HTML_PREVIEW_MOUNT, request),
    layoutHtmlPreview: (id, layout) => ipc.send(HTML_PREVIEW_LAYOUT, id, layout),
    disposeHtmlPreview: (id) => ipc.invoke(HTML_PREVIEW_DISPOSE, id),
    focusHtmlPreview: (id) => ipc.send(HTML_PREVIEW_FOCUS, id),
    subscribeHtmlPreviewEvents: (listener) => subscribe(ipc, HTML_PREVIEW_EVENT, listener),
  };
}
