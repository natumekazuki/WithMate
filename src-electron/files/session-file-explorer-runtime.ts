import { FileRootGitChangesService } from "./file-root-git-changes-service.js";
import { SessionFileExplorerService, type SessionFileExplorerContext } from "./session-file-explorer-service.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";

export type SessionFileExplorerRuntimeDeps = {
  userDataPath: string;
  getSessionContext(sessionId: string): Promise<SessionFileExplorerContext | null>;
  openResolvedPath(targetPath: string, reveal: boolean): Promise<OpenPathResult>;
};

/** Owns the shared authorization boundary for session files and git-root operations. */
export class SessionFileExplorerRuntime {
  private readonly explorer: SessionFileExplorerService;
  private readonly gitChanges: FileRootGitChangesService;

  public constructor(deps: SessionFileExplorerRuntimeDeps) {
    this.explorer = new SessionFileExplorerService({
      userDataPath: deps.userDataPath,
      getSessionContext: deps.getSessionContext,
      openResolvedPath: deps.openResolvedPath,
    });
    this.gitChanges = new FileRootGitChangesService({
      resolveRootContext: async (request) => {
        const root = await this.explorer.resolveRoot(request.sessionId, request.rootId);
        return root ? { rootPath: root.absolutePath } : null;
      },
      resolveHistoryRootContexts: async (sessionId) => (await this.explorer.resolveHistoryRoots(sessionId)).map((root) => ({
        rootId: root.id,
        label: root.label,
        displayPath: root.displayPath,
        rootPath: root.absolutePath,
      })),
      resolveHistoryRootContext: async (request) => {
        const root = await this.explorer.resolveHistoryRoot(request.sessionId, request.rootId);
        return root ? { rootPath: root.absolutePath } : null;
      },
    });
  }

  public getExplorer(): SessionFileExplorerService {
    return this.explorer;
  }

  public getGitChanges(): FileRootGitChangesService {
    return this.gitChanges;
  }
}
