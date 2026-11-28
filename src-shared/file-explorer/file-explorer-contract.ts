import type { SessionSummary } from "../session/session-state.js";

/** プレビューまたはセッションを対象に、Window 内の指定座標でネイティブメニューを開く要求。 */
export type SessionFilePreviewContextMenuRequest = {
  scope: "preview" | "session";
  point: { x: number; y: number };
};

/** メニューから閉じる操作が選ばれたか、何も選ばずに閉じたかを区別する。 */
export type SessionFilePreviewContextMenuResult = "close" | "dismissed";

/** IPC 入力の対象範囲と非負の安全な整数座標を検証し、余分なキーを含む要求は拒否する。 */
export function parseSessionFilePreviewContextMenuRequest(
  value: unknown,
): SessionFilePreviewContextMenuRequest {
  /** 入力の形・対象・座標の違反を、同じ要求形式エラーとして返す。 */
  const invalid = () =>
    new TypeError("File Preview context menu request is invalid.");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const candidate = value as Record<string, unknown>;
  if (
    !Object.keys(candidate).every((key) => ["scope", "point"].includes(key)) ||
    (candidate.scope !== "preview" && candidate.scope !== "session") ||
    !candidate.point ||
    typeof candidate.point !== "object" ||
    Array.isArray(candidate.point)
  )
    throw invalid();
  const point = candidate.point as Record<string, unknown>;
  if (
    !Object.keys(point).every((key) => ["x", "y"].includes(key)) ||
    !Number.isSafeInteger(point.x) ||
    (point.x as number) < 0 ||
    !Number.isSafeInteger(point.y) ||
    (point.y as number) < 0
  )
    throw invalid();
  return {
    scope: candidate.scope,
    point: { x: point.x as number, y: point.y as number },
  };
}

/** 開いているプレビューの表示名・パスと、その Window を識別するトークン。 */
export type SessionFilePreviewWindowSummary = {
  token: string;
  title: string;
  path: string;
};

/** Home で表示する、所有セッションごとのプレビュー一覧。セッション概要が取れない場合は null。 */
export type SessionFilePreviewWindowGroup = {
  ownerSessionId: string;
  session: SessionSummary | null;
  previews: SessionFilePreviewWindowSummary[];
};

/** File Explorer のルートの由来。作業領域、セッション、Crew、追加ディレクトリを区別する。 */
export type SessionFileRootKind =
  "workspace" | "session-folder" | "crew-folder" | "additional";

/** 保存済みのピンに現在のルート ID と、利用できない場合の理由を付けた表示用データ。 */
export type SessionFilePin = {
  rootKind: SessionFileRootKind;
  rootPath: string;
  relativePath: string;
  kind: "file" | "directory";
  rootId: string | null;
  rootLabel: string;
  unavailableReason: string | null;
};

/** 一時的なルート ID に頼らず、ルート種別・パスと相対パスで既存ピンを指す。 */
export type SessionFilePinReference = Pick<
  SessionFilePin,
  "rootKind" | "rootPath" | "relativePath"
>;
/** 現在のルート解決結果は含めず、次回の表示と照合に必要なピンの情報だけを永続化する。 */
export type StoredSessionFilePin = Pick<
  SessionFilePin,
  "rootKind" | "rootPath" | "relativePath" | "kind" | "rootLabel"
>;
/** ピンの所有者を、セッション ID とその世代の組で識別する。 */
export type SessionFilePinOwner = { sessionId: string; incarnationId: string };

/** renderer に表示するファイル参照の起点。後続の要求では表示パスでなくルート ID を指定する。 */
export type SessionFileRoot = {
  id: string;
  kind: SessionFileRootKind;
  label: string;
  displayPath: string;
};

/** ディレクトリ一覧で通常ファイル、ディレクトリ、シンボリックリンク、その他を区別する。 */
export type SessionDirectoryEntryKind =
  "directory" | "file" | "symbolic-link" | "other";

