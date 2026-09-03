import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type {
  SessionFileTreePathActionContextMenuResult,
  SessionFileTreePathActionRequest,
  SessionFileTreePathActionTargetRequest,
} from "../src/file-explorer/file-explorer-contract.js";
import type { SessionFileObjectCopyResult } from "../src/file-explorer/session-file-object-copy-contract.js";

type FileTreeContextMenu = Pick<Menu, "popup">;

type SessionFileTreeAuthorizationBoundary = {
  resolvePathActionTarget(request: SessionFileTreePathActionTargetRequest): Promise<string>;
};

export type SessionFileTreeContextMenuServiceDeps = {
  platform: NodeJS.Platform;
  createAuthorizationBoundary(): SessionFileTreeAuthorizationBoundary;
  writeText(targetPath: string): void;
  copyFileObject(request: {
    sessionId: string;
    rootId: string;
    relativePath: string;
  }): Promise<SessionFileObjectCopyResult>;
  buildMenu(template: MenuItemConstructorOptions[]): FileTreeContextMenu;
};

const PATH_ACTION_FAILED_MESSAGE = "Path action failed.";
const FILE_COPY_FAILED_MESSAGE = "File could not be copied.";
const MENU_FAILED_MESSAGE = "Path menu could not be opened.";

export class SessionFileTreeContextMenuService {
  constructor(private readonly deps: SessionFileTreeContextMenuServiceDeps) {}

  async showContextMenu(
    window: BrowserWindow | null,
    request: SessionFileTreePathActionRequest,
  ): Promise<SessionFileTreePathActionContextMenuResult> {
    if (!window) {
      return { status: "failed", message: MENU_FAILED_MESSAGE };
    }

    const targetRequest = this.toTargetRequest(request);
    try {
      await this.deps.createAuthorizationBoundary().resolvePathActionTarget(targetRequest);
    } catch {
      return { status: "failed", message: PATH_ACTION_FAILED_MESSAGE };
    }

    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      const settle = (result: SessionFileTreePathActionContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const beginSelection = (): boolean => {
        if (settled || selectionStarted) {
          return false;
        }
        selectionStarted = true;
        return true;
      };
      const resolveCurrentTarget = () => (
        this.deps.createAuthorizationBoundary().resolvePathActionTarget(targetRequest)
      );
      const template: MenuItemConstructorOptions[] = [
        {
          label: "パスをコピー",
          click: () => {
            if (!beginSelection()) {
              return;
            }
            void resolveCurrentTarget()
              .then((targetPath) => {
                this.deps.writeText(targetPath);
                settle({ status: "copied-path" });
              })
              .catch(() => settle({ status: "failed", message: PATH_ACTION_FAILED_MESSAGE }));
          },
        },
        {
          label: "プロンプトにパスを挿入",
          enabled: request.canInsert,
          click: () => {
            if (!request.canInsert || !beginSelection()) {
              return;
            }
            void resolveCurrentTarget()
              .then((absolutePath) => settle({
                status: "insert-path",
                ownerSessionId: request.sessionId,
                absolutePath,
              }))
              .catch(() => settle({ status: "failed", message: PATH_ACTION_FAILED_MESSAGE }));
          },
        },
      ];
      if (this.deps.platform === "win32" && request.nodeKind === "file") {
        template.push(
          { type: "separator" },
          {
            label: "ファイルをコピー",
            click: () => {
              if (!beginSelection()) {
                return;
              }
              void this.deps.copyFileObject({
                sessionId: request.sessionId,
                rootId: request.rootId,
                relativePath: request.relativePath,
              }).then((result) => {
                settle(result.status === "copied"
                  ? { status: "copied-file" }
                  : { status: "failed", message: result.message || FILE_COPY_FAILED_MESSAGE });
              }).catch(() => settle({ status: "failed", message: FILE_COPY_FAILED_MESSAGE }));
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

  private toTargetRequest(request: SessionFileTreePathActionRequest): SessionFileTreePathActionTargetRequest {
    return {
      sessionId: request.sessionId,
      rootId: request.rootId,
      relativePath: request.relativePath,
      nodeKind: request.nodeKind,
    };
  }
}
