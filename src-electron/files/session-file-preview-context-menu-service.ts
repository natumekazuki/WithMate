import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import type {
  SessionFilePreviewContextMenuRequest,
  SessionFilePreviewContextMenuResult,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

export class SessionFilePreviewContextMenuService {
  constructor(private readonly deps: {
    buildMenu(template: MenuItemConstructorOptions[]): Pick<Menu, "popup">;
  }) {}

  async showContextMenu(
    window: BrowserWindow | null,
    request: SessionFilePreviewContextMenuRequest,
  ): Promise<SessionFilePreviewContextMenuResult> {
    if (!window) throw new Error("File Preview context menu window is unavailable.");
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: SessionFilePreviewContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const menu = this.deps.buildMenu([{
        label: request.scope === "preview" ? "Close" : "Close All",
        click: () => settle("close"),
      }]);
      menu.popup({
        window,
        x: request.point.x,
        y: request.point.y,
        callback: () => settle("dismissed"),
      });
    });
  }
}
