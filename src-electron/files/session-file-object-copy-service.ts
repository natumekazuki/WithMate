import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyLinkRequest,
  SessionFileObjectCopyResult,
} from "../../src-shared/file-explorer/session-file-object-copy-contract.js";
import type {
  SessionFilePreviewTargetResolution,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRootResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { AuthorizedSessionFileOperationResult } from "./session-file-explorer-service.js";
import type { NativeFileDropWriteResult } from "./windows-file-drop-clipboard-writer.js";

/** 対象ウィンドウと指定座標に表示できるネイティブメニュー。 */
type FileCopyContextMenu = Pick<Menu, "popup">;

/** リンク解決と、認可済みの実ファイルパスに対する操作を担う境界。 */
type SessionFileAuthorizationBoundary = {
  /** 参照元を基準にリンクを解決し、ファイルに限らず解決先の種別を返す。 */
  resolvePreviewTarget(
    sessionId: string,
    target: string,
    baseResource?: SessionFilePreviewResourceRequest,
  ): Promise<SessionFilePreviewTargetResolution>;
  /** プレビュー対象を認可してから操作し、操作後も同じ対象であるかを結果に添える。 */
  withAuthorizedFilePath<T>(
    request: SessionFileResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>>;
  /** ファイルツリーからの要求を認可し、実パスで操作した後に対象の有効性を確認する。 */
  withAuthorizedTreeFilePath?<T>(
    request: SessionFileRootResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>>;
};

/** 実行環境、ファイル認可、ネイティブクリップボード、メニュー表示の依存先。 */
export type SessionFileObjectCopyServiceDeps = {
  platform: NodeJS.Platform;
  /** 操作時点で対象を確認するための認可境界を用意する。 */
  createAuthorizationBoundary(): SessionFileAuthorizationBoundary;
  /** 認可済みの実パスを単一ファイルのドロップ形式で書き込み、確認結果を返す。 */
  writeNativeFileDrop(targetPath: string): Promise<NativeFileDropWriteResult>;
  /** ファイルコピー操作を選べるメニューを構築する。 */
  buildMenu?(template: MenuItemConstructorOptions[]): FileCopyContextMenu;
};

const FILE_COPIED_MESSAGE = "File copied.";
const FILE_NOT_COPYABLE_MESSAGE = "This target cannot be copied as a file.";
const FILE_COPY_FAILED_MESSAGE = "File could not be copied.";
const FILE_COPY_EFFECT_UNKNOWN_MESSAGE =
  "File copy status is unknown. Check the clipboard before trying again.";
const FILE_COPY_MENU_FAILED_MESSAGE = "File copy menu could not be opened.";

/** Windows のファイルオブジェクトコピーを直列化し、認可と書き込み確認を取りまとめる。 */
export class SessionFileObjectCopyService {
  private operationTail: Promise<void> = Promise.resolve();

  /** コピー要求で使う認可境界、書き込み処理、必要に応じたメニュー生成を受け取る。 */
  constructor(private readonly deps: SessionFileObjectCopyServiceDeps) {}

  /** ネイティブファイルコピーを提供する Windows で実行中かを返す。 */
  isAvailable(): boolean {
    return this.deps.platform === "win32";
  }

  /** リンクが認可済みの現行ファイルを指す場合だけ、コピー候補となるリソースを返す。 */
  async resolveCopyableLinkResource(
    request: SessionFileObjectCopyLinkRequest,
  ): Promise<SessionFileResourceRequest | null> {
    if (!this.isAvailable()) {
      return null;
    }
    try {
      const authorization = this.deps.createAuthorizationBoundary();
      const resolution = await authorization.resolvePreviewTarget(
        request.sessionId,
        request.target,
        request.baseResource,
      );
      if (resolution.type !== "file") {
        return null;
      }
      const confirmation = await authorization.withAuthorizedFilePath(
        resolution.resource,
        async () => undefined,
      );
      return confirmation.targetStillCurrent ? resolution.resource : null;
    } catch {
      return null;
    }
  }

  /** プレビューのファイルを再認可してコピーし、書き込み前の失敗と書き込み結果が不明な場合を区別する。 */
  copyResource(
    resource: SessionFileResourceRequest,
  ): Promise<SessionFileObjectCopyResult> {
    return this.enqueue(async () => {
      if (!this.isAvailable()) {
        return { status: "not-copyable", message: FILE_NOT_COPYABLE_MESSAGE };
      }
      let operation: AuthorizedSessionFileOperationResult<NativeFileDropWriteResult>;
      try {
        const authorization = this.deps.createAuthorizationBoundary();
        operation = await authorization.withAuthorizedFilePath(
          resource,
          (targetRealPath) => this.deps.writeNativeFileDrop(targetRealPath),
        );
      } catch (error) {
        return isNotCopyableFileError(error)
          ? { status: "not-copyable", message: FILE_NOT_COPYABLE_MESSAGE }
          : { status: "failed", message: FILE_COPY_FAILED_MESSAGE };
      }

      if (operation.result.status === "failed-before-write") {
        return { status: "failed", message: FILE_COPY_FAILED_MESSAGE };
      }
      if (
        operation.result.status === "copied" &&
        operation.targetStillCurrent
      ) {
        return { status: "copied", message: FILE_COPIED_MESSAGE };
      }
      return {
        status: "effect-unknown",
        message: FILE_COPY_EFFECT_UNKNOWN_MESSAGE,
      };
    });
  }

  /** ツリー項目を専用の境界で認可してコピーし、書き込み後も対象が同一の場合だけ成功を返す。 */
  copyTreeResource(
    resource: SessionFileRootResourceRequest,
  ): Promise<SessionFileObjectCopyResult> {
    return this.enqueue(async () => {
      if (!this.isAvailable()) {
        return { status: "not-copyable", message: FILE_NOT_COPYABLE_MESSAGE };
      }
      let operation: AuthorizedSessionFileOperationResult<NativeFileDropWriteResult>;
      try {
        const authorization = this.deps.createAuthorizationBoundary();
        if (!authorization.withAuthorizedTreeFilePath) {
          return { status: "failed", message: FILE_COPY_FAILED_MESSAGE };
        }
        operation = await authorization.withAuthorizedTreeFilePath(
          resource,
          (targetRealPath) => this.deps.writeNativeFileDrop(targetRealPath),
        );
      } catch {
        return { status: "failed", message: FILE_COPY_FAILED_MESSAGE };
      }

      if (operation.result.status === "failed-before-write") {
        return { status: "failed", message: FILE_COPY_FAILED_MESSAGE };
      }
      if (
        operation.result.status === "copied" &&
        operation.targetStillCurrent
      ) {
        return { status: "copied", message: FILE_COPIED_MESSAGE };
      }
      return {
        status: "effect-unknown",
        message: FILE_COPY_EFFECT_UNKNOWN_MESSAGE,
      };
    });
  }

  /** ファイルコピーをメニューに出し、選択後はメニューの閉鎖ではなくコピーの結果を返す。 */
  showContextMenu(
    window: BrowserWindow | null,
    request: SessionFileObjectCopyContextMenuRequest,
  ): Promise<SessionFileObjectCopyContextMenuResult> {
    if (!window || !this.isAvailable() || !this.deps.buildMenu) {
      return Promise.resolve({
        status: "failed",
        message: FILE_COPY_MENU_FAILED_MESSAGE,
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      /** 選択結果、取消、表示失敗のうち最初に確定した結果だけを返す。 */
      const settle = (result: SessionFileObjectCopyContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      try {
        const menu = this.deps.buildMenu!([
          {
            label: "Copy File",
            /** 選択された時点でファイルを再認可するコピー処理を開始する。 */
            click: () => {
              if (!settled) {
                selectionStarted = true;
                void this.copyResource(request.resource)
                  .then(settle)
                  .catch(() =>
                    settle({
                      status: "failed",
                      message: FILE_COPY_FAILED_MESSAGE,
                    }),
                  );
              }
            },
          },
        ]);
        menu.popup({
          window,
          x: request.point.x,
          y: request.point.y,
          /** 項目を選択せずに閉じたときだけ、取消を返す。 */
          callback: () => {
            if (!selectionStarted) {
              settle({ status: "dismissed" });
            }
          },
        });
      } catch {
        settle({ status: "failed", message: FILE_COPY_MENU_FAILED_MESSAGE });
      }
    });
  }

  /** 書き込みと読み戻しが前後のコピーと重ならないよう、前の処理の成否によらず順番に実行する。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** 認可境界のエラーから、対象が存在しないか通常のファイルでない場合を識別する。 */
function isNotCopyableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /(?:is not a file|file ではない|path は file ではない)/iu.test(
    message,
  );
}
