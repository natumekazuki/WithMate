import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../src-shared/window/markdown-link-context-menu.js";
import type { SessionFileResourceRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileObjectCopyResult } from "../../src-shared/file-explorer/session-file-object-copy-contract.js";
import { resolveMarkdownLinkCopyTarget } from "../files/open-path.js";

/** 作成したリンクメニューを指定のウィンドウと座標に表示する操作。 */
type LinkContextMenu = Pick<Menu, "popup">;

/** ネイティブメニューと、リンク文字列・ファイルのクリップボード書き込みを接続する。 */
export type MarkdownLinkContextMenuServiceDeps = {
  /** 利用可能なコピー操作からネイティブメニューを構築する。 */
  buildMenu(template: MenuItemConstructorOptions[]): LinkContextMenu;
  /** 解決済みのリンク文字列をクリップボードへ書く。 */
  writeText(target: string): void;
  /** リンクの文脈から、ファイルとしてコピー可能なリソースを解決する。 */
  resolveCopyableFile(
    request: MarkdownLinkContextMenuRequest,
  ): Promise<SessionFileResourceRequest | null>;
  /** 解決済みのリソースをファイルとしてコピーし、その成否を返す。 */
  copyFile(
    resource: SessionFileResourceRequest,
  ): Promise<SessionFileObjectCopyResult>;
};

const LINK_COPY_FAILED_MESSAGE = "Link could not be copied.";
const LINK_CONTEXT_MENU_FAILED_MESSAGE =
  "Link context menu could not be opened.";

/** リンクコピーを提供し、コピー可能なファイルを解決できた場合だけファイルコピーも表示する。 */
export class MarkdownLinkContextMenuService {
  /** メニュー、ファイル解決、クリップボードの具体的な処理を受け取る。 */
  constructor(private readonly deps: MarkdownLinkContextMenuServiceDeps) {}

  /** コピー先の文字列を正規化して書き込み、解決・書き込みの例外を失敗結果に変換する。 */
  private copyTarget(target: string): MarkdownLinkContextMenuResult {
    try {
      this.deps.writeText(resolveMarkdownLinkCopyTarget(target));
      return { status: "link-copied" };
    } catch {
      return { status: "failed", message: LINK_COPY_FAILED_MESSAGE };
    }
  }

  /** 所有ウィンドウの指定位置にメニューを出し、選択したコピーの結果か未選択での閉鎖を返す。 */
  async showContextMenu(
    window: BrowserWindow | null,
    request: MarkdownLinkContextMenuRequest,
  ): Promise<MarkdownLinkContextMenuResult> {
    if (!window) {
      return Promise.resolve({
        status: "failed",
        message: LINK_CONTEXT_MENU_FAILED_MESSAGE,
      });
    }

    const copyableFile = request.fileContext
      ? await this.deps.resolveCopyableFile(request)
      : null;
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      /** 最初に確定した結果だけを返し、遅れて到着する通知は無視する。 */
      const settle = (result: MarkdownLinkContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      /** 未確定のメニューでリンクコピーが選ばれたときだけ、クリップボードを変更する。 */
      const copyAndSettle = () => {
        if (!settled) {
          selectionStarted = true;
          settle(this.copyTarget(request.target));
        }
      };

      try {
        const template: MenuItemConstructorOptions[] = [
          {
            label: "Copy Link",
            click: copyAndSettle,
          },
        ];
        if (copyableFile) {
          template.push({
            label: "Copy File",
            /** 解決済みのファイルをコピーし、その非同期結果でメニューの応答を確定する。 */
            click: () => {
              if (!settled) {
                selectionStarted = true;
                void this.deps
                  .copyFile(copyableFile)
                  .then((result) => {
                    settle({ status: "file-copy", result });
                  })
                  .catch(() => {
                    settle({
                      status: "file-copy",
                      result: {
                        status: "failed",
                        message: "File could not be copied.",
                      },
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
          /** コピー開始前の閉鎖だけを未選択として処理し、進行中のコピー完了を待つ。 */
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
