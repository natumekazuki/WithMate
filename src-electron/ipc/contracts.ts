import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  SessionFolderCleanupRequest,
  SessionFolderCleanupScan,
  SessionFolderCleanupResult,
} from "../../src-shared/session/session-folder-cleanup.js";
import type {
  SessionHtmlPreviewRequest,
  SessionHtmlPreviewResult,
} from "../../src-shared/file-explorer/session-html-preview-contract.js";

import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../src-shared/window/markdown-link-context-menu.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
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
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  StartCharacterAuthoringSessionInput,
  CharacterAuthoringSessionStartResult,
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
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../../src-shared/mate/mate-state.js";
import type {
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { type ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../../src-shared/prompt-template.js";
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
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";
import { type WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

import {
  type ImageFilePickerPurpose,
  type OpenPathOptions,
  type OpenPathResult,
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
  type OpenSessionWindowIdsPageRequest,
  type OpenSessionWindowIdsPageResult,
  type SessionMonitorPageResult,
  type ResetAppDatabaseRequest,
  type SavePastedSessionFileRequest,
  type SavePastedSessionFileResult,
  type SessionMonitorContextMenuRequest,
  type SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";
/** ウィンドウが未作成、または送信元から特定できない場合も扱う参照。 */
export type MaybeWindow = BrowserWindow | null | undefined;
/** Homeから開いているCrewを参照・操作するための依存。 */
export type MainIpcHomeCrewDeps = {
  /** 開いているSessionを基準に、カーソルでCrewの表示項目を取得する。 */
  listHomeCrewPage(request: {
    cursor: string | null;
    limit: number;
  }): Awaitable<
    import("../../src-shared/window/home-crew-types.js").HomeCrewPageResult
  >;
  /** 認可済みのHomeを親として、Crew内の対象に応じたメニューを表示する。 */
  showHomeCrewContextMenu(
    window: BrowserWindow,
    request: import("../../src-shared/window/home-crew-types.js").HomeCrewContextMenuRequest,
  ): Awaitable<SessionMonitorContextMenuResult>;
};
/** invokeと通知の両方で送信元のWebContentsを受け取るための最小形。 */
export type IpcSenderEvent = Pick<IpcMainInvokeEvent, "sender">;
/** invokeの例外をチャネルと所要時間に結び付けるログ入力。ターン送信では要求IDも添えられる。 */
export type LogIpcErrorInput = {
  channel: string;
  durationMs: number;
  error: unknown;
  clientRequestId?: string;
};
/** invokeの登録だけを許し、通知購読などのIpcMain操作は公開しない。 */
export type IpcHandleRegistrar = {
  handle: IpcMain["handle"];
};
/** 機能別ハンドラーに共通するログと下書き保存応答の接続先。 */
export type MainIpcCommonDeps = {
  /** 要求IDと応答元を照合できるように、下書き保存の成否をウィンドウ管理へ渡す。 */
  acknowledgeSessionDraftFlush(
    event: IpcSenderEvent,
    payload: { requestId: string; success: boolean },
  ): void;
  /** rendererログに送信元のウィンドウIDを添えるために使う。 */
  resolveEventWindow(event: IpcSenderEvent): MaybeWindow;
  /** invokeの失敗をチャネル・所要時間とともに記録する任意の接続先。 */
  logIpcError?(input: LogIpcErrorInput): void;
  /** 送信元のウィンドウIDが得られない場合もrendererログを受け取る。 */
  reportRendererLog?(input: RendererLogInput, windowId?: number): void;
};

/** IPC送信元とウィンドウの対応を取得するための依存。 */
export type MainIpcEventWindowDeps = {
  /** 送信イベントのWebContentsに対応するウィンドウを引く。 */
  resolveEventWindow(event: IpcSenderEvent): MaybeWindow;
};
/** Homeの送信元認可やダイアログ親のフォールバックに使う依存。 */
export type MainIpcHomeWindowDeps = {
  /** 開いているHomeを返す。参照取得のために新規作成はしない。 */
  resolveHomeWindow(): MaybeWindow;
};
/** Sessionの所有ウィンドウとIPC送信元を照合するための依存。 */
export type MainIpcSessionWindowDeps = {
  /** 指定されたMain Sessionに割り当てられたウィンドウを返す。 */
  resolveSessionWindow(sessionId: string): MaybeWindow;
};
/** Settingsからのみ許可する管理操作に使う依存。 */
export type MainIpcSettingsWindowDeps = {
  /** 渡されたウィンドウが管理中のSettingsに一致するかを判定する。 */
  isSettingsWindow(window: BrowserWindow): boolean;
};
/** Session Monitor向け操作で、送信元を識別するための依存。 */
export type MainIpcSessionMonitorWindowDeps = {
  /** 渡されたウィンドウがSession Monitorかを判定する。 */
  isSessionMonitorWindow(window: BrowserWindow): boolean;
};
/** ディレクトリ入力の可否をファイルシステム上で検証するための依存。 */
export type MainIpcWorkspaceValidationDeps = {
  /** 未検証の入力を受け取り、Workspaceに指定できるかを結果型で返す。 */
  validateWorkspaceDirectory(
    targetPath: unknown,
  ): Promise<WorkspaceDirectoryValidationResult>;
};
/** Sessionウィンドウを開く際にAuxiliaryと親の関係を照合する依存。 */
export type MainIpcAuxiliaryLookupDeps = {
  /** 指定IDのAuxiliaryを照合に供し、見つからなければnullを返す。 */
  getAuxiliarySession(
    auxiliarySessionId: string,
  ): Awaitable<AuxiliarySession | null>;
};
/** 独立したファイルプレビューの読取対象とウィンドウを限定するための依存。 */
export type MainIpcFilePreviewWindowDeps = {
  /** 対象Sessionとウィンドウが一致するプレビューのリソースを返す。履歴上のリソースは絶対パス形式に変換しない。 */
  getFilePreviewWindowResource(
    window: BrowserWindow,
    sessionId: string,
    representation?: "source" | "absolute",
  ): SessionFilePreviewResourceRequest | null;
  /** 初期表示用トークンを、そのプレビュー自身のウィンドウに限定する。 */
  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean;
};

/** ナビゲーションとOSダイアログなど、ウィンドウ起点の操作を委譲する依存。 */
export type MainIpcWindowDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcHomeCrewDeps &
  MainIpcSessionWindowDeps &
  MainIpcSessionMonitorWindowDeps &
  MainIpcWorkspaceValidationDeps &
  MainIpcAuxiliaryLookupDeps & {
    /** Main Sessionのウィンドウを開き、指定時は親が一致するAuxiliaryへ移動する。 */
    openSessionWindow(
      sessionId: string,
      auxiliarySessionId?: string,
    ): Promise<void>;
    /** HomeまたはSession Monitorからの要求で、Sessionのメニューを表示する。 */
    showSessionMonitorContextMenu(
      event: IpcSenderEvent,
      request: SessionMonitorContextMenuRequest,
    ): Awaitable<SessionMonitorContextMenuResult>;
    /** Homeが一括復元の候補として表示するSession IDの保存済み集合を読む。 */
    getSessionWindowRestoreSet(): Promise<string[]>;
    /** 保存したSnapshotからSessionウィンドウを開き、復元結果を返す。 */
    restoreSessionWindows(): Promise<SessionWindowRestoreResult>;
    /** Session一覧などの起点となるHomeを表示する。 */
    openHomeWindow(): Promise<void>;
    /** MainとAuxiliaryの状態を確認するSession Monitorを表示する。 */
    openSessionMonitorWindow(): Promise<void>;
    /** アプリ設定とストレージ管理のウィンドウを表示する。 */
    openSettingsWindow(): Promise<void>;
    /** 編集するCharacterのIDを渡す。指定なしは既存Characterの指定を伴わない。 */
    openCharacterEditorWindow(characterId?: string | null): Promise<void>;
    /** 呼び出し側から渡された差分データを独立ウィンドウで表示する。 */
    openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
    /** 開いているプレビューを所有Session単位にまとめ、表示用のSession要約を添える。 */
    listSessionFilePreviewWindows(): Promise<SessionFilePreviewWindowGroup[]>;
    /** Homeのプレビュー一覧の対象に応じたメニューを送信元に表示する。 */
    showSessionFilePreviewContextMenu(
      event: IpcSenderEvent,
      request: SessionFilePreviewContextMenuRequest,
    ): Promise<SessionFilePreviewContextMenuResult>;
    /** 個別のプレビュートークンを指定してウィンドウへフォーカスする。 */
    focusSessionFilePreviewWindow(token: string): void;
    /** 個別のプレビューをトークンで指定して閉じる。 */
    closeSessionFilePreviewWindow(token: string): void;
    /** 所有するSession IDを指定して、配下のプレビューをまとめて閉じる。 */
    closeSessionFilePreviewWindows(ownerSessionId: string): void;
    /** 指定パスを初期位置としてフォルダーを選択する。取り消し時はnull。 */
    pickDirectory(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string | null>;
    /** 単一ファイルのパスを選択する。取り消し時はnull。 */
    pickFile(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string | null>;
    /** 複数選択を許可したファイルダイアログを開く。取り消し時は空配列。 */
    pickFiles(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string[]>;
    /** SessionFolderを初期位置として開き、フォルダー内の選択結果だけを返す。 */
    pickSessionFiles(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string[]>;
    /** SessionFolderまたはその配下のフォルダーだけを選択結果として返す。 */
    pickSessionFolder(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string | null>;
    /** SessionFolder内で選ばれた画像のパスを返し、範囲外の選択はnullにする。 */
    pickSessionImageFile(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string | null>;
    /** Characterアイコンなどの用途に応じた画像フィルターで選択を求める。 */
    pickImageFile(
      targetWindow: MaybeWindow,
      initialPath: string | null,
      purpose: ImageFilePickerPurpose,
    ): Promise<string | null>;
    /** 選択済みのパスからSessionFolderへコピーし、保存後のパスを返す。 */
    copyFilesToSessionFiles(
      sessionId: string,
      sourcePaths: string[],
    ): Promise<string[]>;
    /** 貼り付けたバイト列を保存し、同名時の別名保存・置換指定も保存処理へ伝える。 */
    savePastedSessionFile(
      request: SavePastedSessionFileRequest,
    ): Promise<SavePastedSessionFileResult>;
    /** SessionFolderを用意し、OSのファイルブラウザーで表示する。 */
    openSessionFilesDirectory(sessionId: string): Promise<void>;
    /** SessionFolderを用意し、そのディレクトリを作業位置として端末を起動する。 */
    openSessionFilesTerminal(sessionId: string): Promise<void>;
    /** リンクやファイルパスの種別と表示指定に応じて対象を開き、結果を返す。 */
    openPathTarget(
      target: string,
      options?: OpenPathOptions,
    ): Promise<OpenPathResult>;
    /** アプリのログファイルを格納するディレクトリをOSで表示する。 */
    openAppLogFolder(): Promise<void>;
    /** クラッシュダンプの格納先をOSで表示する。ログフォルダーとは別の場所。 */
    openCrashDumpFolder(): Promise<void>;
    /** 指定Sessionから端末の起動位置を決定して開く。 */
    openSessionTerminal(sessionId: string): Promise<void>;
    /** Sessionから起動位置を解決せず、渡されたパスを端末起動側へ渡す。 */
    openTerminalAtPath(target: string): Promise<void>;
  };

/** モデル選択に使うカタログの取得処理とウィンドウ共通依存。 */
export type MainIpcCatalogDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps & {
    /** 任意の要求条件をモデル探索へ渡し、利用できるカタログのスナップショットを返す。 */
    getModelCatalog(
      request?: ModelCatalogRequest,
    ): Awaitable<ModelCatalogSnapshot | null>;
  };

/** 設定の参照・保存とアプリストレージ保守をSettings系IPCへ提供する依存。 */
export type MainIpcSettingsDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSettingsWindowDeps & {
    /** Settingsのバージョン表示に、実行中のアプリの値を返す。 */
    getAppVersion(): string;
    /** 画面に反映する現在のアプリ設定を取得する。 */
    getAppSettings(): Awaitable<AppSettings>;
    /** 設定を保存し、保存後の設定を返す。 */
    updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
    /** 全設定を置き換えず、指定対象のチャットレイアウト設定だけを更新する。 */
    updateChatLayoutPreference(
      update: ChatLayoutPreferenceUpdate,
    ): Awaitable<void>;
    /** ストレージ診断画面に表示するデータベースの状態を取得する。 */
    getAppDatabaseDiagnostics(): Awaitable<AppDatabaseDiagnostics>;
    /** 削除を実行せず、条件に合うSessionFolderと実行用の走査IDを返す。 */
    scanSessionFolderCleanup(
      request: SessionFolderCleanupRequest,
    ): Promise<SessionFolderCleanupScan>;
    /** 指定された走査IDに基づいてSessionFolderの整理を実行する。 */
    runSessionFolderCleanup(request: {
      scanId: string;
    }): Promise<SessionFolderCleanupResult>;
    /** Settingsから認可されたリセット要求をDB保守処理へ渡す。 */
    resetAppDatabase(
      request: ResetAppDatabaseRequest | null | undefined,
    ): Promise<unknown>;
  };

/** 親ウィンドウの照合とAuxiliaryの履歴・操作を担う依存。基本操作の不足は登録側で検出する。 */
export type MainIpcAuxiliaryDeps = MainIpcEventWindowDeps &
  MainIpcSessionWindowDeps & {
    /** 親IDに属するAuxiliaryを本文なしの要約で列挙する。 */
    listAuxiliarySessions?(
      parentSessionId: string,
    ): Awaitable<AuxiliarySessionSummary[]>;
    /** Mainが開いている親を確定し、その配下の要約だけをHome向けに返す。 */
    listOpenAuxiliarySessionSummaries?(): Awaitable<AuxiliarySessionSummary[]>;
    /** 親の最新Auxiliaryを取得する。まだなければnullを返す。 */
    getLatestAuxiliarySession?(
      parentSessionId: string,
    ): Awaitable<AuxiliarySession | null>;
    /** IDでAuxiliaryの詳細を読み、対象がなければnullを返す。 */
    getAuxiliarySession?(
      auxiliarySessionId: string,
    ): Awaitable<AuxiliarySession | null>;
    /** 保存済みテキストと永続リビジョンを読み、下書きがなければnullを返す。 */
    getAuxiliaryDraft?(
      auxiliarySessionId: string,
    ): Awaitable<
      | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord
      | null
    >;
    /** 同じ個体の期待リビジョンを指定して保存し、古い更新や対象なしを結果で区別する。 */
    saveAuxiliaryDraft?(
      input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult
    >;
    /** 本文を取得せず、送信元認可や状態表示に必要な親・個体・実行状態を読む。 */
    getAuxiliarySessionStatus?(
      auxiliarySessionId: string,
    ): Awaitable<
      | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
      | null
    >;
    /** 認可済みの親と作成コンテキスト、再試行時も保持する要求IDでAuxiliaryを作成する。 */
    createAuxiliarySession?(
      input: CreateAuxiliarySessionInput,
    ): Awaitable<AuxiliarySession>;
    /** 作成要求を現在のストレージ世代と親の個体に結び付ける値を取得する。 */
    getAuxiliaryCreationContext?(
      parentSessionId: string,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationContext
    >;
    /** 特定の作成要求に取消を求め、確定済みなど取消できない場合もその状態を返す。 */
    cancelAuxiliaryCreation?(
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
    >;
    /** 作成要求を再送せず、同じコンテキストと要求IDで処理結果を照会する。 */
    getAuxiliaryCreation?(
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
    >;
    /** 既存の親と照合済みのAuxiliary更新を保存し、反映後の状態を返す。 */
    updateAuxiliarySession?(
      session: AuxiliarySession,
    ): Awaitable<AuxiliarySession>;
    /** モデルなどの実行オプションを対象個体に更新し、結果を返す。 */
    setAuxiliaryExecutionOptions?(
      request: SetAuxiliaryExecutionOptionsRequest,
    ): Awaitable<SetExecutionOptionsResult>;
    /** 対象個体のタイトルだけを更新する。 */
    setAuxiliaryTitle?(request: SetAuxiliaryTitleRequest): Awaitable<void>;
    /** 対象個体の指定メッセージに対してブックマーク状態を更新する。 */
    setAuxiliaryMessageBookmark?(
      request: SetAuxiliaryMessageBookmarkRequest,
    ): Awaitable<void>;
    /** Aux側のターンを開始し、完了後のSessionを返す。 */
    runAuxiliarySessionTurn?(
      auxiliarySessionId: string,
      request: RunSessionTurnRequest,
    ): Awaitable<AuxiliarySession>;
    /** 取消の適用時に所有者を再確認するための関数を渡し、指定の実行を中断する。 */
    cancelAuxiliarySessionRun?(
      request: CancelSessionRunRequest,
      assertAuthorized: () => void,
    ): Awaitable<void>;
    /** 新しいターンを開始せず、実行中のAuxiliaryターンへ追加入力を送る。 */
    steerAuxiliarySessionTurn?(
      auxiliarySessionId: string,
      request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest,
    ): Promise<
      import("../../src-shared/session/runtime-state.js").SteerSessionTurnResult
    >;
  };

/** 登録側が構成を確認した後、欠落確認を繰り返さずに使うAuxiliaryの基本操作。 */
export type MainIpcAuxiliaryDepsRequired = {
  listAuxiliarySessions: (
    parentSessionId: string,
  ) => Awaitable<AuxiliarySessionSummary[]>;
  listOpenAuxiliarySessionSummaries: () => Awaitable<AuxiliarySessionSummary[]>;
  getLatestAuxiliarySession: (
    parentSessionId: string,
  ) => Awaitable<AuxiliarySession | null>;
  getAuxiliarySession: (
    auxiliarySessionId: string,
  ) => Awaitable<AuxiliarySession | null>;
  getAuxiliaryDraft: (
    auxiliarySessionId: string,
  ) => Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord
    | null
  >;
  saveAuxiliaryDraft: (
    input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
  ) => Awaitable<
    import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult
  >;
  getAuxiliarySessionStatus: (
    auxiliarySessionId: string,
  ) => Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
    | null
  >;
  createAuxiliarySession: (
    input: CreateAuxiliarySessionInput,
  ) => Awaitable<AuxiliarySession>;
  updateAuxiliarySession: (
    session: AuxiliarySession,
  ) => Awaitable<AuxiliarySession>;
  runAuxiliarySessionTurn: (
    auxiliarySessionId: string,
    request: RunSessionTurnRequest,
  ) => Awaitable<AuxiliarySession>;
  cancelAuxiliarySessionRun: (
    request: CancelSessionRunRequest,
    assertAuthorized: () => void,
  ) => Awaitable<void>;
};

/** 会話の検索・Navigatorの接続先。送信元の照合には会話を所有するMain Session IDを使う。 */
export type ConversationQueryOwner = {
  ownerSessionId: string;
  /** 解決時のストレージが引き続き有効で、DB保守中でないかを返す。 */
  isCurrent(): boolean;
  /** 本文または表示表現から一致箇所を検索し、継続情報付きの結果を返す。 */
  search(
    request: import("../../src-shared/session/conversation-page.js").ConversationSearchRequest,
  ): Awaitable<
    import("../../src-shared/session/conversation-page.js").ConversationQueryOutcome<
      import("../../src-shared/session/conversation-page.js").ConversationSearchMatch
    >
  >;
  /** 会話内の移動に使うNavigator項目をページ取得する。 */
  navigate(
    request: import("../../src-shared/session/conversation-page.js").ConversationNavigatorRequest,
  ): Awaitable<
    import("../../src-shared/session/conversation-page.js").ConversationQueryOutcome<
      import("../../src-shared/session/conversation-page.js").ConversationNavigatorEntry
    >
  >;
  /** 送信元ごとに割り当てたproducerと要求IDを使って、同じストレージで照会を取り消す。 */
  cancel(
    request: import("../../src-shared/session/conversation-page.js").ConversationQueryCancelRequest,
  ): Awaitable<void>;
};

/** Session・会話・Glossary・File Explorerの参照と、その表示に付随する操作の依存。 */
export type MainIpcSessionQueryDeps = MainIpcEventWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcWorkspaceValidationDeps &
  MainIpcFilePreviewWindowDeps & {
    /** Home用のSession一覧を指定条件とカーソルに従ってページ取得する。 */
    listSessionSummaryPage(
      request?: SessionSummaryPageRequest | null,
    ): Awaitable<HomeSessionSummaryPageResult>;
    /** Mainが決めた監視対象の親と、そのAuxiliary・実行状況をページ取得する。 */
    listSessionMonitorPage(request: {
      cursor: string | null;
      limit: number;
    }): Awaitable<SessionMonitorPageResult>;
    /** HomeのCharacter別表示に使うSessionの利用情報を取得する。 */
    listSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
    /** MainまたはAuxiliaryに記録された最新ターンを取得する。記録がなければnull。 */
    getLatestSessionTurn(
      sessionId: string,
    ): Awaitable<
      | import("../../src-shared/session/session-turn-state.js").SessionTurnRecord
      | null
    >;
    /** 現在表示すべき未読の完了結果があれば返す。 */
    getUnreadSessionResult(
      sessionId: string,
    ):
      | import("../../src-shared/session/session-turn-state.js").UnreadSessionResult
      | null;
    /** 表示済みのターンIDが現在の未読結果と一致する場合だけ既読にする。 */
    markSessionResultRead(sessionId: string, turnId: number): boolean;
    /** 保存されたSessionの実行条件を使って、利用可能なSkillを探索する。 */
    listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
    /** 保存されたSessionに適用されるCustom Agentの候補を探索する。 */
    listSessionCustomAgents(
      sessionId: string,
    ): Promise<DiscoveredCustomAgent[]>;
    /** 保存済みSessionではなく、指定providerとWorkspaceでSkillを探索する。 */
    listWorkspaceSkills(
      providerId: string,
      workspacePath: string,
    ): Promise<DiscoveredSkill[]>;
    /** Session作成前でも、指定providerとWorkspaceでCustom Agent候補を取得できる。 */
    listWorkspaceCustomAgents(
      providerId: string,
      workspacePath: string,
    ): Promise<DiscoveredCustomAgent[]>;
    /** 保存済み一覧とは別に、開いているSessionウィンドウのIDをページ取得する。 */
    listOpenSessionWindowIdsPage(
      request?: OpenSessionWindowIdsPageRequest | null,
    ): OpenSessionWindowIdsPageResult;
    /** rendererに表示するSessionを取得し、存在しなければnullを返す。 */
    getSession(sessionId: string): Awaitable<Session | null>;
    /** Auxiliary会話なら保存済みの親IDを、そうでなければ要求IDを認可対象とする。 */
    getConversationOwnerSessionId?(sessionId: string): Awaitable<string>;
    /** MainとAuxiliaryの保存先を切り替え、指定会話の本文をページで読み取る。 */
    getConversationPage?(
      sessionId: string,
      request?: import("../../src-shared/session/conversation-page.js").ConversationPageRequest,
    ): Awaitable<
      | import("../../src-shared/session/conversation-page.js").ConversationPage
      | null
    >;
    /** 照会対象に対応する保存先を確定し、返却前の有効性確認と取消に使う参照を返す。 */
    resolveConversationQueryOwner?(
      sessionId: string,
    ): Awaitable<ConversationQueryOwner>;
    /** 会話本文の読み込みなしで、表示用のSession要約を取得する。 */
    getSessionSummary(sessionId: string): Awaitable<SessionSummary | null>;
    /** Sessionに紐づくGlossaryの表示用データを取得する。 */
    getSessionGlossaryProjection(
      sessionId: string,
    ): Awaitable<SessionGlossaryProjection>;
    /** rendererから検索先パスを受け取らず、Sessionに紐づくGlossaryを検索する。 */
    searchSessionGlossary(
      sessionId: string,
      request: GlossarySearchRequest,
    ): Awaitable<GlossaryOperationResult<GlossaryListResult>>;
    /** 表示用データの取得前に、SessionへGlossaryの更新を届ける購読を確保する。 */
    ensureSessionGlossarySubscription(sessionId: string): Awaitable<void>;
    /** File Explorer操作を所有するMain Sessionを解決する。対象を解決できなければnull。 */
    getSessionFileExplorerOwnerSessionId(
      sessionId: string,
    ): Awaitable<string | null>;
    /** File ExplorerでそのSessionから辿れるルートを列挙する。 */
    listSessionFileRoots(sessionId: string): Awaitable<SessionFileRoot[]>;
    /** ファイル本体を読み込まず、Sessionに登録されたピンを列挙する。 */
    listSessionFilePins(sessionId: string): Awaitable<SessionFilePin[]>;
    /** ルート相対で指定されたファイルをピン留めし、登録内容を返す。 */
    pinSessionFile(
      request: SessionFileRootResourceRequest,
    ): Awaitable<SessionFilePin>;
    /** Sessionに属するピンを取り除く。ファイル本体の削除は行わない。 */
    unpinSessionFile(
      request: SessionFilePinReference & { sessionId: string },
    ): Awaitable<void>;
    /** 対象ルート内の指定ディレクトリに表示する項目を列挙する。 */
    listSessionDirectory(
      request: SessionDirectoryRequest,
    ): Awaitable<SessionDirectoryEntry[]>;
    /** リンクから解決した画像について、分割読取に必要な記述子を取得する。 */
    inspectSessionImage(
      request: SessionImageResourceRequest,
    ): Awaitable<SessionFileDescriptor>;
    /** ローカルHTMLをサイズ上限と読取中のリビジョン整合を確認してテキストで返す。 */
    readSessionHtmlPreview(
      request: SessionHtmlPreviewRequest,
    ): Awaitable<SessionHtmlPreviewResult>;
    /** リンクで指定した画像を開き直し、期待リビジョンを確認して指定範囲を読む。 */
    readSessionImageChunk(
      request: SessionImageChunkRequest,
    ): Awaitable<SessionFileChunkResult>;
    /** ローカルファイルをPDFとして確認し、分割読取に必要な記述子を返す。 */
    inspectSessionPdf(
      request: SessionPdfResourceRequest,
    ): Awaitable<SessionFileDescriptor>;
    /** PDFを開き直し、期待リビジョンを確認して指定範囲を読む。 */
    readSessionPdfChunk(
      request: SessionPdfChunkRequest,
    ): Awaitable<SessionFileChunkResult>;
    /** 現在のファイルまたは指定コミット内のファイルについて、プレビュー用の記述子を取得する。 */
    inspectSessionFile(
      request: SessionFilePreviewResourceRequest,
    ): Awaitable<SessionFileDescriptor>;
    /** 現在のファイルと履歴上のファイルを区別し、指定リビジョンの一部分を読み取る。 */
    readSessionFileChunk(
      request: SessionFileChunkRequest,
    ): Awaitable<SessionFileChunkResult>;
    /** 認可済みのSessionファイルをOS側で開き、結果を返す。 */
    openSessionFile(request: SessionFileOpenRequest): Awaitable<OpenPathResult>;
    /** 独立したファイルプレビューを開く。リンクの非同期解決後には渡された関数で再認可する。 */
    openSessionFilePreviewWindow(
      request: SessionFilePreviewWindowOpenRequest,
      assertLinkSender: () => Promise<void>,
    ): Awaitable<SessionFilePreviewWindowOpenResult>;
    /** 対応するウィンドウを照合済みのトークンから、プレビューの初期表示データを取得する。 */
    getSessionFilePreviewWindowPayload(
      token: string,
    ): SessionFilePreviewWindowPayload | null;
    /** 送信元の表示座標にある画像をクリップボードへコピーする。 */
    copySessionFilePreviewImage(
      event: IpcSenderEvent,
      request: SessionFilePreviewImageActionRequest,
    ): Awaitable<SessionFilePreviewImageCopyResult>;
    /** 画像のメニューを表示し、ソースを扱う操作時に渡された関数で送信元を再認可する。 */
    showSessionFilePreviewImageContextMenu(
      event: IpcSenderEvent,
      request: SessionFilePreviewImageActionRequest,
      assertSender: () => Promise<void>,
    ): Awaitable<SessionFilePreviewImageContextMenuResult>;
    /** 認可されたリソースをパス文字列ではなくファイルオブジェクトとしてコピーする。 */
    copySessionFileObject(
      event: IpcSenderEvent,
      request: SessionFileObjectCopyRequest,
    ): Awaitable<SessionFileObjectCopyResult>;
    /** ファイルオブジェクトのコピー操作を送信元のメニューに表示する。 */
    showSessionFileObjectCopyContextMenu(
      event: IpcSenderEvent,
      request: SessionFileObjectCopyContextMenuRequest,
    ): Awaitable<SessionFileObjectCopyContextMenuResult>;
    /** 所有ウィンドウのファイルツリーで、指定パスに対応するアクションを提示する。 */
    showSessionFileTreeContextMenu(
      event: IpcSenderEvent,
      request: SessionFileTreePathActionRequest,
    ): Awaitable<SessionFileTreePathActionContextMenuResult>;
    /** リンク先とリンク解決の基点を受け取り、Markdownリンクのメニューを表示する。 */
    showMarkdownLinkContextMenu(
      event: IpcSenderEvent,
      request: MarkdownLinkContextMenuRequest,
    ): Awaitable<MarkdownLinkContextMenuResult>;
    /** 指定ルートのGit変更を読み、ファイルと変更範囲ごとに一覧化する。 */
    listFileRootChanges(
      request: FileRootChangesRequest,
    ): Awaitable<FileRootChangesResult>;
    /** 渡されたルートからGit変更を表示できる対象を探し、ルート単位の失敗も返す。 */
    listFileRootChangesRepositories(
      request: FileRootChangesRepositoriesRequest,
    ): Awaitable<FileRootChangesRepositoriesResult>;
    /** 対象ファイルの作業ツリーまたはステージ済みの差分を取得する。 */
    getFileRootDiff(
      request: FileRootFileDiffRequest,
    ): Awaitable<FileRootFileDiffResult>;
    /** Sessionのルートから履歴を参照できるリポジトリと選択可能な参照を列挙する。 */
    listFileRootGitHistoryRepositories(
      request: FileRootGitHistoryRepositoriesRequest,
    ): Awaitable<FileRootGitHistoryRepositoriesResult>;
    /** 選択したリポジトリとブランチに対して、コミット履歴の続きを取得する。 */
    listFileRootGitHistoryCommits(
      request: FileRootGitHistoryCommitsRequest,
    ): Awaitable<FileRootGitHistoryCommitsResult>;
    /** 指定コミットの詳細と、そのコミットで変更されたファイル一覧を取得する。 */
    getFileRootGitHistoryCommitDetail(
      request: FileRootGitHistoryCommitDetailRequest,
    ): Awaitable<FileRootGitHistoryCommitDetailResult>;
    /** 比較元と比較先を解決し、比較方式に従った変更ファイル一覧を取得する。 */
    getFileRootGitHistoryComparison(
      request: FileRootGitHistoryComparisonRequest,
    ): Awaitable<FileRootGitHistoryComparisonResult>;
    /** コミットまたは解決済み比較のパッチを読み、パス指定があればそのファイルに絞る。 */
    getFileRootGitHistoryDiff(
      request: FileRootGitHistoryDiffRequest,
    ): Awaitable<FileRootGitHistoryDiffResult>;
    /** 会話内のメッセージ位置を指定して保存済みの成果物データを取得する。 */
    getSessionMessageArtifact(
      sessionId: string,
      messageIndex: number,
    ): Awaitable<MessageArtifact | null>;
    /** 差分ウィンドウに発行したトークンから表示データを取り出す。 */
    getDiffPreview(token: string): DiffPreviewPayload | null;
    /** 入力を実行せず、Sessionの実行条件で組み立てた送信内容のプレビューを返す。 */
    previewComposerInput(
      sessionId: string,
      userMessage: string,
    ): Promise<unknown>;
  };

/** Main Sessionの管理とターン制御の依存。キューが未構成なら登録側でキュー操作を拒否する。 */
export type MainIpcSessionRuntimeDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcSettingsWindowDeps &
  MainIpcWorkspaceValidationDeps & {
    /** 実行中のターンのライブ状態を読み、該当する実行がなければnullを返す。 */
    getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
    /** 利用枠の観測値を取得する。cacheOnly指定時は更新を要求しない。 */
    getProviderQuotaTelemetry(
      providerId: string,
      options?: { cacheOnly?: boolean },
    ): Promise<ProviderQuotaTelemetry | null>;
    /** Sessionのコンテキスト使用量を取得する。未観測ならnullを返す。 */
    getSessionContextTelemetry(
      sessionId: string,
    ): SessionContextTelemetry | null;
    /** 実行中の承認要求をIDで指定し、待機している処理に決定を渡す。 */
    resolveLiveApproval(
      sessionId: string,
      requestId: string,
      decision: LiveApprovalDecision,
    ): void;
    /** 実行中の質問に対する回答を、要求IDを指定してprovider側へ渡す。 */
    resolveLiveElicitation(
      sessionId: string,
      requestId: string,
      response: LiveElicitationResponse,
    ): Awaitable<void>;
    /** Homeで選択し検証した起動条件から、新しいMain Sessionを作成する。 */
    createSession(input: CreateSessionRequest): Awaitable<Session>;
    /** 既存のSessionを更新し、会話表示に使う反映後の状態を返す。 */
    updateSession(session: Session): Awaitable<Session>;
    /** 対象個体の追加ディレクトリに指定パスを追加または解除する。 */
    changeSessionAdditionalDirectory(
      request: ChangeSessionAdditionalDirectoryRequest,
    ): Awaitable<void>;
    /** 実行設定とレビュアー変更時の確認情報を渡し、受付または後続更新による失効を結果で区別する。 */
    setSessionExecutionOptions(
      request: SetSessionExecutionOptionsRequest,
    ): Awaitable<SetExecutionOptionsResult>;
    /** 対象個体のタイトルを確定し、表示用データに反映されたかも返す。 */
    setSessionTitle(
      request: SetSessionTitleRequest,
    ): Awaitable<SetSessionTitleResult>;
    /** 対象個体のメッセージ位置を指定して、ブックマーク状態だけを更新する。 */
    setSessionMessageBookmark(
      request: SetSessionMessageBookmarkRequest,
    ): Awaitable<void>;
    /** Session一覧でのピン状態を保存し、更新後の要約を返す。 */
    setSessionPinned(
      request: SetSessionPinnedRequest,
    ): Awaitable<SessionSummary>;
    /** 指定Sessionを削除し、削除の成功後に紐づく端末を解放する。 */
    deleteSession(sessionId: string): Awaitable<void>;
    /** 最終活動時刻を基準に削除し、実際に削除したSessionの端末を解放する。 */
    deleteSessionsLastActiveBefore(
      request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
    ): Awaitable<DeleteSessionsResult>;
    /** 現行のSession個体でターンをキューに登録し、その時点の表示用Sessionを返す。 */
    runSessionTurn(
      sessionId: string,
      request: RunSessionTurnRequest,
    ): Promise<Session>;
    /** 実行取消を委譲する。非同期処理の後でも所有者を再確認できるよう認可関数を渡す。 */
    cancelSessionRun(
      request: CancelSessionRunRequest,
      assertAuthorized: () => void,
    ): Awaitable<void>;
    queue?: Pick<
      import("../../src-shared/ipc/withmate-window-api.js").WithMateWindowSessionApi,
      | "enqueueSessionTurn"
      | "getSessionTurnQueueReceipt"
      | "listSessionTurnQueue"
      | "reorderQueuedSessionTurns"
      | "listSessionTurnQueueReceipts"
      | "cancelQueuedSessionTurn"
      | "sendQueuedSessionInput"
      | "beginQueuedSessionTurnEdit"
      | "updateQueuedSessionTurn"
      | "cancelQueuedSessionTurnEdit"
    > & {
      /** 失敗したターンを再登録する。元のフレームと所有者の再確認を受付処理に渡せる。 */
      retryFailedSessionTurn(
        sessionId: string,
        request: import("../../src-shared/session/session-turn-queue.js").RetryFailedSessionTurnRequest,
        assertCurrent?: () => void,
      ): Promise<
        import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueAcceptanceResult
      >;
      /** rendererが遷移・消失した際、残ったキュー項目の編集状態を解放する。 */
      releaseQueuedSessionTurnEdit(sessionId: string): Promise<void>;
    };
    /** 操作対象がAuxiliaryの場合に、キューの送信元を親ウィンドウへ照合できるようにする。 */
    getAuxiliarySessionStatus?(
      sessionId: string,
    ): Awaitable<
      | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
      | null
    >;
    /** 新規ターンを作らず、実行中ターンへの追加送信結果を返す。 */
    steerSessionTurn?(
      sessionId: string,
      request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest,
    ): Promise<
      import("../../src-shared/session/runtime-state.js").SteerSessionTurnResult
    >;
  };

/** Mateの単一プロフィールと投影ファイルの参照・変更を支える依存。 */
export type MainIpcMateDeps = {
  /** プロフィールの保存可否と作成状態を区別して返す。 */
  getMateState(): Awaitable<MateStorageState>;
  /** 保存済みのプロフィールを取得する。取得できるプロフィールがなければnull。 */
  getMateProfile(): Awaitable<MateProfile | null>;
  /** 初期入力からMateのプロフィールを作成し、保存後の内容を返す。 */
  createMate(input: CreateMateInput): Promise<MateProfile>;
  /** 既存プロフィールを更新し、反映後の内容を返す。 */
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  /** 作成済みMateのアバターを差し替え、画像パスを指定しない場合は取り除く。 */
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  /** 保存機能が使える場合、Mateのディレクトリを削除してからプロフィール行を削除する。 */
  resetMate(): Promise<void>;
};

/** Characterのカタログ・永続定義と作成支援の接続先。 */
export type MainIpcCharacterDeps = {
  /** 一覧用の項目を取得する。オプションでアーカイブ済みも含められる。 */
  listCharacters(
    options?: { includeArchived?: boolean } | null,
  ): Awaitable<CharacterCatalogEntry[]>;
  /** IDから定義を含む詳細を取得する。対象がなければnull。 */
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  /** 新しいCharacterを登録し、永続化された詳細を返す。 */
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  /** 定義本文の更新とは分けて、Characterの表示用情報を保存する。 */
  updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Awaitable<CharacterDetail>;
  /** メタデータの編集とは別に、Characterの定義本文を更新する。 */
  updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Awaitable<CharacterDetail>;
  /** Characterを削除せずアーカイブ状態へ移し、一覧項目を返す。 */
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  /** 明示指定された有効なCharacterだけを起動用に返し、他の候補で代用しない。 */
  resolveLaunchCharacter(
    input?: ResolveLaunchCharacterInput | null,
  ): Awaitable<CharacterDetail | null>;
  /** 作成支援用のSessionを開始し、そのウィンドウを開く。 */
  startCharacterAuthoringSession(
    input: StartCharacterAuthoringSessionInput,
  ): Awaitable<CharacterAuthoringSessionStartResult>;
};

/** 再利用するプロンプトの保存と一覧の更新を担う依存。 */
export type MainIpcPromptTemplateDeps = {
  /** rendererが選択・編集するための保存済みテンプレート一覧を取得する。 */
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  /** テンプレートを新規保存し、配信した更新後の一覧を返す。 */
  createPromptTemplate(
    input: CreatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  /** 既存テンプレートの変更を保存し、配信した更新後の一覧を返す。 */
  updatePromptTemplate(
    input: UpdatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  /** 指定テンプレートを削除し、配信した残りの一覧を返す。 */
  deletePromptTemplate(id: string): Awaitable<PromptTemplate[]>;
};

/** 機能ごとの IPC 依存関係を、登録前に組み立てたもの。 */
export type MainIpcRegistrationDeps = {
  common: MainIpcCommonDeps;
  window: MainIpcWindowDeps;
  catalog: MainIpcCatalogDeps;
  settings: MainIpcSettingsDeps;
  promptTemplates: MainIpcPromptTemplateDeps;
  sessionQuery: MainIpcSessionQueryDeps;
  auxiliary: MainIpcAuxiliaryDeps;
  sessionRuntime: MainIpcSessionRuntimeDeps;
  sessionInstructions: import("./session-instructions.js").MainIpcSessionInstructionsDeps;
  mate: MainIpcMateDeps;
  character: MainIpcCharacterDeps;
};
