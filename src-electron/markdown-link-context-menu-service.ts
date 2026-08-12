import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../src/markdown-link-context-menu.js";

type LinkContextMenu = Pick<Menu, "popup">;

export type MarkdownLinkContextMenuServiceDeps = {
  buildMenu(template: MenuItemConstructorOptions[]): LinkContextMenu;
  writeText(target: string): void;
};

const LINK_COPY_FAILED_MESSAGE = "リンクをコピーできませんでした。";
const LINK_CONTEXT_MENU_FAILED_MESSAGE = "リンクのメニューを開けませんでした。";

export class MarkdownLinkContextMenuService {
  constructor(private readonly deps: MarkdownLinkContextMenuServiceDeps) {}

  private copyTarget(target: string): MarkdownLinkContextMenuResult {
    try {
      this.deps.writeText(target);
      return { status: "copied" };
    } catch {
      return { status: "failed", message: LINK_COPY_FAILED_MESSAGE };
    }
  }

  showContextMenu(
    window: BrowserWindow | null,
    request: MarkdownLinkContextMenuRequest,
  ): Promise<MarkdownLinkContextMenuResult> {
    if (!window) {
      return Promise.resolve({ status: "failed", message: LINK_CONTEXT_MENU_FAILED_MESSAGE });
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: MarkdownLinkContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        const menu = this.deps.buildMenu([{
          label: "リンクをコピー",
          click: () => settle(this.copyTarget(request.target)),
        }]);
        menu.popup({
          window,
          x: request.point.x,
          y: request.point.y,
          callback: () => settle({ status: "dismissed" }),
        });
      } catch {
        settle({ status: "failed", message: LINK_CONTEXT_MENU_FAILED_MESSAGE });
      }
    });
  }
}