/** ツリーのパス操作に渡せる対象。ルートそのものと配下の項目を区別する。 */
export type SessionFileTreePathActionNodeKind = "root" | "directory" | "file";

/** ファイルツリーのネイティブメニューを開く Window 内の座標。 */
export type SessionFileTreePathActionPoint = {
  x: number;
  y: number;
};

/** 選択したツリー項目、メニューの表示位置、入力欄へパスを挿入できるかを Main に渡す。 */
export type SessionFileTreePathActionRequest = {
  sessionId: string;
  rootId: string;
  relativePath: string;
  nodeKind: SessionFileTreePathActionNodeKind;
  point: SessionFileTreePathActionPoint;
  canInsert: boolean;
};

/** ツリー項目を実パスへ解決するための情報。メニューの座標や挿入可否は含めない。 */
export type SessionFileTreePathActionTargetRequest = Omit<
  SessionFileTreePathActionRequest,
  "point" | "canInsert"
>;

/** パス・ファイルのコピー結果、挿入に渡す絶対パスと所有セッション、失敗や選択なしを返す。 */
export type SessionFileTreePathActionContextMenuResult =
  | { status: "copied-path" | "copied-file" }
  | { status: "insert-path"; ownerSessionId: string; absolutePath: string }
  | { status: "failed"; message: string }
  | { status: "dismissed" };

/** セッション、作業領域、追加ディレクトリの順序をキー化し、ツリーを更新する起点の変更を識別する。 */
export function buildSessionFileExplorerRootsRevision(input: {
  sessionId: string | null;
  workspacePath: string | null;
  additionalDirectories: readonly string[];
}): string {
  return JSON.stringify([
    input.sessionId ?? "",
    input.workspacePath ?? "",
    ...input.additionalDirectories,
  ]);
}

/** 一覧の一項目。読み取り要求に使う相対パスと、取得できた場合のサイズ・更新時刻を持つ。 */
export type SessionDirectoryEntry = {
  name: string;
  relativePath: string;
  kind: SessionDirectoryEntryKind;
  byteLength: number | null;
  modifiedAt: string | null;
};

/** プレビューが本文、画像、PDF などの表示方法を選ぶためのファイル分類。 */
export type SessionFileResourceKind =
  "text" | "markdown" | "image" | "svg" | "pdf" | "binary";
/** テキストを表示するときにファイルのバイト列を復号するための文字コード候補。 */
export type SessionFileEncoding =
  "utf-8" | "shift_jis" | "utf-16le" | "utf-16be";

/** セッションに割り当てられたルートの ID と、その配下の相対パスで実ファイルを参照する。 */
export type SessionFileRootResourceRequest = {
  sessionId: string;
  rootId: string;
  relativePath: string;
};

/** セッションの文脈で、ツリーのルート ID を使わず絶対パスの実ファイルを参照する。 */
export type SessionFileAbsoluteResourceRequest = {
  sessionId: string;
  absolutePath: string;
};

/** 作業ツリーの内容ではなく、指定リポジトリのコミット時点にあるファイルを参照する。 */
export type SessionFileGitCommitResourceRequest = {
  resourceKind: "git-commit-file";
  sessionId: string;
  rootId: string;
  repositoryId: string;
  commitId: string;
  relativePath: string;
};

/** 現在のファイルシステム上の対象を、ルート相対または絶対パスで参照する。 */
export type SessionFileResourceRequest =
  SessionFileRootResourceRequest | SessionFileAbsoluteResourceRequest;

/** 現在のファイルに加え、指定コミット時点のファイルも表示対象として扱う。 */
export type SessionFilePreviewResourceRequest =
  SessionFileResourceRequest | SessionFileGitCommitResourceRequest;

/** 型付け済みのプレビュー参照を、絶対パスを持つ形式に絞り込む。パスの妥当性は検証しない。 */
export function isSessionFileAbsoluteResource(
  resource: SessionFilePreviewResourceRequest,
): resource is SessionFileAbsoluteResourceRequest {
  return "absolutePath" in resource;
}

