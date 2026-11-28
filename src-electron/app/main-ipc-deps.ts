import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type {
  SessionFolderCleanupRequest,
  SessionFolderCleanupScan,
  SessionFolderCleanupResult,
} from "../../src-shared/session/session-folder-cleanup.js";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";

import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type {
  CancelSessionRunRequest,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import type {
  SessionCharacterUsage,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../src-shared/window/markdown-link-context-menu.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../../src-shared/character/character-authoring.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import type {
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type { ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
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
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyRequest,
  SessionFileObjectCopyResult,
} from "../../src-shared/file-explorer/session-file-object-copy-contract.js";
import type {
  GlossaryListResult,
  GlossaryOperationResult,
  GlossarySearchRequest,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
} from "../../src-shared/session/runtime-state.js";
import type {
  CreateSessionRequest,
  DiffPreviewPayload,
  MessageArtifact,
  Session,
  SetSessionPinnedRequest,
} from "../../src-shared/session/session-state.js";
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
} from "../../src-shared/session/session-mutation-contract.js";
import type {
  ImageFilePickerPurpose,
  OpenPathOptions,
  DeleteSessionsLastActiveBeforeRequest,
  DeleteSessionsResult,
  ResetAppDatabaseRequest,
  SavePastedSessionFileRequest,
  SavePastedSessionFileResult,
  OpenPathResult,
  OpenSessionWindowIdsPageRequest,
  OpenSessionWindowIdsPageResult,
  SessionMonitorPageResult,
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../../src-shared/mate/mate-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../../src-shared/prompt-template.js";
import type {
  LogIpcErrorInput,
  MainIpcRegistrationDeps,
  MainIpcWindowDeps,
} from "../ipc/contracts.js";
import { createAuxiliaryIpcDeps } from "../ipc/auxiliary.js";
import { createCatalogIpcDeps } from "../ipc/catalog.js";
import { createSessionQueryIpcDeps } from "../ipc/session-query.js";
import {
  createSessionRuntimeIpcDeps,
  type MainIpcSessionRuntimeServiceDeps,
} from "../ipc/session-runtime.js";
import type { MainIpcSessionInstructionsDeps } from "../ipc/session-instructions.js";
import { createSettingsIpcDeps } from "../ipc/settings.js";
import { createWindowIpcDeps } from "../ipc/window.js";
import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";

/** 未生成または解決できなかった場合も扱うウィンドウ参照。 */
type MaybeWindow = BrowserWindow | null | undefined;

/** ウィンドウ操作と、IPC の送信元を特定するために Main が供給する依存。 */
export type MainIpcWindowDepsArgs = {
  listHomeCrewPage: MainIpcWindowDeps["listHomeCrewPage"];
  showHomeCrewContextMenu: MainIpcWindowDeps["showHomeCrewContextMenu"];
  showSessionFilePreviewContextMenu: MainIpcWindowDeps["showSessionFilePreviewContextMenu"];
  listSessionFilePreviewWindows: MainIpcWindowDeps["listSessionFilePreviewWindows"];
  focusSessionFilePreviewWindow: MainIpcWindowDeps["focusSessionFilePreviewWindow"];
  closeSessionFilePreviewWindow: MainIpcWindowDeps["closeSessionFilePreviewWindow"];
  closeSessionFilePreviewWindows: MainIpcWindowDeps["closeSessionFilePreviewWindows"];
  /** 終了処理で要求した下書き保存の成否を、要求 ID と送信元に対応付けて受け取る。 */
  acknowledgeSessionDraftFlush(
    event: Pick<IpcMainInvokeEvent, "sender">,
    payload: { requestId: string; success: boolean },
  ): void;
  /** IPC の送信元 WebContents から所属ウィンドウを解決する。 */
  resolveEventWindow(event: IpcMainInvokeEvent): MaybeWindow;
  /** 現在の Home ウィンドウを、未生成なら開かずに取得する。 */
  resolveHomeWindow(): MaybeWindow;
  /** 渡されたセッション ID に対応する既存ウィンドウを取得する。 */
  resolveSessionWindow(sessionId: string): MaybeWindow;
  /** 通常セッションを開き、補助セッション ID があれば同じウィンドウでその会話を指定する。 */
  openSessionWindow(
    sessionId: string,
    auxiliarySessionId?: string,
  ): Promise<BrowserWindow>;
  /** 送信元のウィンドウを基準に Session Monitor のネイティブメニューを表示する。 */
  showSessionMonitorContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionMonitorContextMenuRequest,
  ): Awaitable<SessionMonitorContextMenuResult>;
  /** 復元対象として保存されているセッション ID を取得する。 */
  getSessionWindowRestoreSet(): Promise<string[]>;
  /** 保存されたセッションウィンドウの復元を試み、開けた対象と失敗を返す。 */
  restoreSessionWindows(): Promise<SessionWindowRestoreResult>;
  /** Home ウィンドウを開く。 */
  openHomeWindow(): Promise<BrowserWindow>;
  /** セッションの進行状況を確認する Session Monitor を開く。 */
  openSessionMonitorWindow(): Promise<BrowserWindow>;
  /** アプリ設定を操作する専用ウィンドウを開く。 */
  openSettingsWindow(): Promise<BrowserWindow>;
  /** 渡されたウィンドウが現在の Session Monitor かを判定する。 */
  isSessionMonitorWindow(window: BrowserWindow): boolean;
  /** 設定専用の IPC を利用できる Settings ウィンドウかを判定する。 */
  isSettingsWindow(window: BrowserWindow): boolean;
  /** Character エディターを開き、ID が指定されていれば編集対象を渡す。 */
  openCharacterEditorWindow(
    characterId?: string | null,
  ): Promise<BrowserWindow>;
  /** 指定された差分を表示する専用ウィンドウを開く。 */
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  /** 渡されたプレビューウィンドウが指定セッションに属するかを判定する。 */
  isFilePreviewWindow(window: BrowserWindow, sessionId: string): boolean;
  /** 指定セッションのプレビューにひも付くリソースを、要求されたパス表現で取得する。 */
  getFilePreviewWindowResource(
    window: BrowserWindow,
    sessionId: string,
    representation?: "source" | "absolute",
  ): SessionFilePreviewResourceRequest | null;
  /** プレビュー用トークンと送信元ウィンドウの組み合わせが一致するかを判定する。 */
  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean;
  /** 初期位置を指定できるフォルダー選択ダイアログを開き、取り消し時は null を返す。 */
  pickDirectory(
    targetWindow: MaybeWindow,
    initialPath: string | null,
  ): Promise<string | null>;
  /** IPC で受け取った値を、ワークスペースとして選択できるフォルダーか検査する。 */
  validateWorkspaceDirectory(
    targetPath: unknown,
  ): Promise<WorkspaceDirectoryValidationResult>;
  /** ファイルを一つ選択するダイアログを開き、取り消し時は null を返す。 */
  pickFile(
    targetWindow: MaybeWindow,
    initialPath: string | null,
  ): Promise<string | null>;
  /** 複数ファイルを選択するダイアログを開き、取り消し時は空配列を返す。 */
  pickFiles(
    targetWindow: MaybeWindow,
    initialPath: string | null,
  ): Promise<string[]>;
  /** Session Folder を起点にファイルを選択し、その範囲内のパスだけを返す。 */
  pickSessionFiles(
    targetWindow: MaybeWindow,
    sessionId: string,
  ): Promise<string[]>;
  /** Session Folder 内からフォルダーを選択し、範囲内の選択がなければ null を返す。 */
  pickSessionFolder(
    targetWindow: MaybeWindow,
    sessionId: string,
  ): Promise<string | null>;
  /** Session Folder 内から画像を選択し、範囲内の選択がなければ null を返す。 */
  pickSessionImageFile(
    targetWindow: MaybeWindow,
    sessionId: string,
  ): Promise<string | null>;
  /** 用途に応じた画像ファイル選択ダイアログを開き、取り消し時は null を返す。 */
  pickImageFile(
    targetWindow: MaybeWindow,
    initialPath: string | null,
    purpose: ImageFilePickerPurpose,
  ): Promise<string | null>;
  /** 選択されたファイルを Session Folder にコピーし、コピー先のパスを返す。 */
  copyFilesToSessionFiles(
    sessionId: string,
    sourcePaths: string[],
  ): Promise<string[]>;
  /** 貼り付けられたデータをセッションの添付ファイルとして保存する。 */
  savePastedSessionFile(
    request: SavePastedSessionFileRequest,
  ): Promise<SavePastedSessionFileResult>;
  /** Session Folder を OS のファイルマネージャーで開く。 */
  openSessionFilesDirectory(sessionId: string): Promise<void>;
  /** Session Folder を作業ディレクトリとする端末を開く。 */
  openSessionFilesTerminal(sessionId: string): Promise<void>;
  /** 送信元プレビューの指定位置にある画像をクリップボードにコピーする。 */
  copySessionFilePreviewImage(
    event: IpcMainInvokeEvent,
    request: SessionFilePreviewImageActionRequest,
  ): Awaitable<SessionFilePreviewImageCopyResult>;
  /** プレビュー画像のメニューを開き、画像リソースを使う操作に送信元の再検証を渡す。 */
  showSessionFilePreviewImageContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFilePreviewImageActionRequest,
    assertSender: () => Promise<void>,
  ): Awaitable<SessionFilePreviewImageContextMenuResult>;
  /** 指定のセッションリソースを OS 上のファイルとしてクリップボードに載せる。 */
  copySessionFileObject(
    event: IpcMainInvokeEvent,
    request: SessionFileObjectCopyRequest,
  ): Awaitable<SessionFileObjectCopyResult>;
  /** セッションのファイル自体をコピーするためのネイティブメニューを開く。 */
  showSessionFileObjectCopyContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFileObjectCopyContextMenuRequest,
  ): Awaitable<SessionFileObjectCopyContextMenuResult>;
  /** ファイルツリーの項目で使えるパス操作をネイティブメニューに表示する。 */
  showSessionFileTreeContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFileTreePathActionRequest,
  ): Awaitable<SessionFileTreePathActionContextMenuResult>;
  /** Markdown リンクに対する操作を、送信元の位置情報を使ってメニューに表示する。 */
  showMarkdownLinkContextMenu(
    event: IpcMainInvokeEvent,
    request: MarkdownLinkContextMenuRequest,
  ): Awaitable<MarkdownLinkContextMenuResult>;
  /** ローカルパスや URL を対象の種類に応じて開き、操作結果を返す。 */
  openPathTarget(
    target: string,
    options?: OpenPathOptions,
  ): Promise<OpenPathResult>;
  /** アプリログの保存先を OS のファイルマネージャーで開く。 */
  openAppLogFolder(): Promise<void>;
  /** クラッシュダンプの保存先を OS のファイルマネージャーで開く。 */
  openCrashDumpFolder(): Promise<void>;
  /** 指定セッションのワークスペースを作業場所とする端末を開く。 */
  openSessionTerminal(sessionId: string): Promise<void>;
  /** 指定パスを起点に端末を開く。 */
  openTerminalAtPath(target: string): Promise<void>;
  /** 利用可能なら IPC 処理で捕捉した失敗を Main のログに記録する。 */
  logIpcError?: (input: LogIpcErrorInput) => void;
  /** 利用可能なら Renderer の報告を、判明したウィンドウ ID とともに記録する。 */
  reportRendererLog?: (input: RendererLogInput, windowId?: number) => void;
};

