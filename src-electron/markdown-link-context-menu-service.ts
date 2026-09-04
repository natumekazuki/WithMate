import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../src/markdown-link-context-menu.js";
import type { SessionFileResourceRequest } from "../src/file-explorer/file-explorer-contract.js";
import type { SessionFileObjectCopyResult } from "../src/file-explorer/session-file-object-copy-contract.js";
import { resolveMarkdownLinkCopyTarget } from "./open-path.js";

type LinkContextMenu = Pick<Menu, "popup">;

export type MarkdownLinkContextMenuServiceDeps = {
  buildMenu(template: MenuItemConstructorOptions[]): LinkContextMenu;
  writeText(target: string): void;
  resolveCopyableFile(request: MarkdownLinkContextMenuRequest): Promise<SessionFileResourceRequest | null>;
  copyFile(resource: SessionFileResourceRequest): Promise<SessionFileObjectCopyResult>;
};

const LINK_COPY_FAILED_MESSAGE = "リンクをコピーできませんでした。";
const LINK_CONTEXT_MENU_FAILED_MESSAGE = "リンクのメニューを開けませんでした。";

export class MarkdownLinkContextMenuService {
  constructor(private readonly deps: MarkdownLinkContextMenuServiceDeps) {}

  private copyTarget(target: string): MarkdownLinkContextMenuResult {
    try {
      this.deps.writeText(resolveMarkdownLinkCopyTarget(target));
      return { status: "link-copied" };
    } catch {
      return { status: "failed", message: LINK_COPY_FAILED_MESSAGE };
    }
  }

  async showContextMenu(
    window: BrowserWindow | null,
    request: MarkdownLinkContextMenuRequest,
  ): Promise<MarkdownLinkContextMenuResult> {
    if (!window) {
      return Promise.resolve({ status: "failed", message: LINK_CONTEXT_MENU_FAILED_MESSAGE });
    }

    const copyableFile = request.fileContext
      ? await this.deps.resolveCopyableFile(request)
      : null;
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      const settle = (result: MarkdownLinkContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const copyAndSettle = () => {
        if (!settled) {
          selectionStarted = true;
          settle(this.copyTarget(request.target));
        }
      };

      try {
        const template: MenuItemConstructorOptions[] = [{
          label: "リンクをコピー",
          click: copyAndSettle,
        }];
        if (copyableFile) {
          template.push({
            label: "ファイルをコピー",
            click: () => {
              if (!settled) {
                selectionStarted = true;
                void this.deps.copyFile(copyableFile).then((result) => {
                  settle({ status: "file-copy", result });
                }).catch(() => {
                  settle({
                    status: "file-copy",
                    result: { status: "failed", message: "File could not be copied." },
                  });
                });
              }
            },
          });
        }
        const menu = this.deps.buildMenu(template);
        menu.popup({
          window,
          x: request.point.x,
          y: request.point.y,
          callback: () => {
            if (!selectionStarted) {
              settle({ status: "dismissed" });
            }
          },
        });
      } catch {
        settle({ status: "failed", message: LINK_CONTEXT_MENU_FAILED_MESSAGE });
      }
    });
  }
}
