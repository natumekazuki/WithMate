import type {
  CancelSessionRunRequest,
  ComposerPreview,
  DiscoveredCustomAgent,
  DiscoveredSkill,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
  RunSessionTurnRequest,
} from "../session/runtime-state.js";
import type { SessionTurnRecord } from "../session/session-turn-state.js";
import type {
  SessionFolderCleanupRequest,
  SessionFolderCleanupScan,
  SessionFolderCleanupResult,
} from "../session/session-folder-cleanup.js";
import type { AppSettings } from "../settings/provider-settings-state.js";
import type { LiveSessionRunStatus } from "../session/live-session-run-status.js";
import type {
  ConversationPage,
  ConversationPageRequest,
  ConversationSearchRequest,
  ConversationSearchMatch,
  ConversationNavigatorEntry,
  ConversationNavigatorRequest,
  ConversationQueryOutcome,
  ConversationQueryCancelRequest,
} from "../session/conversation-page.js";
import type {
  CreateTerminalRequest,
  CreateTerminalResult,
  TerminalEvent,
} from "../terminal/terminal-contract.js";
import type { CharacterProfile } from "../character/character-state.js";
import type {
  CreateSessionRequest,
  DiffPreviewPayload,
  MessageArtifact,
  SessionCharacterUsage,
  Session,
  SessionSummaryInvalidation,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
  SetSessionPinnedRequest,
} from "../session/session-state.js";
import type {
  ChangeSessionAdditionalDirectoryRequest,
  SetExecutionOptionsResult,
  SetAuxiliaryExecutionOptionsRequest,
  SetAuxiliaryMessageBookmarkRequest,
  SetAuxiliaryTitleRequest,
  SetSessionExecutionOptionsRequest,
  SetSessionMessageBookmarkRequest,
  SetSessionTitleRequest,
  SetSessionTitleResult,
} from "../session/session-mutation-contract.js";
import type { ChatLayoutPreferenceUpdate } from "../settings/chat-layout-preference.js";
import type {
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../auxiliary/auxiliary-draft-contract.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../prompt-template.js";
import type {
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../settings/model-catalog.js";
import type { RendererLogInput } from "../window/app-log-types.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../window/markdown-link-context-menu.js";
import type { AppBootStatus } from "../window/app-boot-state.js";
import type { WorkspaceDirectoryValidationResult } from "../window/workspace-directory-validation.js";
import type { AppDatabaseDiagnostics } from "../window/app-database-diagnostics-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../auxiliary/auxiliary-session-state.js";
import type {
  ImageFilePickerPurpose,
  OpenPathOptions,
  OpenPathResult,
  DeleteSessionsLastActiveBeforeRequest,
  DeleteSessionsResult,
  ResetAppDatabaseRequest,
  ResetAppDatabaseResult,
  SavePastedSessionFileRequest,
  SavePastedSessionFileResult,
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
  SessionMonitorPageRequest,
  SessionMonitorPageResult,
  AuxiliarySessionSelectionPayload,
  AuxiliarySessionNavigationPayload,
} from "../window/withmate-window-types.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../mate/mate-state.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../character/character-catalog.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../character/character-authoring.js";
import type {
  SessionDirectoryEntry,
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionImageResourceRequest,
  SessionImageChunkRequest,
  SessionPdfResourceRequest,
  SessionPdfChunkRequest,
  SessionFileChunkResult,
  SessionFileDescriptor,
  SessionFilePreviewImageActionRequest,
  SessionFilePreviewImageContextMenuResult,
  SessionFilePreviewImageCopyResult,
  SessionFileOpenRequest,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
  SessionFilePreviewWindowPayload,
  SessionFilePreviewWindowGroup,
  SessionFilePreviewContextMenuRequest,
  SessionFilePreviewContextMenuResult,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRoot,
  SessionFilePin,
  SessionFilePinReference,
  SessionFileRootResourceRequest,
  SessionFileTreePathActionContextMenuResult,
  SessionFileTreePathActionRequest,
  FileRootChangesRequest,
  FileRootChangesRepositoriesRequest,
  FileRootChangesRepositoriesResult,
  FileRootChangesResult,
  FileRootFileDiffRequest,
  FileRootFileDiffResult,
  FileRootGitHistoryCommitDetailRequest,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryComparisonRequest,
  FileRootGitHistoryComparisonResult,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryDiffResult,
  FileRootGitHistoryRepositoriesRequest,
  FileRootGitHistoryRepositoriesResult,
} from "../file-explorer/file-explorer-contract.js";
import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyRequest,
  SessionFileObjectCopyResult,
} from "../file-explorer/session-file-object-copy-contract.js";
import type {
  GlossaryListResult,
  GlossaryOperationResult,
  GlossarySearchRequest,
  SessionGlossaryProjection,
} from "../glossary/glossary-contract.js";
import type { SessionWindowRestoreResult } from "../window/session-window-restore.js";
import type {
  HomeCrewContextMenuRequest,
  HomeCrewPageResult,
} from "../window/home-crew-types.js";
import type { OpenSessionWindowIdsPageRequest } from "../window/withmate-window-types.js";
import type { WithMateHtmlPreviewApi } from "../window/html-preview.js";
import type {
  SessionHtmlPreviewRequest,
  SessionHtmlPreviewResult,
} from "../file-explorer/session-html-preview-contract.js";
import type { MainSessionTarget } from "../session/session-target.js";

/** Main が所有するウィンドウの切替と、OS に委ねるナビゲーション操作の契約。 */
export type WithMateWindowNavigationApi = {
  /** Home のメインフレーム専用。続きの取得が拒否されたら先頭ページからやり直し、一部のページだけを表示に反映しない。 */
  listHomeCrewPage(
    request?: OpenSessionWindowIdsPageRequest | null,
  ): Promise<HomeCrewPageResult>;
  /** Home のメインフレーム専用。Main はこのメンバーの厳密な識別情報を基に操作対象と確認内容を決める。 */
  showHomeCrewContextMenu(
    request: HomeCrewContextMenuRequest,
  ): Promise<SessionMonitorContextMenuResult>;
  /** Home からプレビュー単体または所有 Session 全体を閉じるメニューを開き、選択と取り消しを区別して返す。 */
  showSessionFilePreviewContextMenu(
    request: SessionFilePreviewContextMenuRequest,
  ): Promise<SessionFilePreviewContextMenuResult>;
  /** Home のウィンドウ一覧に使う、現在開いている独立プレビューを所有 Session ごとに返す。 */
  listSessionFilePreviewWindows(): Promise<SessionFilePreviewWindowGroup[]>;
  /** Home から一覧上のトークンで既存プレビューを前面に出す。新規プレビューは作らない。 */
  focusSessionFilePreviewWindow(token: string): Promise<void>;
  /** Home からトークンで特定した独立プレビューだけを閉じる。 */
  closeSessionFilePreviewWindow(token: string): Promise<void>;
  /** Home から指定 Session が所有する独立プレビューをまとめて閉じる。 */
  closeSessionFilePreviewWindows(ownerSessionId: string): Promise<void>;
  /** Main Session の会話ウィンドウを表示し、所属する Auxiliary を指定したときは同じウィンドウ内で選ぶ。 */
  openSession(sessionId: string, auxiliarySessionId?: string): Promise<void>;
  /** Main Session の厳密な識別情報を使い、その Session が所有する Local PR 画面を開く。 */
  openLocalPrWindow(target: MainSessionTarget): Promise<void>;
  /** Session Monitor の項目とクリック位置を渡し、Main が提示したネイティブメニューの結果を受け取る。 */
  showSessionMonitorContextMenu(
    request: SessionMonitorContextMenuRequest,
  ): Promise<SessionMonitorContextMenuResult>;
  /** Home で前回の会話ウィンドウからまだ復元されていない Session の ID を取得する。 */
  getSessionWindowRestoreSet(): Promise<string[]>;
  /** Home から保存された会話ウィンドウの復元を試み、復元できなかった対象も判別できる結果を得る。 */
  restoreSessionWindows(): Promise<SessionWindowRestoreResult>;
  /** 会話などの別ウィンドウからアプリの主画面を表示する。 */
  openHomeWindow(): Promise<void>;
  /** 会話ウィンドウとは別に、Session の稼働状況を確認する監視画面を表示する。 */
  openSessionMonitorWindow(): Promise<void>;
  /** アプリ共通の設定を確認・編集する専用ウィンドウを表示する。 */
  openSettingsWindow(): Promise<void>;
  /** 指定 Character の編集画面を開く。ID の省略または null は新規作成用の画面を指す。 */
  openCharacterEditorWindow(characterId?: string | null): Promise<void>;
  /** 渡した差分データを専用ウィンドウに表示する。ファイルをパスから開く操作とは別の入口。 */
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  /** ファイルや履歴差分を独立プレビューで表示し、Main が再利用または開いたウィンドウの結果を返す。 */
  openSessionFilePreviewWindow(
    request: SessionFilePreviewWindowOpenRequest,
  ): Promise<SessionFilePreviewWindowOpenResult>;
  /** URL またはローカルパスを開く。相対パスの基準やファイルの場所を表示する指定を受け付ける。 */
  openPath(target: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  /** Markdown リンクに対応するネイティブメニューを表示し、コピー操作の結果を返す。 */
  showMarkdownLinkContextMenu(
    request: MarkdownLinkContextMenuRequest,
  ): Promise<MarkdownLinkContextMenuResult>;
  /** 診断ログのファイルを確認できるよう、アプリのログ保存先を OS に表示させる。 */
  openAppLogFolder(): Promise<void>;
  /** 障害調査用にローカルのクラッシュダンプ保存先を OS に表示させる。 */
  openCrashDumpFolder(): Promise<void>;
  /** Session のワークスペースを開始位置として外部端末を開く。組み込み端末は作成しない。 */
  openSessionTerminal(sessionId: string): Promise<void>;
  /** Session ID ではなく指定パスを基準に外部端末を起動する。 */
  openTerminalAtPath(target: string): Promise<void>;
};

/** モデル選択と専用差分画面が、Main 側で用意された表示用データを読むための契約。 */
export type WithMateWindowCatalogApi = {
  /** プロバイダーとワークスペースの条件に合うモデル候補を返す。カタログが得られなければ null。 */
  getModelCatalog(
    request?: ModelCatalogRequest,
  ): Promise<ModelCatalogSnapshot | null>;
  /** 差分ウィンドウのトークンで渡された表示用データを引き、対応するデータがなければ null を返す。 */
  getDiffPreview(token: string): Promise<DiffPreviewPayload | null>;
};

/** Main Session の保存状態・会話・実行と、Session に紐付くファイルを renderer から扱う契約。 */
export type WithMateWindowSessionApi = {
  /** Session で許可された HTML リソースを、プレビューを組み立てるために読み取る。 */
  readSessionHtmlPreview(
    request: SessionHtmlPreviewRequest,
  ): Promise<SessionHtmlPreviewResult>;
  /** OS のクリップボードにファイル自体を載せる機能を表示できるかを返す。現在は Windows のみ。 */
  isSessionFileObjectCopyAvailable(): boolean;
  /** Home の検索・絞り込みに使う Main Session の概要を、続きのカーソル付きのページとして読む。 */
  listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): Promise<HomeSessionSummaryPageResult>;
  /** Session Monitor 用の Main Session と関連する Auxiliary の表示用データをページ単位で読む。 */
  listSessionMonitorPage(
    request?: SessionMonitorPageRequest | null,
  ): Promise<SessionMonitorPageResult>;
  /** Character の利用状況表示に使う、保存済み Session による利用情報を読む。 */
  listSessionCharacterUsage(): Promise<SessionCharacterUsage[]>;
  /** 会話ウィンドウに必要な Main Session の状態を読み、指定 ID が保存されていなければ null を返す。 */
  getSession(sessionId: string): Promise<Session | null>;
  /** 保存会話を連続した範囲または指定メッセージ番号で読む。二つの指定方法は併用できない。 */
  getConversationPage(
    sessionId: string,
    request?: ConversationPageRequest,
  ): Promise<ConversationPage | null>;
  /** 保存会話をソースまたは表示向けテキストで検索し、ジャンプに使うメッセージ番号と出現位置を返す。 */
  searchConversation(
    sessionId: string,
    request: ConversationSearchRequest,
  ): Promise<ConversationQueryOutcome<ConversationSearchMatch>>;
  /** 会話内ジャンプの候補をページで返す。全件表示とブックマークだけの表示を切り替えられる。 */
  listConversationNavigator(
    sessionId: string,
    request: ConversationNavigatorRequest,
  ): Promise<ConversationQueryOutcome<ConversationNavigatorEntry>>;
  /** 発行元と要求 ID の組み合わせで、不要になった会話検索またはナビゲーターの照会を取り消す。 */
  cancelConversationQuery(
    request: ConversationQueryCancelRequest,
  ): Promise<void>;
  /** 一覧の部分更新用に、会話本文を含まない指定 Session の概要を読み取る。 */
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
  /** Session が使えるリポジトリ用語集の表示状態を、用語集が利用できない場合も含めて取得する。 */
  getSessionGlossaryProjection(
    sessionId: string,
  ): Promise<SessionGlossaryProjection>;
  /** Session が参照する用語集を検索し、検索結果と用語集の操作失敗を区別して返す。 */
  searchSessionGlossary(
    sessionId: string,
    request: GlossarySearchRequest,
  ): Promise<GlossaryOperationResult<GlossaryListResult>>;
  /** 保存済みのワークスペースを利用できるか再検査する。Session の設定は変更しない。 */
  validateSessionWorkspace(
    sessionId: string,
  ): Promise<WorkspaceDirectoryValidationResult>;
  /** 指定パスを Session の追加ディレクトリにできるか、登録前に検査する。 */
  validateSessionAdditionalDirectory(
    sessionId: string,
    targetPath: string,
  ): Promise<WorkspaceDirectoryValidationResult>;
  /** ワークスペース、Session Files、追加ディレクトリなど、ファイルツリーで扱えるルートを返す。 */
  listSessionFileRoots(sessionId: string): Promise<SessionFileRoot[]>;
  /** 指定 Session のファイルピンを、ファイルツリーから再び開ける参照として読み出す。 */
  listSessionFilePins(sessionId: string): Promise<SessionFilePin[]>;
  /** ルート内の相対パスでファイルを指定し、Session のピンとして保存する。 */
  pinSessionFile(
    request: SessionFileRootResourceRequest,
  ): Promise<SessionFilePin>;
  /** Session から指定ファイルのピンだけを外す。参照先の実ファイルは削除しない。 */
  unpinSessionFile(
    request: SessionFilePinReference & { sessionId: string },
  ): Promise<void>;
  /** 指定ルートと相対パスの直下にある項目を、ファイルツリーの展開用に取得する。 */
  listSessionDirectory(
    request: SessionDirectoryRequest,
  ): Promise<SessionDirectoryEntry[]>;
  /** プレビューに必要な種類、サイズ、リビジョンを取得する。作業ファイルとコミット内ファイルを扱える。 */
  inspectSessionFile(
    request: SessionFilePreviewResourceRequest,
  ): Promise<SessionFileDescriptor>;
  /** 認可された画像リソースを画像として検査し、後続の分割読取に使う記述子を返す。 */
  inspectSessionImage(
    request: SessionImageResourceRequest,
  ): Promise<SessionFileDescriptor>;
  /** 画像検査で得たリビジョンを指定してバイト範囲を読み、別版のデータを混ぜないようにする。 */
  readSessionImageChunk(
    request: SessionImageChunkRequest,
  ): Promise<SessionFileChunkResult>;
  /** PDF ビューアーの読み込み前に対象を PDF として確認し、長さとリビジョンを得る。 */
  inspectSessionPdf(
    request: SessionPdfResourceRequest,
  ): Promise<SessionFileDescriptor>;
  /** 検査済みのリビジョンを指定して PDF の要求範囲を読み、次のオフセットを返す。 */
  readSessionPdfChunk(
    request: SessionPdfChunkRequest,
  ): Promise<SessionFileChunkResult>;
  /** プレビュー対象のリビジョンとバイト範囲を指定して読み、連続読み取りの位置と終端を返す。 */
  readSessionFileChunk(
    request: SessionFileChunkRequest,
  ): Promise<SessionFileChunkResult>;
  /** Session が参照できる作業ファイルを既定アプリで開くか、OS のファイル一覧で場所を表示する。 */
  openSessionFile(request: SessionFileOpenRequest): Promise<OpenPathResult>;
  /** 独立プレビューの初期表示対象をトークンから取得する。該当する表示対象がなければ null。 */
  getSessionFilePreviewWindowPayload(
    token: string,
  ): Promise<SessionFilePreviewWindowPayload | null>;
  /** プレビュー中の画像のデータを OS のクリップボードへ書き込む。パスのコピーとは区別する。 */
  copySessionFilePreviewImage(
    request: SessionFilePreviewImageActionRequest,
  ): Promise<SessionFilePreviewImageCopyResult>;
  /** プレビューの画像に対して、画像データやパスをコピーするネイティブ選択肢を提示する。 */
  showSessionFilePreviewImageContextMenu(
    request: SessionFilePreviewImageActionRequest,
  ): Promise<SessionFilePreviewImageContextMenuResult>;
  /** 許可されたファイルを、ファイルマネージャーに貼り付けられる形式でコピーする。 */
  copySessionFileObject(
    request: SessionFileObjectCopyRequest,
  ): Promise<SessionFileObjectCopyResult>;
  /** ファイル参照を渡して OS のファイルオブジェクトコピーをメニューから実行できるようにする。 */
  showSessionFileObjectCopyContextMenu(
    request: SessionFileObjectCopyContextMenuRequest,
  ): Promise<SessionFileObjectCopyContextMenuResult>;
  /** ツリー項目の種類と挿入可否に応じた操作を提示し、入力欄への挿入時には対象パスを返す。 */
  showSessionFileTreeContextMenu(
    request: SessionFileTreePathActionRequest,
  ): Promise<SessionFileTreePathActionContextMenuResult>;
  /** ルートに対応する Git 作業ツリーの変更を、ファイルとステージ状態の一覧として取得する。 */
  listFileRootChanges(
    request: FileRootChangesRequest,
  ): Promise<FileRootChangesResult>;
  /** 候補ルートから変更表示に使える Git リポジトリを調べ、確認できなかったルートを別に返す。 */
  listFileRootChangesRepositories(
    request: FileRootChangesRepositoriesRequest,
  ): Promise<FileRootChangesRepositoriesResult>;
  /** ルート内のパスを指定し、作業ツリーまたはステージ済みのファイル差分を読む。 */
  getFileRootDiff(
    request: FileRootFileDiffRequest,
  ): Promise<FileRootFileDiffResult>;
  /** Session の利用可能なルートから、履歴画面のリポジトリ選択肢を取得する。 */
  listFileRootGitHistoryRepositories(
    request: FileRootGitHistoryRepositoriesRequest,
  ): Promise<FileRootGitHistoryRepositoriesResult>;
  /** 選択したリポジトリとブランチのコミットを読み、続きの履歴を要求できるカーソルを返す。 */
  listFileRootGitHistoryCommits(
    request: FileRootGitHistoryCommitsRequest,
  ): Promise<FileRootGitHistoryCommitsResult>;
  /** 選択コミットのメタデータと変更ファイル一覧を読み、見つからないコミットやリポジトリを区別する。 */
  getFileRootGitHistoryCommitDetail(
    request: FileRootGitHistoryCommitDetailRequest,
  ): Promise<FileRootGitHistoryCommitDetailResult>;
  /** 比較元と比較先を指定し、直接比較またはブランチ比較の結果と変更ファイルを返す。 */
  getFileRootGitHistoryComparison(
    request: FileRootGitHistoryComparisonRequest,
  ): Promise<FileRootGitHistoryComparisonResult>;
  /** コミット単体または確定した比較の差分を読む。パスを指定するとファイル単位に絞る。 */
  getFileRootGitHistoryDiff(
    request: FileRootGitHistoryDiffRequest,
  ): Promise<FileRootGitHistoryDiffResult>;
  /** 正本のメッセージ番号で添付成果物を取得する。成果物がない場合は null。 */
  getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): Promise<MessageArtifact | null>;
  /** Home で選んだ作業場所や実行設定を使って Main Session を作成し、会話表示に使う保存結果を返す。 */
  createSession(input: CreateSessionRequest): Promise<Session>;
  /** 既存 Main Session の状態を保存する。閲覧用に投影されたメッセージで保存済み履歴を置き換えない。 */
  updateSession(session: Session): Promise<Session>;
  /** 所有ウィンドウから、同じ世代の Main Session に追加ディレクトリを一件登録または解除する。 */
  changeSessionAdditionalDirectory(
    request: ChangeSessionAdditionalDirectoryRequest,
  ): Promise<void>;
  /** Main Session の今後の実行設定を更新し、確定の有無とチェックポイントの保存結果を判別できるようにする。 */
  setSessionExecutionOptions(
    request: SetSessionExecutionOptionsRequest,
  ): Promise<SetExecutionOptionsResult>;
  /** Main Session の件名を保存し、一覧用の投影も更新されたかを結果で区別する。 */
  setSessionTitle(
    request: SetSessionTitleRequest,
  ): Promise<SetSessionTitleResult>;
  /** 現在の世代の Main Session を全体統括へ昇格させ、更新後の概要を返す。 */
  promoteSessionToOverallCoordinator(
    sessionId: string,
    incarnationId: string,
  ): Promise<SessionSummary>;
  /** この Window が所有する Main または Auxiliary を識別し、保存済みの本文を読み取る。 */
  getSessionInstructions(
    target: import("../session/session-instructions.js").SessionInstructionsTarget,
  ): Promise<string>;
  /** 以降の Turn に使う保存済み本文を置き換える。空の本文を指定すると消去する。 */
  setSessionInstructions(
    target: import("../session/session-instructions.js").SessionInstructionsTarget,
    body: string,
  ): Promise<{ byteLength: number }>;
  /** Session の世代を指定して Crew の削除可否を照会する。削除自体は実行しない。 */
  getCrewDeletionStatus(
    sessionId: string,
    incarnationId: string,
  ): Promise<import("../session/session-crew-deletion.js").CrewDeletionStatus>;
  /** Main Session の保存済みメッセージ番号を指定して、ブックマークを付けるか外す。 */
  setSessionMessageBookmark(
    request: SetSessionMessageBookmarkRequest,
  ): Promise<void>;
  /** Home 一覧での Session のピン状態を保存し、更新後の概要を返す。 */
  setSessionPinned(request: SetSessionPinnedRequest): Promise<SessionSummary>;
  /** 指定 Main Session の削除を依頼する。Crew 全体の削除可否の照会とは別の操作。 */
  deleteSession(sessionId: string): Promise<void>;
  /** 送信前の入力から Session の文脈で添付参照を解決し、添付候補と解決エラーを返す。 */
  previewComposerInput(
    sessionId: string,
    userMessage: string,
  ): Promise<ComposerPreview>;
  /** 保存済み Session のプロバイダーと作業場所を基に、入力から参照できるスキルを検出する。 */
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  /** 保存済み Session の実行環境にあるカスタムエージェントを、入力の選択候補として読む。 */
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  /** Session を作成せず、指定プロバイダーとワークスペースに対するスキル候補を調べる。 */
  listWorkspaceSkills(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredSkill[]>;
  /** Session を作成せず、指定プロバイダーとワークスペースにあるカスタムエージェントを調べる。 */
  listWorkspaceCustomAgents(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredCustomAgent[]>;
  /** 所有ウィンドウから新しい Main Turn を直接実行し、その結果を反映した会話状態を待つ。 */
  runSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
  ): Promise<Session>;
  /** 現在の世代に通常入力を積み、実行の完了とは別に受付の結果を返す。 */
  enqueueSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest & { incarnationId: string },
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueAcceptanceResult
  >;
  /** 失敗した受付と Turn を特定し、保存済みの入力に対する新たな再試行の受付を求める。 */
  retryFailedSessionTurn(
    sessionId: string,
    request: import("../session/session-turn-queue.js").RetryFailedSessionTurnRequest,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueAcceptanceResult
  >;
  /** 待機入力を画面が確認した実行中 Turn へ送り、別の Turn に切り替わっていないか照合する。 */
  sendQueuedSessionInput(
    sessionId: string,
    id: string,
    expectedTurnId: string,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt
  >;
  /** クライアントの要求 ID で保存済みの受付を照合する。受付が見つからなければ null。 */
  getSessionTurnQueueReceipt(
    sessionId: string,
    requestId: string,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt | null
  >;
  /** 会話の待機欄を更新するために、その Session の現在のキュー項目を取得する。 */
  listSessionTurnQueue(
    sessionId: string,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt[]
  >;
  /** 現在の待機欄とは別に、受付の履歴をカーソルと件数でページ取得する。 */
  listSessionTurnQueueReceipts(
    sessionId: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceiptPage
  >;
  /** 待機中の入力を受付 ID で取り消す。進行中 Turn 全体を止める操作ではない。 */
  cancelQueuedSessionTurn(
    sessionId: string,
    id: string,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt
  >;
  /** 対象の待機入力を編集に取り置きし、編集用に現在の受付内容を返す。 */
  beginQueuedSessionTurnEdit(
    sessionId: string,
    request: import("../session/session-turn-queue.js").QueuedSessionTurnEditRequest,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt
  >;
  /** 編集のため取り置いた待機入力の本文を差し替え、更新後の受付を返す。 */
  updateQueuedSessionTurn(
    sessionId: string,
    request: import("../session/session-turn-queue.js").UpdateQueuedSessionTurnRequest,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReceipt
  >;
  /** 本文を差し替えずに待機入力の編集を終え、編集による取り置きを解除する。 */
  cancelQueuedSessionTurnEdit(
    sessionId: string,
    request: import("../session/session-turn-queue.js").QueuedSessionTurnEditRequest,
  ): Promise<void>;
  /** 画面が見ていた受付の順序が現在も一致するときに並べ替え、競合時は現在の受付一覧を返す。 */
  reorderQueuedSessionTurns(
    sessionId: string,
    request: import("../session/session-turn-queue.js").ReorderQueuedSessionTurnsRequest,
  ): Promise<
    import("../session/session-turn-queue.js").SessionTurnQueueReorderResult
  >;
  /** 新しい Turn を作らず、指定した実行中 Turn に直接追加入力を送る。 */
  steerSessionTurn(
    sessionId: string,
    request: import("../session/runtime-state.js").SteerSessionTurnRequest,
  ): Promise<import("../session/runtime-state.js").SteerSessionTurnResult>;
  /** 所有ウィンドウから対象の Main 実行に停止を要求する。待機入力の個別取り消しとは別の操作。 */
  cancelSessionRun(request: CancelSessionRunRequest): Promise<void>;
  /** 所有ウィンドウで最新の保存済み Turn 記録を読み、記録がなければ null を返す。 */
  getLatestSessionTurn(sessionId: string): Promise<SessionTurnRecord | null>;
  /** 会話に未読の実行結果があるときに、その結果を示す情報を返す。照会だけでは既読にしない。 */
  getUnreadSessionResult(
    sessionId: string,
  ): Promise<
    import("../session/session-turn-state.js").UnreadSessionResult | null
  >;
  /** 前面で閲覧中のウィンドウから指定 Turn の結果を既読にし、反映されたかを返す。 */
  markSessionResultRead(sessionId: string, turnId: number): Promise<boolean>;
  /** 会話の初期表示用に現在の詳細な実行状態を読み、現在値がなければ null を返す。 */
  getLiveSessionRun(sessionId: string): Promise<LiveSessionRunState | null>;
  /** 保留中の承認要求を ID で特定し、ユーザーが選んだ承認判断を実行側へ返す。 */
  resolveLiveApproval(
    sessionId: string,
    requestId: string,
    decision: LiveApprovalDecision,
  ): Promise<void>;
  /** 承認とは別の入力要求を ID で特定し、実行中のプロバイダーへユーザーの回答を返す。 */
  resolveLiveElicitation(
    sessionId: string,
    requestId: string,
    response: LiveElicitationResponse,
  ): Promise<void>;
};

/** 一つの Main Session に所属する Auxiliary 会話の作成、保存と実行を扱う契約。 */
export type WithMateWindowAuxiliaryApi = {
  /** 親の会話ウィンドウで切り替えられる Auxiliary を、概要の一覧として返す。 */
  listAuxiliarySessions(
    parentSessionId: string,
  ): Promise<AuxiliarySessionSummary[]>;
  /** 現在開いている Main Session ウィンドウを対象に、その配下の Auxiliary の概要を取得する。 */
  listOpenAuxiliarySessionSummaries(): Promise<AuxiliarySessionSummary[]>;
  /** 指定した親に属する最新の Auxiliary の会話状態を返す。該当する会話がなければ null。 */
  getLatestAuxiliarySession(
    parentSessionId: string,
  ): Promise<AuxiliarySession | null>;
  /** 選択された Auxiliary の ID で会話状態を読み、対象がなければ null を返す。 */
  getAuxiliarySession(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySession | null>;
  /** Auxiliary の入力欄を復元するため、保存済みの未送信本文とリビジョンを読む。 */
  getAuxiliaryDraft(
    auxiliarySessionId: string,
  ): Promise<AuxiliaryDraftRecord | null>;
  /** 下書きの世代と期待リビジョンを照合して保存し、古い書き込みを成功と区別して返す。 */
  saveAuxiliaryDraft(
    input: AuxiliaryDraftSaveInput,
  ): Promise<AuxiliaryDraftSaveResult>;
  /** Auxiliary の選択時に、会話本文を読まずに現在の実行状態を取得する。 */
  getAuxiliarySessionStatus(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySessionStatus | null>;
  /** 親の会話から Auxiliary を作成し、選択や表示に用いる保存済みの会話状態を返す。 */
  createAuxiliarySession(
    input: CreateAuxiliarySessionInput,
  ): Promise<AuxiliarySession>;
  /** 作成フォームが要求に添える、親の世代と現在の作成受付の世代を取得する。 */
  getAuxiliaryCreationContext(
    parentSessionId: string,
  ): Promise<
    import("../auxiliary/auxiliary-session-state.js").AuxiliaryCreationContext
  >;
  /** 処理中の作成要求を特定して取り消しを求め、すでに確定した場合も最終状態を区別できるようにする。 */
  cancelAuxiliaryCreation(
    request: import("../auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
  ): Promise<
    import("../auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
  >;
  /** 作成応答を確認できなかった場合などに、同じ要求を再送せず、処理の到達状態を照会する。 */
  getAuxiliaryCreation(
    request: import("../auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
  ): Promise<
    import("../auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
  >;
  /** 保存済み Auxiliary の更新候補を渡し、Main の保存処理が反映した会話状態を返す。 */
  updateAuxiliarySession(session: AuxiliarySession): Promise<AuxiliarySession>;
  /** 親とは独立した Auxiliary の次回以降の実行設定を保存し、受理結果を返す。 */
  setAuxiliaryExecutionOptions(
    request: SetAuxiliaryExecutionOptionsRequest,
  ): Promise<SetExecutionOptionsResult>;
  /** 対象の親と Auxiliary を照合し、Auxiliary の件名だけを変更する。 */
  setAuxiliaryTitle(request: SetAuxiliaryTitleRequest): Promise<void>;
  /** Auxiliary 内の保存済みメッセージに対し、ブックマークの有無を更新する。 */
  setAuxiliaryMessageBookmark(
    request: SetAuxiliaryMessageBookmarkRequest,
  ): Promise<void>;
  /** Auxiliary に新しい Turn の入力を送り、実行結果を反映した Auxiliary の会話状態を待つ。 */
  runAuxiliarySessionTurn(
    auxiliarySessionId: string,
    request: RunSessionTurnRequest,
  ): Promise<AuxiliarySession>;
  /** 対象の実行中 Auxiliary Turn を指定して補足を送る。新規 Turn の開始とは区別する。 */
  steerAuxiliarySessionTurn(
    auxiliarySessionId: string,
    request: import("../session/runtime-state.js").SteerSessionTurnRequest,
  ): Promise<import("../session/runtime-state.js").SteerSessionTurnResult>;
  /** 親の会話ウィンドウから指定 Auxiliary の実行に停止を要求する。 */
  cancelAuxiliarySessionRun(request: CancelSessionRunRequest): Promise<void>;
};

/** renderer の診断記録と、画面で共有する現在の観測値を扱う契約。 */
export type WithMateWindowObservabilityApi = {
  /** renderer が観測した診断イベントを Main のログ経路へ送り、保存応答は待たない。 */
  reportRendererLog(input: RendererLogInput): void;
  /** 利用枠の観測値を取得する。表示時に問い合わせを起こしたくない場合はキャッシュのみに絞れる。 */
  getProviderQuotaTelemetry(
    providerId: string,
    options?: { cacheOnly?: boolean },
  ): Promise<ProviderQuotaTelemetry | null>;
  /** 指定 Session の会話コンテキストの利用状況を読み、利用できる観測値がなければ null を返す。 */
  getSessionContextTelemetry(
    sessionId: string,
  ): Promise<SessionContextTelemetry | null>;
  /** 開いている会話ウィンドウの Session ID をまとめて返す。ページの結合と重複排除は preload が行う。 */
  listOpenSessionWindowIds(): Promise<string[]>;
};

/** アプリ共通設定と、設定画面から行うデータ診断・保守操作の契約。 */
export type WithMateWindowSettingsApi = {
  /** 設定画面の版表示に使う、現在実行しているアプリのバージョンを返す。 */
  getAppVersion(): Promise<string>;
  /** 設定画面や会話の初期表示に使う、現在有効なアプリ共通設定を読む。 */
  getAppSettings(): Promise<AppSettings>;
  /** アプリ共通設定の変更を保存し、画面の更新に用いる保存後の設定を返す。 */
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  /** チャットレイアウトの変更項目だけを保存し、他のアプリ設定を一括で置き換えない。 */
  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): Promise<void>;
  /** データベースの診断画面に必要な情報を読み取る。初期化や削除は行わない。 */
  getAppDatabaseDiagnostics(): Promise<AppDatabaseDiagnostics>;
  /** 指定条件で SessionFolder の整理候補を調べ、確認用の結果と実行時に使う ID を返す。 */
  scanSessionFolderCleanup(
    request: SessionFolderCleanupRequest,
  ): Promise<SessionFolderCleanupScan>;
  /** 有効なスキャン ID の整理候補を再確認して処理する。期限切れならスキャンからやり直す。 */
  runSessionFolderCleanup(request: {
    scanId: string;
  }): Promise<SessionFolderCleanupResult>;
  /** 設定画面で指定した対象を初期化し、処理の結果を返す。 */
  resetAppDatabase(
    request: ResetAppDatabaseRequest,
  ): Promise<ResetAppDatabaseResult>;
  /** 設定画面から最終活動日時が指定期限より古い Session の一括削除を要求する。 */
  deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest,
  ): Promise<DeleteSessionsResult>;
};

/** 入力欄で再利用するプロンプトテンプレートの一覧、保存、更新通知を扱う契約。 */
export type WithMateWindowPromptTemplateApi = {
  /** 入力欄の選択肢やテンプレート管理画面を初期表示するため、保存済みの一覧を読む。 */
  listPromptTemplates(): Promise<PromptTemplate[]>;
  /** 入力したテンプレートを新規登録し、一覧の差し替えに使う登録後の全件を返す。 */
  createPromptTemplate(
    input: CreatePromptTemplateInput,
  ): Promise<PromptTemplate[]>;
  /** 保存済みテンプレートを ID で指定して変更し、更新後の一覧を返す。 */
  updatePromptTemplate(
    input: UpdatePromptTemplateInput,
  ): Promise<PromptTemplate[]>;
  /** 指定テンプレートを削除し、画面が保持する一覧を置き換えられるよう残りの全件を返す。 */
  deletePromptTemplate(id: string): Promise<PromptTemplate[]>;
  /** 他の画面での変更も反映できるよう保存後のテンプレート一覧を受け取り、購読解除関数を返す。 */
  subscribePromptTemplates(
    listener: (templates: PromptTemplate[]) => void,
  ): () => void;
};

/** OS の選択ダイアログと、添付元の確認や SessionFolder への取り込みを扱う契約。 */
export type WithMateWindowPickerApi = {
  /** Home で入力されたパスを作業ディレクトリに使えるか、Session 作成前に確認する。 */
  validateWorkspaceDirectory(
    targetPath: string,
  ): Promise<WorkspaceDirectoryValidationResult>;
  /** 任意の初期位置から単一のフォルダーを選ぶ。選択を取り消した場合は null。 */
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  /** 単一のファイルを OS ダイアログで選ぶ。選択しなければ null を返し、ファイルの読み込みは行わない。 */
  pickFile(initialPath?: string | null): Promise<string | null>;
  /** 複数のファイルを一度に選び、選択を取り消した場合は空配列を返す。 */
  pickFiles(initialPath?: string | null): Promise<string[]>;
  /** SessionFolder を起点に複数ファイルを選び、フォルダー外の選択は返さない。 */
  pickSessionFiles(sessionId: string): Promise<string[]>;
  /** SessionFolder 内からフォルダーを一つ選ぶ。取り消しや外部の選択は null。 */
  pickSessionFolder(sessionId: string): Promise<string | null>;
  /** SessionFolder 内の画像ファイルを一つ選び、取り消しや外部の選択は null を返す。 */
  pickSessionImageFile(sessionId: string): Promise<string | null>;
  /** 画像選択ダイアログを開き、一般画像と Character アイコンで選択フィルターを切り替えられる。 */
  pickImageFile(
    initialPath?: string | null,
    purpose?: ImageFilePickerPurpose,
  ): Promise<string | null>;
  /** 選択された外部ファイルを指定 SessionFolder に複製し、取り込み後のパスを返す。 */
  copyFilesToSessionFiles(
    sessionId: string,
    sourcePaths: string[],
  ): Promise<string[]>;
  /** 貼り付けデータを SessionFolder に保存し、新規保存、既存ファイルの再利用、名前の衝突を区別して返す。 */
  savePastedSessionFile(
    request: SavePastedSessionFileRequest,
  ): Promise<SavePastedSessionFileResult>;
  /** Session のワークスペースではなく、SessionFolder を OS のファイルマネージャーで開く。 */
  openSessionFilesDirectory(sessionId: string): Promise<void>;
  /** SessionFolder を開始ディレクトリにして外部端末を起動する。 */
  openSessionFilesTerminal(sessionId: string): Promise<void>;
};

/** Main からの更新通知と下書き保存の応答を扱う。各購読は呼び出し元が解除できる。 */
export type WithMateWindowSubscriptionApi = {
  /** 保存済み Turn が更新された Session の ID を受け取り、必要な記録だけ読み直す。 */
  onSessionTurnUpdated(listener: (sessionId: string) => void): () => void;
  /** 待機入力の状態が変わった Session を受け取り、当該キューを更新する。 */
  onSessionTurnQueueChanged(listener: (sessionId: string) => void): () => void;
  /** 送信済み配送の一覧を再取得すべき送信元 Session の ID を受け取る。 */
  onSessionSentDeliveriesChanged(
    listener: (sourceSessionId: string) => void,
  ): () => void;
  /** ウィンドウ閉鎖やアプリ終了に先立ち、指定 Session の下書きを保存する要求を受け取る。 */
  subscribeSessionDraftFlushRequest(
    listener: (request: {
      requestId: string;
      sessionId: string;
      reason: "close" | "quit";
    }) => void,
  ): () => void;
  /** 下書き確定待ちの解除を受け取り、保存の成否に応じて入力側の保留状態を解く。 */
  subscribeSessionDraftFlushRelease(
    listener: (payload: { success: boolean }) => void,
  ): () => void;
  /** 下書きを確定できたかどうかを、先に受け取った要求 ID に対応付けて Main へ返す。 */
  acknowledgeSessionDraftFlush(requestId: string, success: boolean): void;
  /** 起動画面の初期表示に使う、現在の起動段階と進捗を取得する。 */
  getAppBootStatus(): Promise<AppBootStatus>;
  /** 初期状態の取得とは別に、以降の起動段階や進捗の変化を受け取る。 */
  subscribeAppBootStatus(listener: (status: AppBootStatus) => void): () => void;
  /** 再利用された独立プレビューで、表示内容を切り替えるための新しい対象を受け取る。 */
  subscribeSessionFilePreviewNavigation(
    listener: (payload: SessionFilePreviewWindowPayload) => void,
  ): () => void;
  /** 独立プレビューの開閉などで一覧の再取得が必要になったことを受け取る。通知に一覧自体は含まれない。 */
  subscribeSessionFilePreviewWindowsChanged(listener: () => void): () => void;
  /** キャッシュしている Session 概要のどの範囲を読み直すべきか通知を受ける。 */
  subscribeSessionInvalidation(
    listener: (payload: SessionSummaryInvalidation) => void,
  ): () => void;
  /** モデル選択肢を差し替えるため、Main で更新されたカタログを受け取る。 */
  subscribeModelCatalog(
    listener: (catalog: ModelCatalogSnapshot) => void,
  ): () => void;
  /** 別ウィンドウの変更も反映できるよう、保存後に配信されるアプリ共通設定を受け取る。 */
  subscribeAppSettings(listener: (settings: AppSettings) => void): () => void;
  /** 会話の所有ウィンドウで詳細な実行状態を受け取り、値がなくなった場合は null で扱う。 */
  subscribeLiveSessionRun(
    listener: (sessionId: string, state: LiveSessionRunState | null) => void,
  ): () => void;
  /** 監視用に実行の状態だけを受け取り、詳細な本文や操作要求には依存しない。 */
  subscribeLiveSessionRunStatus(
    listener: (sessionId: string, status: LiveSessionRunStatus | null) => void,
  ): () => void;
  /** 親会話で選択された Auxiliary の情報を受け取る。表示先を指定するナビゲーション要求とは別。 */
  subscribeAuxiliarySessionSelection(
    listener: (payload: AuxiliarySessionSelectionPayload) => void,
  ): () => void;
  /** プロバイダー別の利用枠の観測値を受け取り、値を解除する通知は null で受け取る。 */
  subscribeProviderQuotaTelemetry(
    listener: (
      providerId: string,
      telemetry: ProviderQuotaTelemetry | null,
    ) => void,
  ): () => void;
  /** 会話コンテキストの観測値が変わった Session と、その新しい値を受け取る。 */
  subscribeSessionContextTelemetry(
    listener: (
      sessionId: string,
      telemetry: SessionContextTelemetry | null,
    ) => void,
  ): () => void;
  /** 用語集の参照先や利用状態が変わったとき、Session 用語集表示を更新するための情報を受け取る。 */
  subscribeSessionGlossary(
    listener: (projection: SessionGlossaryProjection) => void,
  ): () => void;
  /** 開いている会話ウィンドウの集合を受け取る。再取得が必要な通知ではページを揃えてから渡す。 */
  subscribeOpenSessionWindowIds(
    listener: (sessionIds: string[]) => void,
  ): () => void;
  /** Home に表示する前回ウィンドウの未復元候補を更新するため、現在の候補集合を受け取る。 */
  subscribeSessionWindowRestoreSet(
    listener: (sessionIds: string[]) => void,
  ): () => void;
  /** 親会話ウィンドウで指定の Auxiliary へ移動するため、親と対象を含む指示を受け取る。 */
  subscribeAuxiliarySessionNavigation(
    listener: (payload: AuxiliarySessionNavigationPayload) => void,
  ): () => void;
};

/** ローカルの Mate プロフィールの有無・内容を読み、利用者が編集するための契約。 */
export type WithMateWindowMateApi = {
  /** Mate を作成していない状態と、作成済みだが利用できない状態を区別して返す。 */
  getMateState(): Promise<MateStorageState>;
  /** 編集や表示用に保存済みの Mate プロフィールを読み、取得できなければ null を返す。 */
  getMateProfile(): Promise<MateProfile | null>;
  /** 初期の表示名や任意の説明・外観を保存して、作成した Mate プロフィールを返す。 */
  createMate(input: CreateMateInput): Promise<MateProfile>;
  /** Mate の表示名・説明・配色のうち指定された項目を保存する。アバターは別の操作で扱う。 */
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  /** 選択した画像を Mate のアバターとして設定し、指定がなければ画像なしにできる。 */
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  /** 保存済みの Mate プロフィールをリセットし、初期設定から作成できる状態に戻す。 */
  resetMate(): Promise<void>;
};

/** Character カタログ、編集用の保存データと、起動・制作に使う操作の契約。 */
export type WithMateWindowCharacterApi = {
  /** Character の候補一覧を読む。管理画面ではアーカイブ済みを含める指定もできる。 */
  listCharacters(options?: {
    includeArchived?: boolean;
  }): Promise<CharacterCatalogEntry[]>;
  /** 一覧用の項目だけでなく、指定 Character の編集に使う定義本文なども取得する。 */
  getCharacter(characterId: string): Promise<CharacterDetail | null>;
  /** 初期の表示情報と定義を登録し、保存先で確定した Character の詳細を返す。 */
  createCharacter(input: CreateCharacterInput): Promise<CharacterDetail>;
  /** 名前や説明、アイコン、配色などの表示情報を部分更新する。定義本文は別経路で保存する。 */
  updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Promise<CharacterDetail>;
  /** Character の指示定義とノートを変更し、保存後の詳細を返す。 */
  updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Promise<CharacterDetail>;
  /** 既存 Character をアーカイブし、新規 Session の起動候補から外す。 */
  archiveCharacter(characterId: string): Promise<CharacterCatalogEntry>;
  /** 新規 Session の起動に使う Character を選択 ID から解決する。未指定や無効な候補は null。 */
  resolveLaunchCharacter(
    input?: ResolveLaunchCharacterInput | null,
  ): Promise<CharacterDetail | null>;
  /** 普通のカタログ編集とは別に、Character の新規制作または改稿を支援する Session を開始する。 */
  startCharacterAuthoringSession(
    input: StartCharacterAuthoringSessionInput,
  ): Promise<CharacterAuthoringSessionStartResult>;
};

/** preload がウィンドウに公開する、機能別の renderer 向け API をまとめた契約。 */
export type WithMateWindowApi = {
  /** 貼り付けた File に OS の実ファイルが対応するかだけを判定し、パス自体は公開しない。 */
  isClipboardFileBacked(file: unknown): boolean;
} & WithMateHtmlPreviewApi &
  import("../coordination/coordination-window-contract.js").CoordinationWindowApi &
  import("../session/session-execution-window-contract.js").SessionExecutionWindowApi &
  WithMateWindowNavigationApi &
  WithMateWindowCatalogApi &
  WithMateWindowAuxiliaryApi &
  WithMateWindowSessionApi &
  WithMateWindowObservabilityApi &
  WithMateWindowSettingsApi &
  WithMateWindowPromptTemplateApi &
  WithMateWindowPickerApi &
  WithMateWindowSubscriptionApi &
  WithMateWindowMateApi &
  WithMateWindowCharacterApi &
  WithMateWindowTerminalApi;

/** 会話ウィンドウの組み込み端末を、Main が所有する PTY に接続する契約。 */
export type WithMateWindowTerminalApi = {
  /** 端末 ID と初期の列数・行数を指定し、所有 Session のワークスペースでシェルを起動する。 */
  createTerminal(request: CreateTerminalRequest): Promise<CreateTerminalResult>;
  /** 端末のタイプ入力を指定 ID の PTY へ送り、書き込み結果は同期の戻り値で待たない。 */
  writeTerminalInput(terminalId: string, data: string): void;
  /** 端末の表示領域が変わったとき、ピクセルではなく文字の列数と行数を PTY に通知する。 */
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  /** 表示側で処理した出力の文字数を通知し、Main が保留している出力を再開できるようにする。 */
  acknowledgeTerminalOutput(terminalId: string, characters: number): void;
  /** ユーザー操作による端末終了を求める。必要な終了確認が取り消された場合は false。 */
  closeTerminal(terminalId: string): Promise<boolean>;
  /** 表示側が端末を使い終えたとき、終了確認を出さずにその端末の資源を解放する。 */
  releaseTerminal(terminalId: string): Promise<void>;
  /** ウィンドウが所有する端末の出力、状態、終了や操作エラーを、端末 ID 付きで受け取る。 */
  subscribeTerminalEvents(listener: (event: TerminalEvent) => void): () => void;
};
