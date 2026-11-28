import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionFileTreePathActionContextMenuResult,
  SessionFileTreePathActionRequest,
  SessionFileTreePathActionTargetRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileObjectCopyResult } from "../../src-shared/file-explorer/session-file-object-copy-contract.js";

/** ファイルツリー上の指定位置に表示するネイティブメニュー。 */
type FileTreeContextMenu = Pick<Menu, "popup">;

/** ツリー項目を認可し、パス操作の対象を解決する境界。 */
type SessionFileTreeAuthorizationBoundary = {
  /** Session、ルート、相対パス、種別から操作可能な現在の絶対パスを返す。 */
  resolvePathActionTarget(
    request: SessionFileTreePathActionTargetRequest,
  ): Promise<string>;
};

/** ツリーの認可、クリップボード操作、メニュー表示を委ねる依存先。 */
export type SessionFileTreeContextMenuServiceDeps = {
  platform: NodeJS.Platform;
  /** メニュー表示時と操作時に対象を検査するための認可境界を用意する。 */
  createAuthorizationBoundary(): SessionFileTreeAuthorizationBoundary;
  /** 認可済みパスをクリップボードのテキストに書き込む。 */
  writeText(targetPath: string): void;
  /** ツリー上のファイルをクリップボードでファイルオブジェクトとして扱えるようにする。 */
  copyFileObject(request: {
    sessionId: string;
    rootId: string;
    relativePath: string;
  }): Promise<SessionFileObjectCopyResult>;
  /** 提示する操作を組み立てたネイティブメニューを返す。 */
  buildMenu(template: MenuItemConstructorOptions[]): FileTreeContextMenu;
};

const PATH_ACTION_FAILED_MESSAGE = "Path action failed.";
const FILE_COPY_FAILED_MESSAGE = "File could not be copied.";
const MENU_FAILED_MESSAGE = "Path menu could not be opened.";

/** ファイルツリーの項目に応じたメニューを表示し、実行時にも対象を認可する。 */
export class SessionFileTreeContextMenuService {
  /** 対象の再解決、クリップボード操作、ネイティブメニューに必要な依存先を受け取る。 */
  constructor(private readonly deps: SessionFileTreeContextMenuServiceDeps) {}

  /** 項目を認可してからパス操作を示し、Windows のファイルにはファイルコピーも示す。 */
  async showContextMenu(
    window: BrowserWindow | null,
    request: SessionFileTreePathActionRequest,
  ): Promise<SessionFileTreePathActionContextMenuResult> {
    if (!window) {
      return { status: "failed", message: MENU_FAILED_MESSAGE };
    }

    const targetRequest = this.toTargetRequest(request);
    try {
      await this.deps
        .createAuthorizationBoundary()
        .resolvePathActionTarget(targetRequest);
    } catch {
      return { status: "failed", message: PATH_ACTION_FAILED_MESSAGE };
    }

    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      /** 選択結果、取消、表示失敗のいずれかで一度だけ応答する。 */
      const settle = (result: SessionFileTreePathActionContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      /** 最初の選択操作だけを開始し、結果を待つ間に閉鎖通知で取り消されないようにする。 */
      const beginSelection = (): boolean => {
        if (settled || selectionStarted) {
          return false;
        }
        selectionStarted = true;
        return true;
      };
      /** 表示時に解決したパスを使い回さず、操作直前の項目を認可して解決する。 */
      const resolveCurrentTarget = () =>
        this.deps
          .createAuthorizationBoundary()
          .resolvePathActionTarget(targetRequest);
      const template: MenuItemConstructorOptions[] = [
        {
          label: "Copy Path",
          /** 項目を再認可し、解決したパスをクリップボードへ書き込む。 */
          click: () => {
            if (!beginSelection()) {
              return;
            }
            void resolveCurrentTarget()
              .then((targetPath) => {
                this.deps.writeText(targetPath);
                settle({ status: "copied-path" });
              })
              .catch(() =>
                settle({
                  status: "failed",
                  message: PATH_ACTION_FAILED_MESSAGE,
                }),
              );
          },
        },
        {
          label: "Insert Path",
          enabled: request.canInsert,
          /** 挿入可能な場合だけ、認可した絶対パスと対象 Session を呼び出し元へ返す。 */
          click: () => {
            if (!request.canInsert || !beginSelection()) {
              return;
            }
            void resolveCurrentTarget()
              .then((absolutePath) =>
                settle({
                  status: "insert-path",
                  ownerSessionId: request.sessionId,
                  absolutePath,
                }),
              )
              .catch(() =>
                settle({
                  status: "failed",
                  message: PATH_ACTION_FAILED_MESSAGE,
                }),
              );
          },
        },
      ];
      if (this.deps.platform === "win32" && request.nodeKind === "file") {
        template.push(
          { type: "separator" },
          {
            label: "Copy File",
            /** 現在のツリー項目を確認してからファイルオブジェクトのコピーを開始する。 */
            click: () => {
              if (!beginSelection()) {
                return;
              }
              void resolveCurrentTarget()
                .then(() =>
                  this.deps.copyFileObject({
                    sessionId: request.sessionId,
                    rootId: request.rootId,
                    relativePath: request.relativePath,
                  }),
                )
                .then((result) => {
                  settle(
                    result.status === "copied"
                      ? { status: "copied-file" }
                      : {
                          status: "failed",
                          message: result.message || FILE_COPY_FAILED_MESSAGE,
                        },
                  );
                })
                .catch(() =>
                  settle({
                    status: "failed",
                    message: FILE_COPY_FAILED_MESSAGE,
                  }),
                );
            },
          },
        );
      }

      try {
        const menu = this.deps.buildMenu(template);
        menu.popup({
          window,
          x: request.point.x,
          y: request.point.y,
          /** 項目の操作を開始していない場合だけ、メニュー閉鎖を取消として返す。 */
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

  /** 表示座標や挿入可否を除き、対象を認可するための情報だけを取り出す。 */
  private toTargetRequest(
    request: SessionFileTreePathActionRequest,
  ): SessionFileTreePathActionTargetRequest {
    return {
      sessionId: request.sessionId,
      rootId: request.rootId,
      relativePath: request.relativePath,
      nodeKind: request.nodeKind,
    };
  }
}
