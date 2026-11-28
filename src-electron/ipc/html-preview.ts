import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  HTML_PREVIEW_DISPOSE,
  HTML_PREVIEW_MOUNT,
  HTML_PREVIEW_RESPOND,
  type HtmlPreviewMountRequest,
  type HtmlPreviewSource,
} from "../../src-shared/window/html-preview.js";
import { HtmlPreviewService } from "../files/html-preview-service.js";
import { assertHtmlPreviewMount } from "../files/html-preview-policy.js";
import { assertNotHtmlPreviewSender } from "../files/html-preview-isolation.js";
import type { HtmlPreviewResources } from "../files/html-preview-resources.js";
import type { MainIpcSessionQueryDeps } from "./contracts.js";
import {
  assertSessionFileLinkSender,
  assertSessionFileResourceSender,
  assertValidSessionFilePreviewResourceRequest,
} from "./shared.js";

/** HTML プレビューの取付・破棄・応答の IPC を登録する。取付中に要求が破棄された場合や元の所有フレームが失効した場合は取付を拒否する。 */
export function registerHtmlPreviewHandlers(
  ipc: IpcMain,
  deps: {
    authorization: MainIpcSessionQueryDeps;
    /** 認可されたプレビュー元から HTML と関連リソースを解決する。 */
    resolveResources(source: HtmlPreviewSource): Promise<HtmlPreviewResources>;
  },
): void {
  const service = new HtmlPreviewService();
  const pending = new Map<string, symbol>();
  /** 同じプレビュー ID を使う別 renderer の取付を区別するため、送信元 ID を組み合わせる。 */
  const key = (event: IpcMainInvokeEvent, id: string) =>
    `${event.sender.id}:${id}`;
  ipc.handle(
    HTML_PREVIEW_MOUNT,
    async (event, request: HtmlPreviewMountRequest) => {
      assertNotHtmlPreviewSender(event);
      assertHtmlPreviewMount(request);
      const frame = event.senderFrame;
      const owner = deps.authorization.resolveEventWindow(event);
      /** 元のウィンドウとフレームが有効かを、リソースまたはリンクへのアクセス認可の前後で検証する。 */
      const authorize = async () => {
        if (
          !owner ||
          owner.isDestroyed() ||
          event.sender.isDestroyed() ||
          !frame ||
          event.sender.mainFrame !== frame ||
          deps.authorization.resolveEventWindow(event) !== owner
        ) {
          throw new Error(
            "HTML preview requires its original main application frame.",
          );
        }
        const source = request.source;
        if (source.kind === "resource") {
          assertValidSessionFilePreviewResourceRequest(source.resource);
          await assertSessionFileResourceSender(
            event,
            source.resource,
            deps.authorization,
          );
        } else {
          const link = source.request;
          if (
            !link ||
            typeof link.sessionId !== "string" ||
            !link.sessionId ||
            typeof link.target !== "string" ||
            !link.target.trim()
          )
            throw new TypeError("Invalid HTML source.");
          if (link.baseResource !== undefined)
            assertValidSessionFilePreviewResourceRequest(
              link.baseResource,
              link.sessionId,
            );
          await assertSessionFileLinkSender(
            event,
            link.sessionId,
            link.baseResource,
            deps.authorization,
          );
        }
        if (
          owner.isDestroyed() ||
          event.sender.isDestroyed() ||
          event.sender.mainFrame !== frame ||
          deps.authorization.resolveEventWindow(event) !== owner
        )
          throw new Error("HTML preview owner changed.");
      };
      const pendingKey = key(event, request.id);
      if (pending.has(pendingKey))
        throw new Error("HTML preview is already mounting.");
      const nonce = Symbol();
      pending.set(pendingKey, nonce);
      try {
        await authorize();
        const resources = await deps.resolveResources(request.source);
        await authorize();
        if (pending.get(pendingKey) !== nonce)
          throw new Error("HTML preview mount was canceled.");
        return service.mount(event, request, resources, authorize);
      } finally {
        if (pending.get(pendingKey) === nonce) pending.delete(pendingKey);
      }
    },
  );
  ipc.handle(HTML_PREVIEW_DISPOSE, (event, id: string) => {
    service.dispose(event, id);
    pending.delete(key(event, id));
  });
  ipc.handle(HTML_PREVIEW_RESPOND, (event, id, requestId, choice) =>
    service.respond(event, id, requestId, choice),
  );
}