/** プレビュー参照の識別子を調べ、コミット時点のファイル形式に絞り込む。 */
export function isSessionFileGitCommitResource(
  resource: SessionFilePreviewResourceRequest,
): resource is SessionFileGitCommitResourceRequest {
  return (
    "resourceKind" in resource && resource.resourceKind === "git-commit-file"
  );
}

/** コミット参照を除外し、現在のルート配下を参照する形式に絞り込む。 */
export function isSessionFileRootResource(
  resource: SessionFilePreviewResourceRequest,
): resource is SessionFileRootResourceRequest {
  return "rootId" in resource && !isSessionFileGitCommitResource(resource);
}

/** 画面表示に使うパスを返す。ルートまたはコミットからの参照は相対パスのまま返す。 */
export function getSessionFileResourceDisplayPath(
  resource: SessionFilePreviewResourceRequest,
): string {
  return isSessionFileAbsoluteResource(resource)
    ? resource.absolutePath
    : resource.relativePath;
}

/** 同一セッション内で同じ形式・識別情報の参照かを比較する。区切り文字の違いはコミット参照だけで吸収する。 */
export function areSessionFileResourcesEqual(
  left: SessionFilePreviewResourceRequest,
  right: SessionFilePreviewResourceRequest,
): boolean {
  if (left.sessionId !== right.sessionId) {
    return false;
  }
  if (
    isSessionFileAbsoluteResource(left) &&
    isSessionFileAbsoluteResource(right)
  ) {
    return left.absolutePath === right.absolutePath;
  }
  if (
    isSessionFileGitCommitResource(left) &&
    isSessionFileGitCommitResource(right)
  ) {
    return (
      left.rootId === right.rootId &&
      left.repositoryId === right.repositoryId &&
      left.commitId === right.commitId &&
      left.relativePath.replaceAll("\\", "/") ===
        right.relativePath.replaceAll("\\", "/")
    );
  }
  return (
    isSessionFileRootResource(left) &&
    isSessionFileRootResource(right) &&
    left.rootId === right.rootId &&
    left.relativePath === right.relativePath
  );
}

/** リソース、履歴差分、リンクのいずれかを別 Window で開く要求。コミット参照のリソースは内容表示に限る。 */
export type SessionFilePreviewWindowOpenRequest =
  | {
      kind: "resource";
      resource: SessionFileResourceRequest;
      view?: SessionFilePreviewWindowView;
    }
  | {
      kind: "resource";
      resource: SessionFileGitCommitResourceRequest;
      view?: { kind: "preview" };
    }
  | {
      kind: "history-diff";
      request: FileRootGitHistoryDiffRequest;
    }
  | {
      kind: "link";
      sessionId: string;
      target: string;
      baseResource?: SessionFilePreviewResourceRequest;
    };

/** 通常の内容表示と、作業ツリーまたはステージ済みの差分表示を切り分ける。 */
export type SessionFilePreviewWindowView =
  { kind: "preview" } | { kind: "diff"; scope: FileRootGitDiffScope };

/** 内容表示と履歴差分表示で共通となる、所有セッションと Window の表示情報。 */
type SessionFilePreviewWindowPayloadBase = {
  ownerSessionId: string;
  windowTitle: string;
  displayPath: string;
};

/** Main が別 Window の renderer に渡す、表示情報とリソース参照または取得済みの履歴差分。 */
export type SessionFilePreviewWindowPayload =
  SessionFilePreviewWindowPayloadBase &
    (
      | {
          resource: SessionFileResourceRequest;
          view?: SessionFilePreviewWindowView;
        }
      | {
          resource: SessionFileGitCommitResourceRequest;
          view?: { kind: "preview" };
        }
      | {
          historyDiff: SessionFileHistoryDiffWindowPayload;
        }
    );

/** 履歴差分のパッチと、利用できる場合に開けるコミット時点または比較前後のファイル参照。 */
export type SessionFileHistoryDiffWindowPayload = {
  request: FileRootGitHistoryDiffRequest;
  patch: string;
  previewResource: SessionFileGitCommitResourceRequest | null;
  previewBeforeResource: SessionFileGitCommitResourceRequest | null;
  previewAfterResource: SessionFileGitCommitResourceRequest | null;
};

