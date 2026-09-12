import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../src/withmate-window-types.js";

type SessionMonitorContextMenu = Pick<Menu, "popup">;

export type SessionMonitorContextMenuServiceDeps = {
  requestCloseSessionWindow(sessionId: string): void;
  closeCompanionReviewWindow(sessionId: string): void;
  buildMenu(template: MenuItemConstructorOptions[]): SessionMonitorContextMenu;
};

const MENU_FAILED_MESSAGE = "Session Monitorのメニューを開けませんでした。";

export class SessionMonitorContextMenuService {
  constructor(private readonly deps: SessionMonitorContextMenuServiceDeps) {}

  showContextMenu(
    window: BrowserWindow | null,
    request: SessionMonitorContextMenuRequest,
  ): Promise<SessionMonitorContextMenuResult> {
    if (!window) {
      return Promise.resolve({ status: "failed", message: MENU_FAILED_MESSAGE });
    }

    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      const settle = (result: SessionMonitorContextMenuResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      const closeTarget = () => {
        if (request.kind === "agent") {
          this.deps.requestCloseSessionWindow(request.sessionId);
        } else {
          this.deps.closeCompanionReviewWindow(request.sessionId);
        }
      };
      const template: MenuItemConstructorOptions[] = [{
        label: "閉じる",
        click: () => {
          if (settled || selectionStarted) {
            return;
          }
          selectionStarted = true;
          try {
            closeTarget();
            settle({ status: "closed" });
          } catch {
            settle({ status: "failed", message: MENU_FAILED_MESSAGE });
          }
        },
      }];

      try {
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
        settle({ status: "failed", message: MENU_FAILED_MESSAGE });
      }
    });
  }
}
