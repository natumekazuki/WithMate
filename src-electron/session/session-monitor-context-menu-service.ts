import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";

type SessionMonitorContextMenu = Pick<Menu, "popup">;

export type SessionMonitorContextMenuServiceDeps = {
  isSessionWindowOpen(sessionId: string): boolean;
  requestCloseSessionWindow(sessionId: string): Promise<boolean>;
  readSessionTitle(sessionId: string): Promise<string | null>;
  writeText(value: string): void;
  buildMenu(template: MenuItemConstructorOptions[]): SessionMonitorContextMenu;
};

const MENU_FAILED_MESSAGE = "Session Monitor menu could not be opened.";

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
      const closeTarget = (): Promise<boolean> => this.deps.requestCloseSessionWindow(request.sessionId);
      const copyText = async (readText: () => string | Promise<string | null>, failureMessage: string) => {
        if (settled || selectionStarted) {
          return;
        }
        selectionStarted = true;
        try {
          const text = await readText();
          if (text === null) {
            settle({ status: "failed", message: failureMessage });
            return;
          }
          this.deps.writeText(text);
          settle({ status: "copied" });
        } catch {
          settle({ status: "failed", message: failureMessage });
        }
      };
      const template: MenuItemConstructorOptions[] = [{
        label: "Close",
        enabled: this.deps.isSessionWindowOpen(request.sessionId),
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
        label: "Copy Session ID",
        click: () => { void copyText(() => request.sessionId, "Session ID could not be copied."); },
      }, {
        label: "Copy Session Title",
        click: () => {
          void copyText(() => this.deps.readSessionTitle(request.sessionId), "Session title could not be copied.");
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