/** ファイル名から有効なタイトルを得られないときに使う別 Window の既定表示名。 */
export const FILE_PREVIEW_WINDOW_TITLE_FALLBACK = "File Preview";

/** パス末尾を表示名に使い、空欄・ドット項目・制御文字を含む候補は既定名に置き換える。 */
export function resolveSessionFilePreviewWindowTitle(
  fileName: string | null | undefined,
): string {
  const normalizedPath = fileName?.trim().replaceAll("\\", "/") ?? "";
  const candidate = normalizedPath.split("/").at(-1)?.trim() ?? "";
  return candidate &&
    candidate !== "." &&
    candidate !== ".." &&
    !/[\u0000-\u001f\u007f]/u.test(candidate)
    ? candidate
    : FILE_PREVIEW_WINDOW_TITLE_FALLBACK;
}

/** ファイルの表示名にコミット ID の先頭 7 文字を添え、現在のファイル表示と区別する。 */
export function resolveSessionFileGitCommitPreviewWindowTitle(
  fileName: string | null | undefined,
  commitId: string,
): string {
  return `${resolveSessionFilePreviewWindowTitle(fileName)} · ${commitId.slice(0, 7)}`;
}

/** 別 Window の新規作成・既存 Window へのフォーカス、外部起動、表示できなかった場合を区別する。 */
export type SessionFilePreviewWindowOpenResult =
  | {
      status: "opened";
      targetType: "preview-window";
      disposition: "created" | "focused";
      resource: SessionFilePreviewResourceRequest;
    }
  | {
      status: "opened";
      targetType: "preview-window";
      disposition: "created" | "focused";
      historyDiff: FileRootGitHistoryDiffRequest;
    }
  | {
      status: "opened";
      targetType: "external-url" | "local-directory";
      target: string;
    }
  | {
      status: "not-found" | "not-previewable" | "failed";
      targetType: "local-file" | "local-path" | "unknown";
      target: string;
      message: string;
    };

/** リンクの解決結果を外部 URL、ローカルディレクトリ、ファイル参照、解決失敗に振り分ける。 */
export type SessionFilePreviewTargetResolution =
  | { type: "external-url"; target: string }
  | { type: "directory"; targetPath: string }
  | { type: "file"; resource: SessionFileResourceRequest }
  | {
      type: "not-found" | "not-previewable" | "failed";
      targetPath: string;
      message: string;
    };

/** プレビュー内の画像メニューを開く Window 内の座標。 */
export type SessionFilePreviewImagePoint = {
  x: number;
  y: number;
};

/** 画像のコピーやメニューを要求するセッションと座標。画像への参照を必要に応じて添える。 */
export type SessionFilePreviewImageActionRequest = {
  sessionId: string;
  point: SessionFilePreviewImagePoint;
  image?: Omit<SessionImageResourceRequest, "sessionId">;
};

/** 画像をクリップボードへコピーしたか、理由付きで失敗したかを示す。 */
export type SessionFilePreviewImageCopyResult =
  { status: "copied" } | { status: "failed"; message: string };

/** 画像そのもののコピー結果に加え、パスのコピーや選択なしを示す。 */
export type SessionFilePreviewImageContextMenuResult =
  | SessionFilePreviewImageCopyResult
  | { status: "copied-path" }
  | { status: "dismissed" };

/** セッションのルート ID と相対パスで、一覧を取得するディレクトリを指定する。 */
export type SessionDirectoryRequest = SessionFileRootResourceRequest;

/** 現在のファイルを開くか、ファイルマネージャーで所在を表示する。 */
export type SessionFileOpenRequest = SessionFileResourceRequest & {
  reveal?: boolean;
};

