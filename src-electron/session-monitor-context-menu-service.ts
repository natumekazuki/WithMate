import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../src/withmate-window-types.js";

type SessionMonitorContextMenu = Pick<Menu, "popup">;

export type SessionMonitorContextMenuServiceDeps = {
  requestCloseSessionWindow(sessionId: string): Promise<boolean>;
  closeCompanionReviewWindow(sessionId: string): void;
  writeText(value: string): void;
  buildMenu(template: MenuItemConstructorOptions[]): SessionMonitorContextMenu;
};

const MENU_FAILED_MESSAGE = "Session Monitorのメニューを開けませんでした。";
const COPY_FAILED_MESSAGE = "Session IDをコピーできませんでした。";

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
      const closeTarget = (): void | Promise<boolean> => {
        if (request.kind === "agent") {
          return this.deps.requestCloseSessionWindow(request.sessionId);
        }
        return this.deps.closeCompanionReviewWindow(request.sessionId);
      };
      const copySessionId = () => {
        if (settled || selectionStarted) {
          return;
        }
        selectionStarted = true;
        try {
          this.deps.writeText(request.sessionId);
          settle({ status: "copied" });
        } catch {
          settle({ status: "failed", message: COPY_FAILED_MESSAGE });
        }
      };
      const template: MenuItemConstructorOptions[] = [{
        label: "閉じる",
        click: () => {
          if (settled || selectionStarted) {
            return;
          }
          selectionStarted = true;
          void Promise.resolve()
            .then(async () => await closeTarget())
            .then((closed) => {
              settle(closed === false ? { status: "dismissed" } : { status: "closed" });
            })
            .catch(() => settle({ status: "failed", message: MENU_FAILED_MESSAGE }));
        },
      }, { type: "separator" }, {
        label: "Session IDをコピー",
        click: copySessionId,
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
