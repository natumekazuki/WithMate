import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import type {
  SessionFilePreviewContextMenuRequest,
  SessionFilePreviewContextMenuResult,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

/** プレビュー一覧の閉じる操作をネイティブメニューで提示し、選択結果を呼び出し元へ返す。 */
export class SessionFilePreviewContextMenuService {
  /** ネイティブメニューを生成する処理を受け取る。 */
  constructor(
    private readonly deps: {
      /** 閉じる操作のメニュー項目から、指定座標に表示できるメニューを作る。 */
      buildMenu(template: MenuItemConstructorOptions[]): Pick<Menu, "popup">;
    },
  ) {}

  /** 対象範囲に応じて一件または全件の閉鎖を提示し、選択と取消を区別する。 */
  async showContextMenu(
    window: BrowserWindow | null,
    request: SessionFilePreviewContextMenuRequest,
  ): Promise<SessionFilePreviewContextMenuResult> {
    if (!window)
      throw new Error("File Preview context menu window is unavailable.");
    return new Promise((resolve) => {
      let settled = false;
      /** 項目選択後のメニュー閉鎖で、選択結果が取り消されないようにする。 */
      const settle = (result: SessionFilePreviewContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const menu = this.deps.buildMenu([
        {
          label: request.scope === "preview" ? "Close" : "Close All",
          /** 閉鎖操作が選択されたことを返し、実際の閉鎖は呼び出し元に委ねる。 */
          click: () => settle("close"),
        },
      ]);
      menu.popup({
        window,
        x: request.point.x,
        y: request.point.y,
        /** 項目が選択されないまま閉じた場合の結果を確定する。 */
        callback: () => settle("dismissed"),
      });
    });
  }
}
