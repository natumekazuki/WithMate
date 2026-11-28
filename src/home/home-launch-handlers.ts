import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type {
  CreateSessionRequest,
  HomeSessionSummary,
  Session,
  SessionCharacterUsage,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../app/open-session-window-subscription.js";
import type {
  HomeLaunchCharacterCatalog,
  HomeLaunchDraft,
} from "./home-launch-state.js";
import {
  closeLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceToSessionFolder,
  updateLaunchDraftForCharacterSelection,
  updateLaunchDraftForProviderSelection,
  updateLaunchDraftForRandomCharacterSelection,
} from "./home-launch-state.js";
import {
  startHomeLaunch,
  type HomeLaunchCreationAttempt,
  type HomeLaunchFeedbackSource,
  type HomeLaunchResult,
} from "./home-launch-actions.js";

/** 起動欄を開いている間の作成要求、二重開始を防ぐ状態、要求が対応する下書き。 */
export type HomeLaunchLifetime = HomeLaunchCreationAttempt & {
  starting: boolean;
  draft?: HomeLaunchDraft;
};

/** 起動欄の所有状態、候補の取得、ワークスペース検証、作成と Window 表示の依存先。 */
type HomeLaunchHandlersContext = {
  launchDraft: HomeLaunchDraft;
  launchDialogAttemptRef: { current: object | null };
  launchStarting: boolean;
  launchLifetimeRef: { current: HomeLaunchLifetime };
  onDetachedResult: (result: HomeLaunchResult) => void;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  enabledLaunchProviders: readonly ModelCatalogProvider[];
  characterEntries: readonly CharacterCatalogEntry[];
  selectedLaunchProviderId: string | null;
  sessions: readonly HomeSessionSummary[];
  sessionCharacterUsage: readonly SessionCharacterUsage[];
  openSessionWindowIds: readonly string[];
  openSessionWindowIdsLoadStatus: OpenSessionWindowIdsLoadStatus;
  sessionCharacterUsageLoadStatus: SessionSummariesLoadStatus;
  refreshCharacterEntries: () => Promise<readonly CharacterCatalogEntry[]>;
  setLaunchCharacterCatalog: (catalog: HomeLaunchCharacterCatalog) => void;
  setLaunchFeedback: (
    message: string,
    source?: HomeLaunchFeedbackSource,
  ) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  setLaunchDraft: (
    updater: HomeLaunchDraft | ((draft: HomeLaunchDraft) => HomeLaunchDraft),
  ) => void;
  pickWorkspaceDirectory: () => Promise<string | null> | string | null;
  scheduleWorkspaceValidation: (targetPath: string) => void;
  cancelWorkspaceValidation: () => void;
  openSessionWindow: (sessionId: string) => Promise<void>;
  createSession: (
    input: CreateSessionRequest,
  ) => Promise<Session | SessionSummary | null>;
  upsertSessionSummary: (summary: HomeSessionSummary) => void;
};

/** 起動欄の入力、候補選択、検証、開閉と開始を操作する画面側の入口。 */
export type HomeLaunchHandlers = {
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onOpenLaunchDialog: () => Promise<void>;
  onCloseLaunchDialog: () => void;
  onSelectLaunchProvider: (providerId: string) => void;
  onSelectLaunchRole: (role: HomeLaunchDraft["sessionRole"]) => void;
  onSelectLaunchCharacter: (characterId: string) => void;
  onSelectRandomLaunchCharacter: () => void;
  onChangeTitle: (value: string) => void;
  onChangeWorkspacePath: (value: string) => void;
  onStartSession: () => void;
};

/** 起動欄のイベントを現在の下書きと試行へ接続し、閉じた欄の取得結果を次の欄に反映しない。 */
export function buildHomeLaunchHandlers({
  launchDraft,
  launchDialogAttemptRef,
  launchStarting,
  launchLifetimeRef,
  onDetachedResult,
  mateState,
  mateProfile,
  enabledLaunchProviders,
  characterEntries,
  selectedLaunchProviderId,
  sessions,
  sessionCharacterUsage,
  openSessionWindowIds,
  openSessionWindowIdsLoadStatus,
  sessionCharacterUsageLoadStatus,
  refreshCharacterEntries,
  setLaunchCharacterCatalog,
  setLaunchFeedback,
  setLaunchStarting,
  setLaunchDraft,
  pickWorkspaceDirectory,
  scheduleWorkspaceValidation,
  cancelWorkspaceValidation,
  openSessionWindow,
  createSession,
  upsertSessionSummary,
}: HomeLaunchHandlersContext): HomeLaunchHandlers {
  /** ディレクトリ選択が確定した場合だけ、そのパスの検証を予約する。 */
  const onBrowseWorkspace = async () => {
    const selectedPath = await pickWorkspaceDirectory();
    if (!selectedPath) {
      return;
    }

    setLaunchFeedback("");
    scheduleWorkspaceValidation(selectedPath);
  };

  /** 一度だけ新しい起動欄を初期化し、その開閉世代が現行である間にだけ候補一覧を反映する。 */
  const onOpenLaunchDialog = async () => {
    if (launchDialogAttemptRef.current !== null) {
      return;
    }
    const attempt = {};
    launchDialogAttemptRef.current = attempt;
    const lifetime: HomeLaunchLifetime = { starting: false };
    launchLifetimeRef.current = lifetime;
    cancelWorkspaceValidation();
    setLaunchStarting(false);
    setLaunchFeedback("");
    setLaunchCharacterCatalog({ entries: [], status: "loading" });
    setLaunchDraft((current) =>
      openLaunchDraft(current, enabledLaunchProviders[0]?.id ?? ""),
    );
    try {
      const entries = await refreshCharacterEntries();
      if (launchDialogAttemptRef.current !== attempt) {
        return;
      }
      setLaunchCharacterCatalog({ entries, status: "loaded" });
    } catch (error) {
      if (launchDialogAttemptRef.current !== attempt) {
        return;
      }
      setLaunchCharacterCatalog({ entries: [], status: "error" });
      setLaunchFeedback(
        error instanceof Error
          ? error.message
          : "Could not refresh characters.",
      );
    }
  };

  /** 起動欄を閉じて検証と参照を無効化する。すでに送った作成要求そのものは取り消さない。 */
  const onCloseLaunchDialog = () => {
    launchDialogAttemptRef.current = null;
    launchLifetimeRef.current = { starting: false };
    cancelWorkspaceValidation();
    setLaunchFeedback("");
    setLaunchStarting(false);
    setLaunchCharacterCatalog({ entries: [], status: "loading" });
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  /** 選択した Provider を下書きに反映し、以前の通知を消す。 */
  const onSelectLaunchProvider = (providerId: string) => {
    setLaunchFeedback("");
    setLaunchDraft((current) =>
      updateLaunchDraftForProviderSelection(current, providerId),
    );
  };

  /** 同じ欄の二重開始を防ぎ、下書きが一緒なら未確定の作成要求を次の試行でも引き継ぐ。 */
  const onStartSession = async () => {
    const lifetime = launchLifetimeRef.current;
    if (!launchDraft.open || launchStarting || lifetime.starting) {
      return;
    }
    lifetime.starting = true;
    if (lifetime.draft !== launchDraft) {
      lifetime.draft = launchDraft;
      delete lifetime.request;
    }
    try {
      await startHomeLaunch({
        creationAttempt: lifetime,
        draft: launchDraft,
        launchStarting,
        mateState,
        mateProfile,
        selectedProviderId: selectedLaunchProviderId,
        characterEntries,
        sessions,
        sessionCharacterUsage,
        openSessionWindowIds,
        openSessionWindowIdsLoadStatus,
        sessionCharacterUsageLoadStatus,
        createSession,
        openSessionWindow,
        closeLaunchDialog: onCloseLaunchDialog,
        setLaunchFeedback,
        setLaunchStarting,
        upsertSessionSummary,
        /** 作成応答が、現在も表示している起動欄の試行に属しているか確かめる。 */
        isCurrentAttempt: () => launchLifetimeRef.current === lifetime,
        onDetachedResult,
      });
    } finally {
      lifetime.starting = false;
    }
  };

  return {
    /** ディレクトリ選択を開く。選択と検証の処理は選択側のハンドラーに任せる。 */
    onBrowseWorkspace: () => void onBrowseWorkspace(),
    /** 手入力の検証を止め、ワークスペースを専用 Session Folder に切り替える。 */
    onSelectSessionFolder: () => {
      cancelWorkspaceValidation();
      setLaunchFeedback("");
      setLaunchDraft((current) => setLaunchWorkspaceToSessionFolder(current));
    },
    onOpenLaunchDialog,
    onCloseLaunchDialog,
    onSelectLaunchProvider,
    /** 新規 Session の役割を変更し、以前の入力に対する通知を消す。 */
    onSelectLaunchRole: (sessionRole) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, sessionRole }));
    },
    /** 選んだ Character の指定に切り替え、ランダム選択を解除する。 */
    onSelectLaunchCharacter: (characterId) => {
      setLaunchFeedback("");
      setLaunchDraft((current) =>
        updateLaunchDraftForCharacterSelection(current, characterId),
      );
    },
    /** 今は対象を固定せず、起動時に Character を選ぶ方式へ切り替える。 */
    onSelectRandomLaunchCharacter: () => {
      setLaunchFeedback("");
      setLaunchDraft((current) =>
        updateLaunchDraftForRandomCharacterSelection(current),
      );
    },
    /** 起動入力のタイトルだけを更新し、前の値に対する通知を消す。 */
    onChangeTitle: (value) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, title: value }));
    },
    /** 入力したパスをすぐ採用せず、新しい値の検証に渡す。 */
    onChangeWorkspacePath: (value) => {
      setLaunchFeedback("");
      scheduleWorkspaceValidation(value);
    },
    /** 画面の開始操作から、その欄に紐付く非同期の作成を開始する。 */
    onStartSession: () => void onStartSession(),
  };
}