/** モデル候補を取得するカタログ IPC の依存。 */
export type MainIpcCatalogDepsArgs = {
  /** 要求に応じてプロバイダーのモデル候補を取得し、利用できなければ null を返す。 */
  getModelCatalog(
    request?: ModelCatalogRequest,
  ): Awaitable<ModelCatalogSnapshot | null>;
};

/** 設定の読み書きと、Settings から呼び出すデータ保守操作の依存。 */
export type MainIpcSettingsDepsArgs = {
  /** 実行中のアプリが報告するバージョンを取得する。 */
  getAppVersion(): string;
  /** 保存済みのアプリ設定を取得する。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** アプリ設定を更新し、更新結果を返す。 */
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  /** チャットのレイアウト設定について、要求された変更だけを保存する。 */
  updateChatLayoutPreference(
    update: ChatLayoutPreferenceUpdate,
  ): Awaitable<void>;
  /** 設定画面で表示するアプリデータベースの診断情報を取得する。 */
  getAppDatabaseDiagnostics(): Awaitable<AppDatabaseDiagnostics>;
  /** Session Folder の整理候補を調べ、実行時に使うスキャン結果を返す。 */
  scanSessionFolderCleanup(
    request: SessionFolderCleanupRequest,
  ): Promise<SessionFolderCleanupScan>;
  /** スキャン ID で指定された整理を実行し、処理結果を返す。 */
  runSessionFolderCleanup(request: {
    scanId: string;
  }): Promise<SessionFolderCleanupResult>;
  /** アプリデータベースの初期化を保守処理として実行する。 */
  resetAppDatabase(
    request: ResetAppDatabaseRequest | null | undefined,
  ): Promise<unknown>;
};