/** プレビュー方法を選ぶためのメタデータと、分割読み込みで同じ内容を参照するためのリビジョン。 */
export type SessionFileDescriptor = SessionFilePreviewResourceRequest & {
  absoluteFilePath: string;
  name: string;
  kind: SessionFileResourceKind;
  byteLength: number;
  modifiedAt: string;
  mimeType: string;
  suggestedEncoding: SessionFileEncoding;
  revision: string;
};

/** 記述子取得後にファイルが変わっていないことを照合しながら、指定したバイト範囲を読む。 */
export type SessionFileChunkRequest = SessionFilePreviewResourceRequest & {
  offset: number;
  length: number;
  expectedRevision: string;
};

/** 取得データと開始・再開位置、全体サイズ、完了状態、読んだ内容のリビジョン。 */
export type SessionFileChunkResult = {
  data: ArrayBuffer;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  done: boolean;
  revision: string;
};

/** セッションと必要に応じた基準リソースを使って、表示・コピー対象の画像リンクを解決する。 */
export type SessionImageResourceRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

/** 画像の解決時に得たリビジョンを指定し、バイト範囲ごとに読み込む。 */
export type SessionImageChunkRequest = SessionImageResourceRequest & {
  offset: number;
  length: number;
  expectedRevision: string;
};

/** セッションと必要に応じた基準リソースを使って、PDF ビューアーで開くリンクを解決する。 */
export type SessionPdfResourceRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

/** PDF の解決時に得たリビジョンを指定し、バイト範囲ごとに読み込む。 */
export type SessionPdfChunkRequest = SessionPdfResourceRequest & {
  offset: number;
  length: number;
  expectedRevision: string;
};

/** 現在の作業状態から差分を取得するときに、未ステージとステージ済みを区別する。 */
export type FileRootGitDiffScope = "working-tree" | "staged";
/** 変更ファイルが属する範囲。作業状態の二種に加え、履歴のコミット差分も扱う。 */
export type FileRootGitChangeScope = FileRootGitDiffScope | "commit";
/** Git の変更一覧で、追加・編集・削除・移動・コピー・未追跡を区別する。 */
export type FileRootGitChangeKind =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked";

/** 一つの変更パスと旧パス、同じファイルが属する差分範囲および各範囲での変更種別。 */
export type FileRootGitChangeEntry = {
  relativePath: string;
  previousRelativePath: string | null;
  kinds: Partial<Record<FileRootGitChangeScope, FileRootGitChangeKind>>;
  scopes: FileRootGitChangeScope[];
};

/** セッションのどのルートについて現在の Git 変更を取得するかを指定する。 */
export type FileRootChangesRequest = {
  sessionId: string;
  rootId: string;
};

/** 変更を表示できる Git ルートかどうか、セッション内の候補をまとめて照会する。 */
export type FileRootChangesRepositoriesRequest = {
  sessionId: string;
  rootIds: string[];
};

/** Git として扱えるルートと個別の失敗を、照会全体の失敗と区別して返す。 */
export type FileRootChangesRepositoriesResult =
  | {
      status: "ok";
      repositories: Array<{ rootId: string }>;
      failures: Array<{ rootId: string; message: string }>;
    }
  | { status: "failed"; message: string };

/** 現在の変更ファイル一覧、またはルート未解決・非 Git・読み取り失敗の結果。 */
export type FileRootChangesResult =
  | { status: "ok"; entries: FileRootGitChangeEntry[] }
  | { status: "not-git" | "root-not-found" | "failed"; message: string };

/** ルート内のファイルと差分範囲を指定し、一つの作業ツリー差分またはステージ済み差分を要求する。 */
export type FileRootFileDiffRequest = FileRootChangesRequest & {
  relativePath: string;
  scope: FileRootGitDiffScope;
};

/** 差分の対象パスと範囲を維持したまま、別 Window で同じ差分を開く要求へ変換する。 */
export function buildFileRootDiffPreviewWindowRequest(
  request: FileRootFileDiffRequest,
): SessionFilePreviewWindowOpenRequest {
  return {
    kind: "resource",
    resource: {
      sessionId: request.sessionId,
      rootId: request.rootId,
      relativePath: request.relativePath,
    },
    view: { kind: "diff", scope: request.scope },
  };
}

