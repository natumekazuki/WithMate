import { FileRootGitChangesService } from "./file-root-git-changes-service.js";
import {
  SessionFileExplorerService,
  type SessionFileExplorerContext,
} from "./session-file-explorer-service.js";
import {
  SessionFilePreviewService,
  type SessionFilePreviewServiceDeps,
} from "./session-file-preview-service.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";
import type { SessionFilePinStorage } from "../storage/persistent-store-lifecycle-service.js";

/** ファイル一覧・Git・プレビューが共有するセッション参照と、OSやウィンドウへの接続。 */
export type SessionFileExplorerRuntimeDeps = Pick<
  SessionFilePreviewServiceDeps,
  "openPreviewWindow" | "openExternalUrl" | "openDirectory"
> & {
  userDataPath: string;
  /** 要求元の作業場所と許可されたルートを組み立てるための情報を取得する。 */
  getSessionContext(
    sessionId: string,
  ): Promise<SessionFileExplorerContext | null>;
  /** ファイルピン操作時に使用する保存先を取得する。 */
  getPinStorage?(): SessionFilePinStorage;
  /** 解決済みのパスをOSで開くか、格納場所を表示する。 */
  openResolvedPath(
    targetPath: string,
    reveal: boolean,
  ): Promise<OpenPathResult>;
};

/** Session ファイルと Git ルートの操作に共通する認可境界を担う。 */
export class SessionFileExplorerRuntime {
  private readonly explorer: SessionFileExplorerService;
  private readonly gitChanges: FileRootGitChangesService;
  private readonly preview: SessionFilePreviewService;

  /** Gitとプレビューが独自にルートを選ばないように、共通のファイル参照サービスへ接続する。 */
  public constructor(deps: SessionFileExplorerRuntimeDeps) {
    this.explorer = new SessionFileExplorerService({
      userDataPath: deps.userDataPath,
      getSessionContext: deps.getSessionContext,
      getPinStorage: deps.getPinStorage,
      openResolvedPath: deps.openResolvedPath,
    });
    this.gitChanges = new FileRootGitChangesService({
      /** 作業差分の要求に使えるルートを解決し、Git処理に絶対パスだけを渡す。 */
      resolveRootContext: async (request) => {
        const root = await this.explorer.resolveRoot(
          request.sessionId,
          request.rootId,
        );
        return root ? { rootPath: root.absolutePath } : null;
      },
      /** 履歴表示に使えるルート候補を、表示情報とGit処理用パスに変換する。 */
      resolveHistoryRootContexts: async (sessionId) =>
        (await this.explorer.resolveHistoryRoots(sessionId)).map((root) => ({
          rootId: root.id,
          label: root.label,
          displayPath: root.displayPath,
          rootPath: root.absolutePath,
        })),
      /** 選択されたルートが履歴参照に使える場合だけ、Git処理に絶対パスを渡す。 */
      resolveHistoryRootContext: async (request) => {
        const root = await this.explorer.resolveHistoryRoot(
          request.sessionId,
          request.rootId,
        );
        return root ? { rootPath: root.absolutePath } : null;
      },
    });
    this.preview = new SessionFilePreviewService({
      explorer: this.explorer,
      gitChanges: this.gitChanges,
      /** 補助セッションからのプレビューも、ファイル参照を所有する通常セッションに結び付ける。 */
      getOwnerSessionId: async (sessionId) =>
        (await deps.getSessionContext(sessionId))?.parentSessionId ?? null,
      openPreviewWindow: deps.openPreviewWindow,
      openExternalUrl: deps.openExternalUrl,
      openDirectory: deps.openDirectory,
    });
  }

  /** 一覧・ピン・パス解決に使う共通のファイル参照サービスを返す。 */
  public getExplorer(): SessionFileExplorerService {
    return this.explorer;
  }

  /** ファイル参照で認可したルートに対するGit差分・履歴サービスを返す。 */
  public getGitChanges(): FileRootGitChangesService {
    return this.gitChanges;
  }

  /** ファイル参照とGit差分を使うプレビューサービスを返す。 */
  public getPreview(): SessionFilePreviewService {
    return this.preview;
  }
}
