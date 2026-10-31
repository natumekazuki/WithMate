import type {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";

import type {
  SessionFileDescriptor,
  SessionFilePreviewImageContextMenuResult,
  SessionFilePreviewImageCopyResult,
  SessionFilePreviewImagePoint,
  SessionImageResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

type ImageCopyWebContents = Pick<WebContents, "copyImageAt" | "isDestroyed">;
type ImageCopyMenu = Pick<Menu, "popup">;

export type SessionFilePreviewImageCopyServiceDeps = {
  buildMenu(template: MenuItemConstructorOptions[]): ImageCopyMenu;
  inspectImage(request: SessionImageResourceRequest): Promise<Pick<SessionFileDescriptor, "kind" | "absoluteFilePath">>;
  writeText(targetPath: string): void;
};

type ImagePathCopy = {
  request: SessionImageResourceRequest;
  assertSender(): Promise<void>;
};

const IMAGE_COPY_FAILED_MESSAGE = "Image could not be copied.";
const IMAGE_CONTEXT_MENU_FAILED_MESSAGE = "Image context menu could not be opened.";

export class SessionFilePreviewImageCopyService {
  constructor(private readonly deps: SessionFilePreviewImageCopyServiceDeps) {}

  copyImage(
    webContents: ImageCopyWebContents,
    point: SessionFilePreviewImagePoint,
  ): SessionFilePreviewImageCopyResult {
    if (webContents.isDestroyed()) {
      return { status: "failed", message: IMAGE_COPY_FAILED_MESSAGE };
    }
    try {
      webContents.copyImageAt(point.x, point.y);
      return { status: "copied" };
    } catch {
      return { status: "failed", message: IMAGE_COPY_FAILED_MESSAGE };
    }
  }

  showContextMenu(
    window: BrowserWindow | null,
    webContents: ImageCopyWebContents,
    point: SessionFilePreviewImagePoint,
    pathCopy?: ImagePathCopy,
  ): Promise<SessionFilePreviewImageContextMenuResult> {
    if (!window || webContents.isDestroyed()) {
      return Promise.resolve({ status: "failed", message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE });
    }
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      const settle = (result: SessionFilePreviewImageContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const select = (action: () => SessionFilePreviewImageContextMenuResult | Promise<SessionFilePreviewImageContextMenuResult>) => {
        if (settled || selectionStarted) return;
        selectionStarted = true;
        void Promise.resolve(action()).then(settle);
      };

      try {
        const template: MenuItemConstructorOptions[] = [{
          label: "Copy Image",
          click: () => select(() => this.copyImage(webContents, point)),
        }];
        if (pathCopy) {
          template.push({
            label: "Copy Path",
            click: () => select(() => this.copyImagePath(webContents, pathCopy)),
          });
        }
        const menu = this.deps.buildMenu(template);
        menu.popup({
          window,
          x: point.x,
          y: point.y,
          callback: () => {
            if (!selectionStarted) settle({ status: "dismissed" });
          },
        });
      } catch {
        settle({ status: "failed", message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE });
      }
    });
  }

  private async copyImagePath(
    webContents: ImageCopyWebContents,
    { request, assertSender }: ImagePathCopy,
  ): Promise<SessionFilePreviewImageContextMenuResult> {
    try {
      await assertSender();
      const descriptor = await this.deps.inspectImage(request);
      if ((descriptor.kind !== "image" && descriptor.kind !== "svg")
        || /[\u0000-\u001f\u007f]/.test(descriptor.absoluteFilePath)) {
        throw new Error("Image path is invalid.");
      }
      await assertSender();
      if (webContents.isDestroyed()) throw new Error("Image window was closed.");
      this.deps.writeText(descriptor.absoluteFilePath);
      return { status: "copied-path" };
    } catch {
      return { status: "failed", message: "Image path could not be copied." };
    }
  }
}