/** パッチを取得できた場合と、未追跡・差分なし・ルート解決や読み取りの失敗を区別する。 */
export type FileRootFileDiffResult =
  | {
      status: "ok";
      relativePath: string;
      scope: FileRootGitDiffScope;
      patch: string;
    }
  | {
      status:
        "untracked" | "not-changed" | "not-git" | "root-not-found" | "failed";
      message: string;
    };

/** 履歴表示で選択できるリポジトリと、現在のブランチ・履歴や比較の参照候補。 */
export type FileRootGitHistoryRepository = {
  repositoryId: string;
  rootId: string;
  label: string;
  displayPath: string;
  branches: string[];
  currentBranch: string | null;
  refs: FileRootGitHistoryAvailableRef[];
};

/** Git 履歴を表示するリポジトリ候補を、対象セッションから取得する。 */
export type FileRootGitHistoryRepositoriesRequest = {
  sessionId: string;
};

/** 履歴に表示できるリポジトリの一覧、または照会に失敗した理由。 */
export type FileRootGitHistoryRepositoriesResult =
  | { status: "ok"; repositories: FileRootGitHistoryRepository[] }
  | { status: "failed"; message: string };

/** 履歴操作の対象をセッション、リポジトリ、その参照元ルートの組で指定する。 */
export type FileRootGitHistoryRequest = {
  sessionId: string;
  repositoryId: string;
  rootId: string;
};

/** コミット一覧で HEAD・ブランチ・タグのラベルを区別する。 */
export type FileRootGitHistoryRefKind = "head" | "branch" | "tag";

/** コミットの履歴行に表示する参照ラベルの種別と名前。 */
export type FileRootGitHistoryRef = {
  kind: FileRootGitHistoryRefKind;
  name: string;
};

/** 履歴比較の候補となる名前付き参照を、ローカルブランチ・リモート追跡参照・タグに分類する。 */
export type FileRootGitHistoryAvailableRefKind = "branch" | "remote" | "tag";

/** 比較の端点として利用できる名前付き参照。種別を併せて保持し、同名の別種参照と区別する。 */
export type FileRootGitHistoryAvailableRef = {
  kind: FileRootGitHistoryAvailableRefKind;
  name: string;
};

/** 履歴一覧と詳細に使うコミットの識別情報、件名、作者、時刻、参照ラベルと親コミット。 */
export type FileRootGitHistoryCommit = {
  id: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  refs: FileRootGitHistoryRef[];
  parentIds: string[];
};

/** 選択中のローカルブランチの履歴ページを要求する。ブランチ未選択を null で表す。 */
export type FileRootGitHistoryCommitsRequest = FileRootGitHistoryRequest & {
  branch: string | null;
  cursor?: string | null;
};

