import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyLinkRequest,
  SessionFileObjectCopyResult,
} from "../src/file-explorer/session-file-object-copy-contract.js";
import type {
  SessionFilePreviewTargetResolution,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRootResourceRequest,
} from "../src/file-explorer/file-explorer-contract.js";
import { isSessionFileRootResource } from "../src/file-explorer/file-explorer-contract.js";
import type { AuthorizedSessionFileOperationResult } from "./session-file-explorer-service.js";
import type { NativeFileDropWriteResult } from "./windows-file-drop-clipboard-writer.js";

type FileCopyContextMenu = Pick<Menu, "popup">;

type SessionFileAuthorizationBoundary = {
  resolvePreviewTarget(
    sessionId: string,
    target: string,
    baseResource?: SessionFilePreviewResourceRequest,
  ): Promise<SessionFilePreviewTargetResolution>;
  withAuthorizedFilePath<T>(
    request: SessionFileResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>>;
  withAuthorizedTreeFilePath?<T>(
    request: SessionFileRootResourceRequest,
    operation: (targetRealPath: string) => Promise<T>,
  ): Promise<AuthorizedSessionFileOperationResult<T>>;
};

export type SessionFileObjectCopyServiceDeps = {
  platform: NodeJS.Platform;
  createAuthorizationBoundary(): SessionFileAuthorizationBoundary;
  writeNativeFileDrop(targetPath: string): Promise<NativeFileDropWriteResult>;
  buildMenu?(template: MenuItemConstructorOptions[]): FileCopyContextMenu;
};

const FILE_COPIED_MESSAGE = "File copied.";
const FILE_NOT_COPYABLE_MESSAGE = "This target cannot be copied as a file.";
const FILE_COPY_FAILED_MESSAGE = "File could not be copied.";
const FILE_COPY_EFFECT_UNKNOWN_MESSAGE = "File copy status is unknown. Check the clipboard before trying again.";
const FILE_COPY_MENU_FAILED_MESSAGE = "File copy menu could not be opened.";

export class SessionFileObjectCopyService {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionFileObjectCopyServiceDeps) {}

  isAvailable(): boolean {
    return this.deps.platform === "win32";
  }

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
      if (resolution.type !== "file" || !isSessionFileRootResource(resolution.resource)) {
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

  copyResource(resource: SessionFileResourceRequest): Promise<SessionFileObjectCopyResult> {
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
      if (operation.result.status === "copied" && operation.targetStillCurrent) {
        return { status: "copied", message: FILE_COPIED_MESSAGE };
      }
      return { status: "effect-unknown", message: FILE_COPY_EFFECT_UNKNOWN_MESSAGE };
    });
  }

  copyTreeResource(resource: SessionFileRootResourceRequest): Promise<SessionFileObjectCopyResult> {
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
      if (operation.result.status === "copied" && operation.targetStillCurrent) {
        return { status: "copied", message: FILE_COPIED_MESSAGE };
      }
      return { status: "effect-unknown", message: FILE_COPY_EFFECT_UNKNOWN_MESSAGE };
    });
  }

  showContextMenu(
    window: BrowserWindow | null,
    request: SessionFileObjectCopyContextMenuRequest,
  ): Promise<SessionFileObjectCopyContextMenuResult> {
    if (!window || !this.isAvailable() || !this.deps.buildMenu) {
      return Promise.resolve({ status: "failed", message: FILE_COPY_MENU_FAILED_MESSAGE });
    }
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      const settle = (result: SessionFileObjectCopyContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      try {
        const menu = this.deps.buildMenu!([{
          label: "ファイルをコピー",
          click: () => {
            if (!settled) {
              selectionStarted = true;
              void this.copyResource(request.resource)
                .then(settle)
                .catch(() => settle({ status: "failed", message: FILE_COPY_FAILED_MESSAGE }));
            }
          },
        }]);
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
        settle({ status: "failed", message: FILE_COPY_MENU_FAILED_MESSAGE });
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isNotCopyableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /(?:is not a file|file ではない|path は file ではない)/iu.test(message);
}
