import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { HTML_PREVIEW_DISPOSE, HTML_PREVIEW_MOUNT, HTML_PREVIEW_RESPOND, type HtmlPreviewMountRequest, type HtmlPreviewSource } from "../../src-shared/window/html-preview.js";
import { HtmlPreviewService } from "../files/html-preview-service.js";
import { assertHtmlPreviewMount } from "../files/html-preview-policy.js";
import { assertNotHtmlPreviewSender } from "../files/html-preview-isolation.js";
import type { HtmlPreviewResources } from "../files/html-preview-resources.js";
import type { MainIpcSessionQueryDeps } from "./contracts.js";
import { assertSessionFileLinkSender, assertSessionFileResourceSender, assertValidSessionFilePreviewResourceRequest } from "./shared.js";

export function registerHtmlPreviewHandlers(ipc: IpcMain, deps: {
  authorization: MainIpcSessionQueryDeps;
  resolveResources(source: HtmlPreviewSource): Promise<HtmlPreviewResources>;
}): void {
  const service = new HtmlPreviewService();
  const pending = new Map<string, symbol>();
  const key = (event: IpcMainInvokeEvent, id: string) => `${event.sender.id}:${id}`;
  ipc.handle(HTML_PREVIEW_MOUNT, async (event, request: HtmlPreviewMountRequest) => {
    assertNotHtmlPreviewSender(event);
    assertHtmlPreviewMount(request);
    const frame = event.senderFrame;
    const owner = deps.authorization.resolveEventWindow(event);
    const authorize = async () => {
      if (!owner || owner.isDestroyed() || event.sender.isDestroyed() || !frame
        || event.sender.mainFrame !== frame || deps.authorization.resolveEventWindow(event) !== owner) {
        throw new Error("HTML preview requires its original main application frame.");
      }
      const source = request.source;
      if (source.kind === "resource") {
        assertValidSessionFilePreviewResourceRequest(source.resource);
        await assertSessionFileResourceSender(event, source.resource, deps.authorization);
      } else {
        const link = source.request;
        if (!link || typeof link.sessionId !== "string" || !link.sessionId
          || typeof link.target !== "string" || !link.target.trim()) throw new TypeError("Invalid HTML source.");
        if (link.baseResource !== undefined) assertValidSessionFilePreviewResourceRequest(link.baseResource, link.sessionId);
        await assertSessionFileLinkSender(event, link.sessionId, link.baseResource, deps.authorization);
      }
      if (owner.isDestroyed() || event.sender.isDestroyed() || event.sender.mainFrame !== frame
        || deps.authorization.resolveEventWindow(event) !== owner) throw new Error("HTML preview owner changed.");
    };
    const pendingKey = key(event, request.id);
    if (pending.has(pendingKey)) throw new Error("HTML preview is already mounting.");
    const nonce = Symbol();
    pending.set(pendingKey, nonce);
    try {
      await authorize();
      const resources = await deps.resolveResources(request.source);
      await authorize();
      if (pending.get(pendingKey) !== nonce) throw new Error("HTML preview mount was canceled.");
      return service.mount(event, request, resources, authorize);
    } finally { if (pending.get(pendingKey) === nonce) pending.delete(pendingKey); }
  });
  ipc.handle(HTML_PREVIEW_DISPOSE, (event, id: string) => {
    service.dispose(event, id);
    pending.delete(key(event, id));
  });
  ipc.handle(HTML_PREVIEW_RESPOND, (event, id, requestId, choice) => service.respond(event, id, requestId, choice));
}