/** コミット一覧の一ページと、次のページの有無および取得カーソル。 */
export type FileRootGitHistoryPage = {
  entries: FileRootGitHistoryCommit[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** 履歴ページの取得と、ブランチの消失・未選択、空のリポジトリ、その他の失敗を区別する。 */
export type FileRootGitHistoryCommitsResult =
  | { status: "ok"; page: FileRootGitHistoryPage }
  | {
      status:
        | "repository-not-found"
        | "branch-not-found"
        | "detached-head"
        | "empty-repository"
        | "failed";
      message: string;
    };

/** 履歴から詳細を取得するコミットを、対象リポジトリとコミット ID で指定する。 */
export type FileRootGitHistoryCommitDetailRequest =
  FileRootGitHistoryRequest & {
    commitId: string;
  };

/** 選んだコミットの情報と変更ファイル一覧、または識別子の解決・読み取り失敗の結果。 */
export type FileRootGitHistoryCommitDetailResult =
  | {
      status: "ok";
      commit: FileRootGitHistoryCommit;
      entries: FileRootGitChangeEntry[];
    }
  | {
      status: "commit-not-found" | "repository-not-found" | "failed";
      message: string;
    };

/** 指定した両コミットを直接比較するか、共通祖先から比較先までを見るかを選ぶ。 */
export type FileRootGitHistoryComparisonMode = "direct" | "branch";

/** 比較の端点を HEAD、種別付きの参照名、またはコミットのオブジェクト ID で指定する。 */
export type FileRootGitHistoryComparisonSelector =
  | { kind: "head" }
  | { kind: "branch" | "remote" | "tag"; name: string }
  | { kind: "commit"; objectId: string };

/** 参照名が動いても後続の差分照会で同じ端点を使えるよう、解決済みコミット ID と共通祖先を保持する。 */
export type FileRootGitHistoryComparison = {
  mode: FileRootGitHistoryComparisonMode;
  base: FileRootGitHistoryComparisonSelector;
  target: FileRootGitHistoryComparisonSelector;
  baseCommitId: string;
  targetCommitId: string;
  mergeBaseCommitId: string | null;
};

/** 指定リポジトリで比較元・比較先を解決し、選んだ比較方式で変更ファイル一覧を求める。 */
export type FileRootGitHistoryComparisonRequest = FileRootGitHistoryRequest & {
  base: FileRootGitHistoryComparisonSelector;
  target: FileRootGitHistoryComparisonSelector;
  mode: FileRootGitHistoryComparisonMode;
};

/** 比較で確定した端点と変更ファイル一覧、または参照や一意な共通祖先を解決できなかった結果。 */
export type FileRootGitHistoryComparisonResult =
  | {
      status: "ok";
      comparison: FileRootGitHistoryComparison;
      entries: FileRootGitChangeEntry[];
    }
  | {
      status:
        | "repository-not-found"
        | "invalid-selector"
        | "commit-not-found"
        | "merge-base-unavailable"
        | "ambiguous-merge-base"
        | "failed";
      message: string;
    };

/** 一つのコミットの差分を要求する。相対パスが未指定ならファイル単位に限定しない。 */
export type FileRootGitHistoryCommitDiffRequest =
  FileRootGitHistoryCommitDetailRequest & {
    relativePath?: string | null;
  };

/** 解決済みの履歴比較を再利用して差分を取得し、相対パスがあれば一ファイルに絞る。 */
export type FileRootGitHistoryComparisonDiffRequest =
  FileRootGitHistoryRequest & {
    comparison: FileRootGitHistoryComparison;
    relativePath?: string | null;
  };

/** 履歴プレビューに用いる単一コミット差分または解決済みの比較差分の要求。 */
export type FileRootGitHistoryDiffRequest =
  FileRootGitHistoryCommitDiffRequest | FileRootGitHistoryComparisonDiffRequest;

/** 型付け済みの履歴差分要求から、比較条件を持つ形式を識別する。 */
export function isFileRootGitHistoryComparisonDiffRequest(
  request: FileRootGitHistoryDiffRequest,
): request is FileRootGitHistoryComparisonDiffRequest {
  return "comparison" in request;
}

/** 履歴差分のパッチ、表示パス、利用可能なファイル参照を返す。差分なしや解決失敗は別の結果にする。 */
export type FileRootGitHistoryDiffResult =
  | {
      status: "ok";
      commitId: string;
      displayPath: string;
      relativePath: string | null;
      patch: string;
      previewResource: SessionFileGitCommitResourceRequest | null;
    }
  | {
      status: "ok";
      comparison: FileRootGitHistoryComparison;
      displayPath: string;
      relativePath: string | null;
      patch: string;
      previewBeforeResource: SessionFileGitCommitResourceRequest | null;
      previewAfterResource: SessionFileGitCommitResourceRequest | null;
    }
  | {
      status:
        | "commit-not-found"
        | "not-changed"
        | "repository-not-found"
        | "invalid-selector"
        | "merge-base-unavailable"
        | "ambiguous-merge-base"
        | "failed";
      message: string;
    };
