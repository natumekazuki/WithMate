import type {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";

import type {
  SessionFilePreviewImageContextMenuResult,
  SessionFilePreviewImageCopyResult,
  SessionFilePreviewImagePoint,
} from "../src/file-explorer/file-explorer-contract.js";

type ImageCopyWebContents = Pick<WebContents, "copyImageAt" | "isDestroyed">;
type ImageCopyMenu = Pick<Menu, "popup">;

export type SessionFilePreviewImageCopyServiceDeps = {
  buildMenu(template: MenuItemConstructorOptions[]): ImageCopyMenu;
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
  ): Promise<SessionFilePreviewImageContextMenuResult> {
    if (!window || webContents.isDestroyed()) {
      return Promise.resolve({ status: "failed", message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE });
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: SessionFilePreviewImageContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        const menu = this.deps.buildMenu([{
          label: "Copy Image",
          click: () => settle(this.copyImage(webContents, point)),
        }]);
        menu.popup({
          window,
          x: point.x,
          y: point.y,
          callback: () => settle({ status: "dismissed" }),
        });
      } catch {
        settle({ status: "failed", message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE });
      }
    });
  }
}