/** 保存したプロンプトテンプレートの一覧取得と変更を担う依存。 */
export type MainIpcPromptTemplateDepsArgs = {
  /** 現在利用できるプロンプトテンプレートの一覧を取得する。 */
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  /** テンプレートを登録し、保存後の一覧を返す。 */
  createPromptTemplate(
    input: CreatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  /** 既存テンプレートの編集を保存し、更新後の一覧を返す。 */
  updatePromptTemplate(
    input: UpdatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  /** 指定 ID のテンプレートを削除し、削除後の一覧を返す。 */
  deletePromptTemplate(id: string): Awaitable<PromptTemplate[]>;
};

/** セッションの表示データ、会話、参照可能なファイルを扱う IPC の依存。 */
export type MainIpcSessionQueryDepsArgs = {
  getConversationOwnerSessionId?: import("../ipc/contracts.js").MainIpcSessionQueryDeps["getConversationOwnerSessionId"];
  getConversationPage?: import("../ipc/contracts.js").MainIpcSessionQueryDeps["getConversationPage"];
  resolveConversationQueryOwner?: import("../ipc/contracts.js").MainIpcSessionQueryDeps["resolveConversationQueryOwner"];
  /** 指定範囲とカーソルに従って Home 用のセッション要約を取得する。 */
  listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): Awaitable<HomeSessionSummaryPageResult>;
  /** 監視対象セッションとその補助セッションの状態をページ単位で取得する。 */
  listSessionMonitorPage(request: {
    cursor: string | null;
    limit: number;
  }): Awaitable<SessionMonitorPageResult>;
  /** 保存されているセッションの Character 利用状況を取得する。 */
  listSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
  /** 指定セッションに最後に記録されたターンを取得し、なければ null を返す。 */
  getLatestSessionTurn(sessionId: string): Awaitable<SessionTurnRecord | null>;
  getUnreadSessionResult: import("../ipc/contracts.js").MainIpcSessionQueryDeps["getUnreadSessionResult"];
  markSessionResultRead: import("../ipc/contracts.js").MainIpcSessionQueryDeps["markSessionResultRead"];
  /** 指定セッションの実行環境で見つかったスキルを取得する。 */
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  /** 指定セッションの実行環境で見つかったカスタムエージェントを取得する。 */
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  /** セッションを指定せず、プロバイダーとワークスペースを基にスキルを取得する。 */
  listWorkspaceSkills(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredSkill[]>;
  /** セッションを指定せず、プロバイダーとワークスペースを基にカスタムエージェントを取得する。 */
  listWorkspaceCustomAgents(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredCustomAgent[]>;
  /** ウィンドウが開いているセッションの ID をページ単位で取得する。 */
  listOpenSessionWindowIdsPage(
    request?: OpenSessionWindowIdsPageRequest | null,
  ): OpenSessionWindowIdsPageResult;
  /** 指定セッションの表示用データを取得し、見つからなければ null を返す。 */
  getSession(sessionId: string): Awaitable<Session | null>;
  /** 一覧や見出しで使うセッション要約を取得し、見つからなければ null を返す。 */
  getSessionSummary(sessionId: string): Awaitable<SessionSummary | null>;
  /** セッションが参照するチェックアウトと用語集の表示状態を取得する。 */
  getSessionGlossaryProjection(
    sessionId: string,
  ): Awaitable<SessionGlossaryProjection>;
  /** セッションが参照する用語集を検索し、検索結果または操作エラーを返す。 */
  searchSessionGlossary(
    sessionId: string,
    request: GlossarySearchRequest,
  ): Awaitable<GlossaryOperationResult<GlossaryListResult>>;
  /** セッションへの用語集の変更通知に必要な購読を確保する。 */
  ensureSessionGlossarySubscription(sessionId: string): Awaitable<void>;
  /** ファイル参照範囲を所有するセッションの ID を取得する。 */
  getSessionFileExplorerOwnerSessionId(
    sessionId: string,
  ): Awaitable<string | null>;
  /** 指定セッションのファイルエクスプローラーで参照できるルートを列挙する。 */
  listSessionFileRoots(sessionId: string): Awaitable<SessionFileRoot[]>;
  /** 指定セッションに保存されたファイルのピン留めを列挙する。 */
  listSessionFilePins(sessionId: string): Awaitable<SessionFilePin[]>;
  /** ルート内の指定リソースをピン留めし、登録した情報を返す。 */
  pinSessionFile(
    request: SessionFileRootResourceRequest,
  ): Awaitable<SessionFilePin>;
  /** 指定セッションから参照に一致するピン留めを取り除く。 */
  unpinSessionFile(
    request: SessionFilePinReference & { sessionId: string },
  ): Awaitable<void>;
  /** セッションの参照範囲にある指定ディレクトリの直下を列挙する。 */
  listSessionDirectory(
    request: SessionDirectoryRequest,
  ): Awaitable<SessionDirectoryEntry[]>;
  /** プレビュー対象の属性を、作業ファイルかコミット内のファイルかに応じて取得する。 */
  inspectSessionFile(
    request: SessionFilePreviewResourceRequest,
  ): Awaitable<SessionFileDescriptor>;
  /** 指定された画像リソースの読み取りに必要な属性を取得する。 */
  inspectSessionImage(
    request: SessionImageResourceRequest,
  ): Awaitable<SessionFileDescriptor>;
  /** セッション内の指定リソースから HTML プレビュー用データを取得する。 */
  readSessionHtmlPreview(
    request: import("../../src-shared/file-explorer/session-html-preview-contract.js").SessionHtmlPreviewRequest,
  ): Awaitable<
    import("../../src-shared/file-explorer/session-html-preview-contract.js").SessionHtmlPreviewResult
  >;
  /** 画像リソースから要求された範囲を分割読み取りする。 */
  readSessionImageChunk(
    request: SessionImageChunkRequest,
  ): Awaitable<SessionFileChunkResult>;
  /** 指定された PDF リソースの読み取りに必要な属性を取得する。 */
  inspectSessionPdf(
    request: SessionPdfResourceRequest,
  ): Awaitable<SessionFileDescriptor>;
  /** PDF リソースから要求された範囲を分割読み取りする。 */
  readSessionPdfChunk(
    request: SessionPdfChunkRequest,
  ): Awaitable<SessionFileChunkResult>;
  /** 作業ファイルまたはコミット内のファイルから要求された範囲を読み取る。 */
  readSessionFileChunk(
    request: SessionFileChunkRequest,
  ): Awaitable<SessionFileChunkResult>;
  /** 指定されたセッションのファイルを開き、操作結果を返す。 */
  openSessionFile(request: SessionFileOpenRequest): Awaitable<OpenPathResult>;
  /** 指定リソースの専用プレビューを開き、リンク元を再検証する手段を渡す。 */
  openSessionFilePreviewWindow(
    request: SessionFilePreviewWindowOpenRequest,
    assertLinkSender: () => Promise<void>,
  ): Awaitable<SessionFilePreviewWindowOpenResult>;
  /** プレビュー用トークンに対応する起動データを取得し、なければ null を返す。 */
  getSessionFilePreviewWindowPayload(
    token: string,
  ): SessionFilePreviewWindowPayload | null;
  /** 指定ルートの対象リポジトリで、作業ツリーなどの Git 変更一覧を取得する。 */
  listFileRootChanges(
    request: FileRootChangesRequest,
  ): Awaitable<FileRootChangesResult>;
  /** 指定ルートで Git 変更を表示できるリポジトリを列挙する。 */
  listFileRootChangesRepositories(
    request: FileRootChangesRepositoriesRequest,
  ): Awaitable<FileRootChangesRepositoriesResult>;
  /** 変更一覧で選ばれたファイルの Git 差分を取得する。 */
  getFileRootDiff(
    request: FileRootFileDiffRequest,
  ): Awaitable<FileRootFileDiffResult>;
  /** 指定ルートでコミット履歴を参照できるリポジトリを列挙する。 */
  listFileRootGitHistoryRepositories(
    request: FileRootGitHistoryRepositoriesRequest,
  ): Awaitable<FileRootGitHistoryRepositoriesResult>;
  /** 履歴で選ばれたリポジトリのコミット一覧を取得する。 */
  listFileRootGitHistoryCommits(
    request: FileRootGitHistoryCommitsRequest,
  ): Awaitable<FileRootGitHistoryCommitsResult>;
  /** 選択されたコミットの詳細と変更ファイル一覧を取得する。 */
  getFileRootGitHistoryCommitDetail(
    request: FileRootGitHistoryCommitDetailRequest,
  ): Awaitable<FileRootGitHistoryCommitDetailResult>;
  /** 履歴で指定された比較対象間の変更一覧を取得する。 */
  getFileRootGitHistoryComparison(
    request: FileRootGitHistoryComparisonRequest,
  ): Awaitable<FileRootGitHistoryComparisonResult>;
  /** コミット履歴の変更で指定されたファイルの差分を取得する。 */
  getFileRootGitHistoryDiff(
    request: FileRootGitHistoryDiffRequest,
  ): Awaitable<FileRootGitHistoryDiffResult>;
  /** 保存されたメッセージの位置から付随する成果物を取得し、なければ null を返す。 */
  getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): Awaitable<MessageArtifact | null>;
  /** 差分表示トークンにひも付くデータを取得し、なければ null を返す。 */
  getDiffPreview(token: string): DiffPreviewPayload | null;
  /** Composer の入力が指定セッションでどう解釈されるかを、送信せず確認する。 */
  previewComposerInput(
    sessionId: string,
    userMessage: string,
  ): Promise<unknown>;
};

/** 通常セッションに属する補助セッションの参照、編集、実行に必要な依存。 */
export type MainIpcAuxiliaryDepsArgs = {
  /** 指定された親セッションの補助セッション要約を列挙する。 */
  listAuxiliarySessions(
    parentSessionId: string,
  ): Awaitable<AuxiliarySessionSummary[]>;
  /** 複数の親セッションに属する補助セッション要約をまとめて取得する。 */
  listAuxiliarySessionSummaries(
    parentSessionIds: readonly string[],
  ): Awaitable<AuxiliarySessionSummary[]>;
  /** ウィンドウを開いている親セッションに属する補助セッション要約を取得する。 */
  listOpenAuxiliarySessionSummaries(): Awaitable<AuxiliarySessionSummary[]>;
  /** 指定の親セッションで最新の補助セッションの表示データを取得する。 */
  getLatestAuxiliarySession(
    parentSessionId: string,
  ): Awaitable<AuxiliarySession | null>;
  /** 補助セッションの表示データを ID から取得し、見つからなければ null を返す。 */
  getAuxiliarySession(
    auxiliarySessionId: string,
  ): Awaitable<AuxiliarySession | null>;
  /** 指定した補助セッションの保存済み下書きを取得する。 */
  getAuxiliaryDraft(
    auxiliarySessionId: string,
  ): Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord
    | null
  >;
  /** 下書き保存の結果と、取得できた場合は永続化済みの版を返す。 */
  saveAuxiliaryDraft(
    input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
  ): Awaitable<
    import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult
  >;
  /** 指定補助セッションの状態を取得し、見つからなければ null を返す。 */
  getAuxiliarySessionStatus(
    auxiliarySessionId: string,
  ): Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
    | null
  >;
  /** 指定の親セッションに補助セッションを作成し、新しいセッションを返す。 */
  createAuxiliarySession(
    input: CreateAuxiliarySessionInput,
  ): Awaitable<AuxiliarySession>;
  /** 親セッションを基に、補助セッション作成時に提示する選択肢の情報を取得する。 */
  getAuxiliaryCreationContext(
    parentSessionId: string,
  ): Awaitable<
    import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationContext
  >;
  /** 指定された補助セッション作成要求の取り消しを試み、その結果を返す。 */
  cancelAuxiliaryCreation(
    request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
  ): Awaitable<
    import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
  >;
  /** 要求 ID に対応する補助セッション作成の結果を照会する。 */
  getAuxiliaryCreation(
    request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
  ): Awaitable<
    import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
  >;
  /** 補助セッションの変更を保存し、必要に応じてプロバイダー実行状態も更新する。 */
  updateAuxiliarySession(
    session: AuxiliarySession,
  ): Awaitable<AuxiliarySession>;
  /** 補助セッションの実行オプション変更を適用し、適用結果を返す。 */
  setAuxiliaryExecutionOptions(
    request: SetAuxiliaryExecutionOptionsRequest,
  ): Awaitable<SetExecutionOptionsResult>;
  /** 指定補助セッションのタイトルを保存する。 */
  setAuxiliaryTitle(request: SetAuxiliaryTitleRequest): Awaitable<void>;
  /** 補助セッション内の指定メッセージのブックマーク状態を保存する。 */
  setAuxiliaryMessageBookmark(
    request: SetAuxiliaryMessageBookmarkRequest,
  ): Awaitable<void>;
  /** 指定の補助セッションでターンを実行し、処理後の表示データを返す。 */
  runAuxiliarySessionTurn(
    auxiliarySessionId: string,
    request: RunSessionTurnRequest,
  ): Awaitable<AuxiliarySession>;
  /** 対応する場合、実行中の補助ターンに入力を追加し、受付結果を返す。 */
  steerAuxiliarySessionTurn?(
    auxiliarySessionId: string,
    request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest,
  ): Promise<
    import("../../src-shared/session/runtime-state.js").SteerSessionTurnResult
  >;
  /** 渡された認可確認を使い、指定補助セッションの実行停止を要求する。 */
  cancelAuxiliarySessionRun(
    request: CancelSessionRunRequest,
    assertAuthorized: () => void,
  ): Awaitable<void>;
};

/** 通常セッションの変更とターン実行、および実行中の状態参照に必要な依存。 */
export type MainIpcSessionRuntimeDepsArgs = {
  queue?: MainIpcSessionRuntimeServiceDeps["queue"];
  getAuxiliarySessionStatus?: MainIpcSessionRuntimeServiceDeps["getAuxiliarySessionStatus"];
  /** 指定セッションの進行中の実行状態を取得し、なければ null を返す。 */
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  /** プロバイダーの利用枠情報を取得し、キャッシュ限定の要求では更新を行わない。 */
  getProviderQuotaTelemetry(
    providerId: string,
    options?: { cacheOnly?: boolean },
  ): Promise<ProviderQuotaTelemetry | null>;
  /** 指定セッションのコンテキスト使用量の情報を取得し、未取得なら null を返す。 */
  getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null;
  /** 保留中の承認要求に、対象セッションと要求 ID を指定して判断を届ける。 */
  resolveLiveApproval(
    sessionId: string,
    requestId: string,
    decision: LiveApprovalDecision,
  ): void;
  /** 実行中のプロバイダーからの追加入力要求に、要求 ID を指定して回答を届ける。 */
  resolveLiveElicitation(
    sessionId: string,
    requestId: string,
    response: LiveElicitationResponse,
  ): void | Promise<void>;
  /** 作成要求に従って通常セッションを保存し、新しいセッションを返す。 */
  createSession(input: CreateSessionRequest): Awaitable<Session>;
  /** 既存セッションの変更を保存し、会話表示用の更新結果を返す。 */
  updateSession(session: Session): Awaitable<Session>;
  /** セッションから参照する追加ディレクトリの設定を変更する。 */
  changeSessionAdditionalDirectory(
    request: ChangeSessionAdditionalDirectoryRequest,
  ): Awaitable<void>;
  /** 対象のセッション世代を指定し、必要な承認設定の確認情報とともに実行オプションを変更する。 */
  setSessionExecutionOptions(
    request: SetSessionExecutionOptionsRequest,
  ): Awaitable<SetExecutionOptionsResult>;
  /** セッションの世代を指定してタイトルを変更し、保存結果を返す。 */
  setSessionTitle(
    request: SetSessionTitleRequest,
  ): Awaitable<SetSessionTitleResult>;
  /** セッションの世代とメッセージの位置を指定してブックマーク状態を保存する。 */
  setSessionMessageBookmark(
    request: SetSessionMessageBookmarkRequest,
  ): Awaitable<void>;
  /** セッション一覧でのピン留め状態を変更し、更新後の要約を返す。 */
  setSessionPinned(request: SetSessionPinnedRequest): Awaitable<SessionSummary>;
  /** 指定セッションを削除し、そのセッションの端末管理を解放する。 */
  deleteSession(sessionId: string): Awaitable<void>;
  /** 最終活動時刻が指定時点より前のセッションを削除し、削除分と実行中で除外した分を返す。 */
  deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Awaitable<DeleteSessionsResult>;
  /** 現在のセッション世代にターンをキュー登録し、実行完了を待たず表示データを返す。 */
  runSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
  ): Promise<Session>;
  /** 対応する場合、指定の実行中ターンへ追加入力を届け、受付結果を返す。 */
  steerSessionTurn?(
    sessionId: string,
    request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest,
  ): Promise<
    import("../../src-shared/session/runtime-state.js").SteerSessionTurnResult
  >;
  /** 渡された認可確認を使い、指定セッションの実行停止を要求する。 */
  cancelSessionRun(
    request: CancelSessionRunRequest,
    assertAuthorized: () => void,
  ): Awaitable<void>;
};

/** アプリ内の Mate プロフィールを読み書きするための依存。 */
export type MainIpcMateDepsArgs = {
  /** Mate の作成有無など、現在の保存状態を取得する。 */
  getMateState(): Awaitable<MateStorageState>;
  /** 保存済みプロフィールを取得し、作成前は null を返す。 */
  getMateProfile(): Awaitable<MateProfile | null>;
  /** 初期入力から Mate のプロフィールを保存する。 */
  createMate(input: CreateMateInput): Promise<MateProfile>;
  /** 既存の Mate プロフィールを編集し、更新後の内容を返す。 */
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  /** Mate のアバターを設定または解除し、更新後のプロフィールを返す。 */
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  /** 保存した Mate をリセットし、未作成の状態に戻す。 */
  resetMate(): Promise<void>;
};

/** Character カタログの管理、起動時の選択、制作セッション開始の依存。 */
export type MainIpcCharacterDepsArgs = {
  /** Character の一覧を取得し、要求された場合はアーカイブ済みも含める。 */
  listCharacters(
    options?: { includeArchived?: boolean } | null,
  ): Awaitable<CharacterCatalogEntry[]>;
  /** 指定 ID の Character の編集・表示用詳細を取得する。 */
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  /** 入力された内容で Character を登録し、保存結果を返す。 */
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  /** Character のメタデータに対する変更を保存し、更新後の詳細を返す。 */
  updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Awaitable<CharacterDetail>;
  /** Character の定義に対する変更を保存し、更新後の詳細を返す。 */
  updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Awaitable<CharacterDetail>;
  /** 指定 Character をアーカイブし、処理後のカタログ項目を返す。 */
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  /** 起動時の指定や選択条件に従い、使用する Character を解決する。 */
  resolveLaunchCharacter(
    input?: ResolveLaunchCharacterInput | null,
  ): Awaitable<CharacterDetail | null>;
  /** Character 制作用のセッションを開始し、その結果を返す。 */
  startCharacterAuthoringSession(
    input: StartCharacterAuthoringSessionInput,
  ): Awaitable<CharacterAuthoringSessionStartResult>;
};

/** Main の起動時に IPC 登録へ渡す、責務別の依存グループ。 */
export type CreateMainIpcRegistrationDepsArgs = {
  window: MainIpcWindowDepsArgs;
  catalog: MainIpcCatalogDepsArgs;
  settings: MainIpcSettingsDepsArgs;
  promptTemplates: MainIpcPromptTemplateDepsArgs;
  sessionQuery: MainIpcSessionQueryDepsArgs;
  auxiliary?: MainIpcAuxiliaryDepsArgs;
  sessionRuntime: MainIpcSessionRuntimeDepsArgs;
  sessionInstructions: Omit<
    MainIpcSessionInstructionsDeps,
    "resolveEventWindow"
  >;
  mate: MainIpcMateDepsArgs;
  character: MainIpcCharacterDepsArgs;
};

/** 補助依存がない構成では一覧や参照を空として扱い、対応しない操作は明示的に失敗させる。 */
function createUnavailableAuxiliaryDeps(): MainIpcAuxiliaryDepsArgs {
  /** 構成されていない補助機能への要求を成功として返さない。 */
  const throwUnavailable = (): never => {
    throw new Error("Auxiliary Session dependency is not configured.");
  };

  return {
    /** 親セッションに対応する補助セッション一覧を空で返す。 */
    listAuxiliarySessions: () => [],
    /** 複数の親セッションを対象にしても要約は空で返す。 */
    listAuxiliarySessionSummaries: () => [],
    /** 開いている親ウィンドウ向けの要約を空で返す。 */
    listOpenAuxiliarySessionSummaries: () => [],
    /** 親セッションに対応する最新の補助セッションはないものとして扱う。 */
    getLatestAuxiliarySession: () => null,
    /** 個別の補助セッションを解決できないことを返す。 */
    getAuxiliarySession: () => null,
    /** 参照できる補助セッションの下書きがないことを返す。 */
    getAuxiliaryDraft: () => null,
    saveAuxiliaryDraft: throwUnavailable,
    /** 参照できる補助セッションの状態がないことを返す。 */
    getAuxiliarySessionStatus: () => null,
    createAuxiliarySession: throwUnavailable,
    getAuxiliaryCreationContext: throwUnavailable,
    cancelAuxiliaryCreation: throwUnavailable,
    getAuxiliaryCreation: throwUnavailable,
    updateAuxiliarySession: throwUnavailable,
    setAuxiliaryExecutionOptions: throwUnavailable,
    setAuxiliaryTitle: throwUnavailable,
    setAuxiliaryMessageBookmark: throwUnavailable,
    runAuxiliarySessionTurn: throwUnavailable,
    cancelAuxiliarySessionRun: throwUnavailable,
  };
}

/**
 * 起動側が供給する依存を IPC ハンドラーの登録単位に組み替える。
 * 送信元の検証に必要なウィンドウ解決を各グループへ配り、補助機能がない構成でも登録できるようにする。
 */
export function createMainIpcRegistrationDeps(
  args: CreateMainIpcRegistrationDepsArgs,
): MainIpcRegistrationDeps {
  const auxiliary = args.auxiliary ?? createUnavailableAuxiliaryDeps();
  const eventWindow = {
    resolveEventWindow: args.window.resolveEventWindow,
  };
  const homeWindow = {
    resolveHomeWindow: args.window.resolveHomeWindow,
  };
  const sessionWindow = {
    resolveSessionWindow: args.window.resolveSessionWindow,
  };
  const windowContext = {
    ...eventWindow,
    ...homeWindow,
    ...sessionWindow,
    isSessionMonitorWindow: args.window.isSessionMonitorWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    getAuxiliarySession: auxiliary.getAuxiliarySession,
  };
  const settingsContext = {
    ...eventWindow,
    ...homeWindow,
    isSettingsWindow: args.window.isSettingsWindow,
  };
  const sessionQueryContext = {
    ...eventWindow,
    ...sessionWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    getFilePreviewWindowResource: args.window.getFilePreviewWindowResource,
    isFilePreviewTokenWindow: args.window.isFilePreviewTokenWindow,
  };
  const sessionRuntimeContext = {
    ...eventWindow,
    ...homeWindow,
    ...sessionWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    isSettingsWindow: args.window.isSettingsWindow,
  };

  return {
    common: {
      acknowledgeSessionDraftFlush: args.window.acknowledgeSessionDraftFlush,
      resolveEventWindow: args.window.resolveEventWindow,
      logIpcError: args.window.logIpcError,
      reportRendererLog: args.window.reportRendererLog,
    },
    window: createWindowIpcDeps(args.window, windowContext),
    catalog: createCatalogIpcDeps(args.catalog, {
      ...eventWindow,
      ...homeWindow,
    }),
    settings: createSettingsIpcDeps(args.settings, settingsContext),
    promptTemplates: args.promptTemplates,
    sessionQuery: createSessionQueryIpcDeps(
      {
        ...args.sessionQuery,
        copySessionFilePreviewImage: args.window.copySessionFilePreviewImage,
        showSessionFilePreviewImageContextMenu:
          args.window.showSessionFilePreviewImageContextMenu,
        copySessionFileObject: args.window.copySessionFileObject,
        showSessionFileObjectCopyContextMenu:
          args.window.showSessionFileObjectCopyContextMenu,
        showSessionFileTreeContextMenu:
          args.window.showSessionFileTreeContextMenu,
        showMarkdownLinkContextMenu: args.window.showMarkdownLinkContextMenu,
      },
      sessionQueryContext,
    ),
    auxiliary: createAuxiliaryIpcDeps(auxiliary, {
      ...eventWindow,
      ...sessionWindow,
    }),
    sessionRuntime: createSessionRuntimeIpcDeps(
      args.sessionRuntime,
      sessionRuntimeContext,
    ),
    sessionInstructions: { ...args.sessionInstructions, ...eventWindow },
    mate: args.mate,
    character: args.character,
  };
}
