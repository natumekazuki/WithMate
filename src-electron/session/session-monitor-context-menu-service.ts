import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";

/** 実際のメニュー表示に使うネイティブ popup だけを必要とする部分インターフェース。 */
type SessionMonitorContextMenu = Pick<Menu, "popup">;

/** 現在の Window と保存タイトルの確認、閉じる操作、クリップボード、メニュー表示を担う依存。 */
export type SessionMonitorContextMenuServiceDeps = {
  /** 指定 Session の Window が現在開いており、閉じる候補にできるかを返す。 */
  isSessionWindowOpen(sessionId: string): boolean;
  /** 指定 Session の Window を閉じる手続きを開始し、閉じなかった場合は false を返す。 */
  requestCloseSessionWindow(sessionId: string): Promise<boolean>;
  /** 選択した Session の最新の保存タイトルを返す。取得できなければ null。 */
  readSessionTitle(sessionId: string): Promise<string | null>;
  /** 選択された文字列をシステムのクリップボードへ書く。 */
  writeText(value: string): void;
  /** 操作に対応する項目からネイティブメニューを組み立てる。 */
  buildMenu(template: MenuItemConstructorOptions[]): SessionMonitorContextMenu;
};

const MENU_FAILED_MESSAGE = "Session Monitor menu could not be opened.";

/** Session モニターの操作をメニューで受け付け、利用者が選んだ操作と実際の結果を対応付ける。 */
export class SessionMonitorContextMenuService {
  /** Window の照会・操作とネイティブメニューの生成を、それぞれ依存として取得する。 */
  constructor(private readonly deps: SessionMonitorContextMenuServiceDeps) {}

  /** 指定 Window の座標にメニューを開き、一つの操作結果または閉じただけの結果を返す。 */
  showContextMenu(
    window: BrowserWindow | null,
    request: SessionMonitorContextMenuRequest,
  ): Promise<SessionMonitorContextMenuResult> {
    if (!window) {
      return Promise.resolve({
        status: "failed",
        message: MENU_FAILED_MESSAGE,
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      /** 選択・dismiss・失敗が競合しても、先に確定した一件だけを呼び出し元へ返す。 */
      const settle = (result: SessionMonitorContextMenuResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      /** 現在選択されている対象 Session ID で閉じる処理を要求する。 */
      const closeTarget = (): Promise<boolean> =>
        this.deps.requestCloseSessionWindow(request.sessionId);
      /** 他の操作が始まっていなければコピーを試み、読み込みや書き込みの失敗を結果へ反映する。 */
      const copyText = async (
        readText: () => string | Promise<string | null>,
        failureMessage: string,
      ) => {
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
      const template: MenuItemConstructorOptions[] = [
        {
          label: "Close",
          enabled: this.deps.isSessionWindowOpen(request.sessionId),
          /** 閉じる操作を一件だけ開始し、実際に閉じなかった場合はキャンセルと同じ結果にする。 */
          click: () => {
            if (settled || selectionStarted) {
              return;
            }
            selectionStarted = true;
            void Promise.resolve()
              .then(async () => await closeTarget())
              .then((closed) => {
                settle(
                  closed === false
                    ? { status: "dismissed" }
                    : { status: "closed" },
                );
              })
              .catch(() =>
                settle({ status: "failed", message: MENU_FAILED_MESSAGE }),
              );
          },
        },
        { type: "separator" },
        {
          label: "Copy Session ID",
          /** 選択された Session の ID をそのままコピーする。 */
          click: () => {
            void copyText(
              () => request.sessionId,
              "Session ID could not be copied.",
            );
          },
        },
        {
          label: "Copy Session Title",
          /** 選択された Session のタイトルをクリック時に取得してコピーする。 */
          click: () => {
            void copyText(
              () => this.deps.readSessionTitle(request.sessionId),
              "Session title could not be copied.",
            );
          },
        },
      ];

      try {
        const menu = this.deps.buildMenu(template);
        menu.popup({
          window,
          x: request.point.x,
          y: request.point.y,
          /** 利用者が項目を選ばず閉じた場合だけ dismissed を返し、進行中の操作結果を上書きしない。 */
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
