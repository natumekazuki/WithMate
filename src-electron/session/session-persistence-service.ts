import path from "node:path";
import {
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  assertSameSessionRelationship,
  normalizeSessionRelationship,
} from "../../src-shared/session/session-role.js";
import {
  validateSessionMetadataPatch,
  type SessionMetadataPatch,
} from "../../src-shared/session/session-metadata.js";
import type { SessionLifecycleOperation } from "./session-lifecycle-operation.js";
import type { ResolvedChildSessionCreation } from "../../src-shared/session/session-child-creation.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";
import {
  buildNewSession,
  cloneSessions,
  getSessionIncarnationId,
  isReadOnlySession,
  projectSessionSummary,
  type CreateSessionInput,
  type Session,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  getModelCatalogItem,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";
import { WorkspaceDirectoryValidationService } from "../files/workspace-directory-validation-service.js";
import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
} from "../../src-shared/settings/additional-directory-state.js";
import type { ChangeSessionAdditionalDirectoryRequest } from "../../src-shared/session/session-mutation-contract.js";
import {
  DEFAULT_CODEX_REVIEWER,
  resolveCodexReviewerUpdate,
} from "../../src-shared/settings/codex-reviewer.js";
import { resolveExecutionOptionsReviewerUpdate } from "../../src-shared/settings/provider-runtime-options.js";
import type { SessionApprovalChoice } from "../../src-shared/settings/session-approval-choice.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import { sessionSummaryToSession } from "./session-summary-adapter.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { hasSameCharacterRuntimeIdentity } from "../../src-shared/character/character-runtime-snapshot.js";
import type {
  DeleteSessionsLastActiveBeforeCutoff,
  DeleteSessionsResult,
} from "../../src-shared/window/withmate-window-types.js";
import {
  SessionIdCollisionError,
  SessionNotFoundError,
  SessionCrewDeletionBlockedError,
} from "./session-storage-errors.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import {
  validateSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import type {
  ConfirmedReviewerChange,
  SetExecutionOptionsResult,
  SetSessionTitleResult,
} from "../../src-shared/session/session-mutation-contract.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";
import type {
  SessionRuntimeMetadataPatchInput,
  SessionRuntimeMetadataPatchResult,
  SessionThreadPatchInput,
  SessionThreadPatchResult,
} from "./session-storage-v6.js";
import type {
  SessionMetadataResult,
  SessionSteerAppendInput,
  SessionSteerBeginInput,
  SessionSteerSettleInput,
  SessionTerminalAppendInput,
  SessionRunMetadataCheckpointInput,
} from "./session-runtime-storage-contract.js";
import type { ComposerAttachment } from "../../src-shared/session/runtime-state.js";
import type { TurnInputDeliveryState } from "../../src-shared/session/session-state.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

/** Session実行の停滞調査用に、処理名と計測値を共通のログ識別子で出力する。 */
function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

/** 永続化サービスが利用する保存層、Sessionキャッシュ、Providerランタイム、通知の境界。 */
export type SessionPersistenceServiceDeps = {
  runProviderRuntimeOperationExclusive?: RunProviderRuntimeOperationExclusive;
  /** 現在キャッシュに載っているSessionの一覧を取得する。 */
  getSessions(): Session[];
  /** 永続化後の投影を反映した一覧でSessionキャッシュを置き換える。 */
  setSessions(nextSessions: Session[]): void;
  /** キャッシュ内のSessionをIDで引き、未読込ならnullを返す。 */
  getSession(sessionId: string): Session | null;
  /** 履歴を含む保存済みSessionを読み、存在しなければnullを返す。 */
  getStoredSession?(sessionId: string): Awaitable<Session | null>;
  /** 履歴を展開せずに保存済みSessionの要約を取得する。 */
  getStoredSessionSummary?(sessionId: string): Awaitable<SessionSummary | null>;
  /** 実行管理側で処理中かを、指定に応じてAuxiliaryも含めて調べる。 */
  isSessionRunInFlight(
    sessionId: string,
    scope?: "self" | "with-auxiliary",
  ): boolean;
  /** 指定の親候補のうち、実行中のアクティブなAuxiliaryを持つSessionのIDを返す。 */
  listRunningActiveAuxiliaryParentIds?(
    sessionIds: readonly string[],
  ): Awaitable<ReadonlySet<string>>;
  /** Crew削除後にランタイムを解放できるよう、親候補に属するAuxiliaryの識別情報を列挙する。 */
  listAuxiliarySessionRuntimeIdentities?(
    parentSessionIds: readonly string[],
  ): Awaitable<
    readonly { id: string; parentSessionId: string; provider: string }[]
  >;
  /** 新規作成と通常の更新を区別してSessionを保存し、確定したレコードを返す。 */
  upsertStoredSession(
    session: Session,
    operation: "create" | "upsert",
  ): Awaitable<Session>;
  /** 指定の世代のSessionで、履歴をそのままにタイトルだけを保存する。 */
  setStoredSessionTitle?(
    sessionId: string,
    incarnationId: string,
    title: string,
  ): Awaitable<void>;
  /** 指定の世代のSessionにメタデータ差分を適用し、保存結果の要約を返す。 */
  patchStoredSessionMetadata?(
    sessionId: string,
    incarnationId: string,
    patch: SessionMetadataPatch,
  ): Awaitable<SessionSummary>;
  /** 対象の世代を統括Sessionへ昇格させ、変更後の要約を返す。 */
  promoteStoredSessionToOverallCoordinator?(
    sessionId: string,
    incarnationId: string,
  ): Awaitable<SessionSummary>;
  /** 履歴上の指定位置にあるメッセージのブックマークだけを保存する。 */
  setStoredSessionMessageBookmark?(
    sessionId: string,
    incarnationId: string,
    messageIndex: number,
    isBookmarked: boolean,
  ): Awaitable<void>;
  /** 指定の世代のSessionに次回送信用の実行設定を書き込む。 */
  setStoredSessionExecutionOptions?(
    sessionId: string,
    incarnationId: string,
    options: SessionExecutionOptions,
  ): Awaitable<void>;
  /** 指定の世代のSessionで追加ディレクトリ一覧を保存し、確定した要約を返す。 */
  setStoredSessionAdditionalDirectories?(
    sessionId: string,
    incarnationId: string,
    directories: string[],
  ): Awaitable<SessionSummary>;
  /** 実行中の古いスナップショット等に、記憶済みの現行実行設定を重ねる。 */
  overlayCurrentExecutionOptions?(session: Session): Session;
  /** 永続化の完了を待たず次回送信に利用できるよう、受理した設定を記憶する。 */
  rememberExecutionOptions?(
    session: Session,
    options: SessionExecutionOptions,
  ): void;
  /** 世代・Provider・現在のスレッドが期待どおりの場合だけスレッドを更新する。 */
  updateStoredSessionThreadIfMatches?(
    input: SessionThreadPatchInput,
  ): Awaitable<SessionThreadPatchResult | null>;
  /** 保存済みのランタイム識別情報が期待値と一致するときだけ次の値を保存する。 */
  updateStoredSessionRuntimeMetadataIfMatches?(
    input: SessionRuntimeMetadataPatchInput,
  ): Awaitable<SessionRuntimeMetadataPatchResult | null>;
  /** Session全体とTurn終端の確定情報を一つの保存処理で更新する。 */
  upsertStoredTerminalSession?(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Awaitable<Session>;
  /** 履歴件数を照合して先頭入力とTurn開始状態を追記し、確定結果を返す。 */
  appendStoredRunningTurnStart?(
    input: SessionRunningTurnStartInput,
  ): Awaitable<SessionRunningTurnStartResult>;
  /** 対象Turnへの追加ユーザー入力を履歴へ追記する。 */
  appendStoredSessionSteer?(
    input: SessionSteerAppendInput,
  ): Awaitable<SessionMetadataResult>;
  /** Providerへの配送に先立ち、追加入力を未確定の状態で履歴へ記録する。 */
  beginStoredSessionSteer?(
    input: SessionSteerBeginInput,
  ): Awaitable<SessionMetadataResult>;
  /** 履歴上の入力位置とTurnを照合し、追加入力の配送結果を確定する。 */
  settleStoredSessionSteer?(
    input: SessionSteerSettleInput,
  ): Awaitable<SessionMetadataResult>;
  /** 末尾の応答とTurn終端の確定情報を増分保存する。 */
  appendStoredSessionTerminal?(
    input: SessionTerminalAppendInput,
  ): Awaitable<SessionMetadataResult>;
  /** 期待した実行状態・スレッドと一致する場合だけ実行メタデータを更新する。 */
  checkpointStoredSessionRunMetadata?(
    input: SessionRunMetadataCheckpointInput,
  ): Awaitable<SessionMetadataResult | null>;
  /** 指定のCharacter作成Sessionのランタイム状態を消去し、確定結果を返す。 */
  clearStoredCharacterAuthoringRuntimeState?(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): Awaitable<SessionCharacterAuthoringRuntimeClearResult>;
  /** 保存層のSession集合を指定の一覧で置き換える。 */
  replaceStoredSessions(sessions: Session[]): Awaitable<void>;
  /** ピン留めだけを保存し、確定したSession要約を返す。 */
  setStoredSessionPinned?(
    sessionId: string,
    isPinned: boolean,
  ): Awaitable<SessionSummary>;
  /** 保存済みSessionの完全な一覧を取得する。 */
  listStoredSessions(): Awaitable<Session[]>;
  /** 履歴を展開せず、保存済みSessionの要約一覧を取得する。 */
  listStoredSessionSummaries?(): Awaitable<SessionSummary[]>;
  /** 操作IDに対応するライフサイクル記録を読み、存在しなければnullを返す。 */
  getSessionLifecycleOperation?(
    operationId: string,
  ): Awaitable<SessionLifecycleOperation | null>;
  /** 再開処理の対象となる未完了のライフサイクル操作を列挙する。 */
  listPendingSessionLifecycleOperations?(): Awaitable<
    SessionLifecycleOperation[]
  >;
  /** 新しいライフサイクル操作を登録するか、同じ入力で開始済みの操作を返す。 */
  beginSessionLifecycleOperation?(
    input: Parameters<
      import("./session-storage-v6.js").SessionStorageV6["beginSessionLifecycleOperation"]
    >[0],
  ): Awaitable<SessionLifecycleOperation>;
  /** 操作IDに対応する進行段階と、渡された場合は管理対象リソースを保存する。 */
  advanceSessionLifecycleOperation?(
    operationId: string,
    phase: SessionLifecycleOperation["phase"],
    resources?: SessionLifecycleOperation["resources"],
  ): Awaitable<SessionLifecycleOperation>;
  /** 開始済みの削除操作に対してCrew削除を適用し、更新後の操作記録を返す。 */
  deleteSessionCrewForLifecycle?(
    operationId: string,
  ): Awaitable<SessionLifecycleOperation>;
  /** 再試行でも同じ作成条件を使えるよう、解決済みの入力を操作記録に保持する。 */
  prepareSessionLifecycleCreation?(
    operationId: string,
    input: CreateSessionInput,
  ): Awaitable<SessionLifecycleOperation>;
  /** ルートSessionの世代を指定し、保存状態からCrew削除の阻害要因を取得する。 */
  getStoredCrewDeletionStatus?(
    sessionId: string,
    incarnationId: string,
  ): Awaitable<CrewDeletionStatus>;
  /** 最終活動が基準時刻より前のCrewのルートIDを列挙する。 */
  listStoredSessionIdsLastActiveBefore?(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): Awaitable<string[]>;
  /** 指定したSessionを保存層から除く単件削除経路。 */
  deleteStoredSession?(sessionId: string): Awaitable<void>;
  /** 削除対象として確定した複数のSessionを保存層からまとめて除く。 */
  deleteStoredSessions?(sessionIds: readonly string[]): Awaitable<void>;
  getAppSettings: () => Awaitable<AppSettings>;
  /** 必要に応じて作業場所やProviderを指定し、モデル探索の結果を取得する。 */
  getModelCatalogSnapshot(
    workspacePath?: string,
    providerId?: string,
  ): Awaitable<ModelCatalogSnapshot>;
  /** 指定Characterの現行定義から保存用ランタイムスナップショットを取得する。 */
  createCharacterRuntimeSnapshot?(
    characterId: string,
  ): Awaitable<CharacterRuntimeSnapshot | null>;
  /** Providerの切り替えやSession削除で不要になるコンテキスト計測を消去する。 */
  clearSessionContextTelemetry(sessionId: string): void;
  /** 指定のSessionに紐づくProvider側のスレッド管理状態を無効化する。 */
  invalidateProviderSessionThread(
    providerId: string | null | undefined,
    sessionId: string,
  ): Awaitable<void>;
  /** 削除やProvider切り替えで不要になるSessionのランタイムバインディングを失効させる。 */
  revokeSessionAgentRuntimeBindings?(sessionId: string): void;
  /** 指定のSessionウィンドウを閉じる通常経路。 */
  closeSessionWindow(sessionId: string): void;
  /** Session削除時に、対象ウィンドウを破棄するための専用経路。 */
  discardSessionWindow?(sessionId: string): void;
  /** 変更対象を通知し、詳細が変わらない操作では詳細の更新を省略できる。 */
  broadcastSessions(sessionIds?: Iterable<string>, detailChanged?: false): void;
};

/** 保存上の状態とランタイム状態のどちらかが実行中なら、Sessionを実行中と扱う。 */
function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

/** 同じIDの旧レコードを除き、確定したSessionを一覧の先頭へ置く。 */
function upsertSessionInList(sessions: Session[], stored: Session): Session[] {
  return [stored, ...sessions.filter((session) => session.id !== stored.id)];
}

/** 保存済みSessionを、履歴本体を持たないキャッシュ用の形へ変換する。 */
function toCachedSession(session: Session): Session {
  return sessionSummaryToSession(projectSessionSummary(session));
}

/** 保存済み一覧の順序を保って、すべてキャッシュ用の軽量表現へ変換する。 */
function toCachedSessions(sessions: Session[]): Session[] {
  return sessions.map(toCachedSession);
}

/** 読み取り専用のSessionでは更新を拒否し、新規作成が必要であることを伝える。 */
function assertSessionWritable(session: Session): void {
  if (isReadOnlySession(session)) {
    throw new Error(
      "Read-only sessions cannot be updated. Create a new session.",
    );
  }
}

/** 追加ディレクトリの操作指定やパスが不正な場合に返す検証エラー。 */
export class AdditionalDirectoryValidationError extends Error {}

/** 保存層で確定した削除結果と、保存後の投影・Provider後処理を別々に持つ。 */
type CommittedSessionDeletion = {
  result: DeleteSessionsResult;
  projectionFailures: unknown[];
  providerCleanup: Promise<PromiseSettledResult<void>>[];
};

/** Sessionの保存操作を調停し、確定結果をキャッシュと各ウィンドウへ反映する。 */
export class SessionPersistenceService {
  private sessionMutationQueue: Promise<void> = Promise.resolve();
  private readonly selectionRequestRevisions = new Map<string, number>();
  private readonly selectionCheckpoints = new Map<string, Promise<void>>();

  /** 永続化と確定後の反映に使う依存先を受け取り、保存キューは未処理のない状態から始める。 */
  constructor(private readonly deps: SessionPersistenceServiceDeps) {}

  /** 保存操作を直列化し、個別の失敗は呼び出し元へ返しつつ後続の実行を妨げない。 */
  private enqueueSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionMutationQueue.then(operation);
    this.sessionMutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Character作成に明示指定されたProviderが探索済みかつ有効であれば、そのIDを返す。 */
  async resolveCharacterAuthoringProvider(providerId: string): Promise<string> {
    return (
      await this.resolveEnabledProviderCatalog(
        await this.deps.getModelCatalogSnapshot(),
        await this.deps.getAppSettings(),
        providerId,
        true,
      )
    ).id;
  }

  /** IDの重複を拒否し、モデル・実行深度とCharacterを解決して新規保存する。公開は延期できる。 */
  async createSession(
    input: CreateSessionInput,
    deferPublication = false,
  ): Promise<Session> {
    const requestedSessionId = input.id?.trim() ?? "";
    if (
      requestedSessionId &&
      (this.deps.getSession(requestedSessionId) ||
        (await this.deps.getStoredSession?.(requestedSessionId)))
    ) {
      throw new SessionIdCollisionError(requestedSessionId);
    }

    const appSettings = await this.deps.getAppSettings();
    const snapshot = await this.deps.getModelCatalogSnapshot(
      input.workspacePath,
      input.model ? undefined : (input.provider ?? DEFAULT_PROVIDER_ID),
    );
    const provider = this.resolveEnabledProviderCatalog(
      snapshot,
      appSettings,
      input.provider,
      input.sessionKind === "character-authoring",
    );
    const requestedModel = input.model ?? provider.defaultModelId;
    if (!requestedModel.trim()) {
      throw new Error(
        `Provider ${provider.id} has no available model. Complete model discovery before creating a Session.`,
      );
    }
    const requestedReasoningEffort =
      input.reasoningEffort ?? provider.defaultReasoningEffort;
    assertModelEnabled(
      appSettings.modelAvailability,
      provider.id,
      requestedModel,
    );
    const selection = resolveModelSelection(
      provider,
      requestedModel,
      requestedReasoningEffort,
    );
    const created = buildNewSession({
      ...input,
      provider: provider.id,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      characterRuntimeSnapshot:
        input.characterRuntimeSnapshot ??
        (await this.deps.createCharacterRuntimeSnapshot?.(input.characterId)) ??
        null,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        input.workspacePath,
        input.allowedAdditionalDirectories ?? [],
      ),
    });
    return this.upsertSession(created, "create", deferPublication);
  }

  /** 解決済みの子Session作成条件を現在のモデル探索結果・設定と照合し、保存せずに検証する。 */
  async validateChildSessionCreation(
    input: ResolvedChildSessionCreation,
  ): Promise<void> {
    const settings = await this.deps.getAppSettings();
    const catalog = await this.deps.getModelCatalogSnapshot(
      input.workspacePath,
      input.provider,
    );
    const provider = this.resolveEnabledProviderCatalog(
      catalog,
      settings,
      input.provider,
      true,
    );
    const model = getModelCatalogItem(provider, input.model);
    if (!model)
      throw new Error(
        "The selected child model is not in the discovered model list.",
      );
    if (
      model.reasoningEfforts.length === 0
        ? input.reasoningEffort !== ""
        : !model.reasoningEfforts.includes(input.reasoningEffort)
    )
      throw new Error(
        "The selected child depth is not supported by this model.",
      );
    assertModelEnabled(settings.modelAvailability, provider.id, model.id);
    if (provider.id === "codex" && input.codexSandboxMode === undefined)
      throw new Error("The resolved Codex sandbox mode is unavailable.");
    validateSessionExecutionOptions(
      {
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        approvalMode: input.approvalMode,
        codexSandboxMode: input.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
        codexSpeed: "standard",
        codexReviewer: input.codexReviewer ?? DEFAULT_CODEX_REVIEWER,
        withMateReviewerExplicit: input.withMateReviewerExplicit,
        customAgentName: "",
      },
      provider,
    );
    validateSessionMetadataPatch({
      title: input.title ?? "New task",
      description: input.description ?? "",
    });
  }

  /** 作成条件の準備を保存層に委ね、再開に使うライフサイクル操作の記録を返す。 */
  async prepareSessionLifecycleCreation(
    operationId: string,
    input: CreateSessionInput,
  ): Promise<SessionLifecycleOperation> {
    if (!this.deps.prepareSessionLifecycleCreation)
      throw new Error("Session lifecycle preparation storage is unavailable.");
    return this.deps.prepareSessionLifecycleCreation(operationId, input);
  }

  /** 操作IDで保存済みライフサイクル記録を読み、該当しなければnullを返す。 */
  async getSessionLifecycleOperation(
    operationId: string,
  ): Promise<SessionLifecycleOperation | null> {
    if (!this.deps.getSessionLifecycleOperation)
      throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.getSessionLifecycleOperation(operationId);
  }

  /** 保存層から、回復・再開の対象となる未完了の操作を取得する。 */
  async listPendingSessionLifecycleOperations(): Promise<
    SessionLifecycleOperation[]
  > {
    if (!this.deps.listPendingSessionLifecycleOperations)
      throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.listPendingSessionLifecycleOperations();
  }

  /** ライフサイクル操作の開始を保存層へ要求し、保存された対象と進行状態を受け取る。 */
  async beginSessionLifecycleOperation(
    input: Parameters<
      NonNullable<
        SessionPersistenceServiceDeps["beginSessionLifecycleOperation"]
      >
    >[0],
  ): Promise<SessionLifecycleOperation> {
    if (!this.deps.beginSessionLifecycleOperation)
      throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.beginSessionLifecycleOperation(input);
  }

  /** ライフサイクル操作の進行段階と指定されたリソースを保存し、確定した記録を返す。 */
  async advanceSessionLifecycleOperation(
    operationId: string,
    phase: SessionLifecycleOperation["phase"],
    resources?: SessionLifecycleOperation["resources"],
  ): Promise<SessionLifecycleOperation> {
    if (!this.deps.advanceSessionLifecycleOperation)
      throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.advanceSessionLifecycleOperation(
      operationId,
      phase,
      resources,
    );
  }

  /** 保存済みSessionをキャッシュへ公開し、子Sessionなら親も通知対象に含める。 */
  async publishCreatedSession(sessionId: string): Promise<Session> {
    const session = await this.deps.getStoredSession?.(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    this.syncStoredSession(session);
    this.deps.setSessions(
      upsertSessionInList(this.deps.getSessions(), toCachedSession(session)),
    );
    this.deps.broadcastSessions(
      session.parentSessionId
        ? [sessionId, session.parentSessionId]
        : [sessionId],
    );
    return session;
  }

  /** ライフサイクル処理のため、公開キャッシュを介さず保存層からSessionを読む。 */
  async readSessionForLifecycle(sessionId: string): Promise<Session | null> {
    if (!this.deps.getStoredSession)
      throw new Error("Session lifecycle reads are unavailable.");
    return this.deps.getStoredSession(sessionId);
  }

  /** 保存済み要約を優先し、専用の読取経路がなければ保存済みSessionから要約を組み立てる。 */
  async readSessionSummaryForLifecycle(
    sessionId: string,
  ): Promise<SessionSummary | null> {
    if (this.deps.getStoredSessionSummary)
      return this.deps.getStoredSessionSummary(sessionId);
    const session = await this.readSessionForLifecycle(sessionId);
    return session ? projectSessionSummary(session) : null;
  }

  /** 世代・親子関係・Character所有を照合し、実行中は保存済み状態に追加ディレクトリと更新日時だけを反映する。 */
  async updateSession(nextSession: Session): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      throw new SessionNotFoundError(nextSession.id);
    }

    assertSessionWritable(currentSession);

    const storedCurrentSession =
      (await this.deps.getStoredSession?.(nextSession.id)) ?? currentSession;
    assertSameSessionRelationship(storedCurrentSession, nextSession);
    if (
      getSessionIncarnationId(storedCurrentSession) !==
      getSessionIncarnationId(nextSession)
    ) {
      throw new SessionNotFoundError(nextSession.id);
    }
    if (
      nextSession.messageCount !== undefined ||
      nextSession.messages.some((message) => message.historyIndex !== undefined)
    ) {
      const { messageCount: _count, ...metadata } = nextSession;
      nextSession = {
        ...metadata,
        messages: storedCurrentSession.messages,
        stream: storedCurrentSession.stream,
      };
    }
    if (!hasSameCharacterRuntimeIdentity(storedCurrentSession, nextSession)) {
      throw new Error(
        "A session's Character owner and runtime snapshot cannot be updated.",
      );
    }

    if (
      this.deps.isSessionRunInFlight(nextSession.id) ||
      isRunningSession(currentSession)
    ) {
      if (
        nextSession.taskTitle !== currentSession.taskTitle ||
        nextSession.provider !== currentSession.provider ||
        nextSession.workspacePath !== currentSession.workspacePath ||
        nextSession.threadId !== storedCurrentSession.threadId ||
        nextSession.status !== currentSession.status ||
        nextSession.runState !== currentSession.runState
      ) {
        throw new Error("A running session cannot be updated.");
      }
      return this.enqueueSessionMutation(async () => {
        const latest = this.deps.getSession(nextSession.id);
        if (
          !latest ||
          getSessionIncarnationId(latest) !==
            getSessionIncarnationId(nextSession)
        )
          throw new SessionNotFoundError(nextSession.id);
        assertSessionWritable(latest);
        const stored =
          (await this.deps.getStoredSession?.(nextSession.id)) ?? latest;
        if (
          getSessionIncarnationId(stored) !==
          getSessionIncarnationId(nextSession)
        )
          throw new SessionNotFoundError(nextSession.id);
        return this.upsertSessionNow(
          {
            ...stored,
            allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
              stored.workspacePath,
              nextSession.allowedAdditionalDirectories,
            ),
            updatedAt: nextSession.updatedAt,
          },
          "upsert",
        );
      });
    }

    const shouldResetThreadId =
      Boolean(currentSession.threadId) &&
      currentSession.provider !== nextSession.provider;

    const updatedSession = await this.upsertSession({
      ...nextSession,
      threadId: shouldResetThreadId ? "" : nextSession.threadId,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        nextSession.workspacePath,
        nextSession.allowedAdditionalDirectories,
      ),
    });

    const providerChanged = currentSession.provider !== updatedSession.provider;
    if (providerChanged) {
      this.deps.clearSessionContextTelemetry(updatedSession.id);
      this.deps.revokeSessionAgentRuntimeBindings?.(updatedSession.id);
      await this.deps.invalidateProviderSessionThread(
        currentSession.provider,
        updatedSession.id,
      );
    }

    if (
      !providerChanged &&
      currentSession.threadId &&
      !updatedSession.threadId
    ) {
      await this.deps.invalidateProviderSessionThread(
        currentSession.provider,
        updatedSession.id,
      );
    }

    return updatedSession;
  }

  /** 現在の世代と要求の有効性を保存直前に確認し、ファイル自体は変更せず追加ディレクトリ登録だけを更新する。 */
  async changeAdditionalDirectory(
    request: ChangeSessionAdditionalDirectoryRequest,
    assertCurrent?: () => void,
  ): Promise<SessionSummary> {
    const { sessionId, incarnationId, operation, directoryPath } = request;
    if (
      (operation !== "add" && operation !== "remove") ||
      typeof directoryPath !== "string" ||
      !directoryPath.trim() ||
      directoryPath.length > 32768 ||
      !path.isAbsolute(directoryPath) ||
      (process.platform === "win32" &&
        path.parse(directoryPath).root.length === 1)
    ) {
      throw new AdditionalDirectoryValidationError(
        "An absolute additional directory path is required.",
      );
    }
    if (operation === "add") {
      const validation =
        await new WorkspaceDirectoryValidationService().validate(directoryPath);
      if (!validation.valid)
        throw new AdditionalDirectoryValidationError(
          `The additional directory is invalid: ${validation.reason}.`,
        );
    }
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      const stored =
        (await this.deps.getStoredSessionSummary?.(sessionId)) ??
        (await this.deps.getStoredSession?.(sessionId)) ??
        current;
      if (getSessionIncarnationId(stored) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      const directories =
        operation === "add"
          ? addAllowedAdditionalDirectory(
              stored.allowedAdditionalDirectories,
              directoryPath,
            )
          : removeAllowedAdditionalDirectory(
              stored.allowedAdditionalDirectories,
              directoryPath,
            );
      if (!this.deps.setStoredSessionAdditionalDirectories)
        throw new Error("Session additional directory storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.setStoredSessionAdditionalDirectories(
        sessionId,
        incarnationId,
        normalizeAllowedAdditionalDirectories(
          stored.workspacePath,
          directories,
        ),
      );
      this.runCommittedProjectionBestEffort(
        "additional directory",
        "cache update",
        () =>
          this.deps.setSessions(
            this.deps.getSessions().map((session) =>
              session.id === sessionId &&
              getSessionIncarnationId(session) === incarnationId
                ? {
                    ...session,
                    allowedAdditionalDirectories:
                      summary.allowedAdditionalDirectories,
                  }
                : session,
            ),
          ),
      );
      this.runCommittedProjectionBestEffort(
        "additional directory",
        "broadcast",
        () => this.deps.broadcastSessions([sessionId]),
      );
      return summary;
    });
  }

  /** 現在の世代が実行中でない通常のStandalone Sessionであることを確かめて、統括Sessionへ昇格させる。 */
  async promoteSessionToOverallCoordinator(
    sessionId: string,
    incarnationId: string,
    assertCurrent?: () => void,
  ): Promise<SessionSummary> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (
        current.sessionKind !== "default" ||
        (current.sessionRole ?? "standalone") !== "standalone" ||
        this.deps.isSessionRunInFlight(sessionId, "self") ||
        isRunningSession(current)
      ) {
        throw new Error(
          "Only an idle Standalone Session can become an overall coordinator.",
        );
      }
      if (!this.deps.promoteStoredSessionToOverallCoordinator)
        throw new Error("Session Role storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.promoteStoredSessionToOverallCoordinator(
        sessionId,
        incarnationId,
      );
      this.deps.setSessions(
        upsertSessionInList(this.deps.getSessions(), {
          ...current,
          ...summary,
        }),
      );
      this.deps.broadcastSessions([sessionId]);
      return summary;
    });
  }

  /** 検証済みのタイトル・説明の差分だけを保存し、確定値をキャッシュと一覧通知へ反映する。 */
  async patchSessionMetadata(
    sessionId: string,
    incarnationId: string,
    patch: SessionMetadataPatch,
    assertCurrent?: () => void,
  ): Promise<SessionSummary> {
    const value = validateSessionMetadataPatch(patch);
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (!this.deps.patchStoredSessionMetadata)
        throw new Error("Session metadata storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.patchStoredSessionMetadata(
        sessionId,
        incarnationId,
        value,
      );
      this.runCommittedProjectionBestEffort("metadata", "cache update", () =>
        this.deps.setSessions(
          this.deps.getSessions().map((session) =>
            session.id === sessionId &&
            getSessionIncarnationId(session) === incarnationId
              ? {
                  ...session,
                  taskTitle: summary.taskTitle,
                  description: summary.description,
                }
              : session,
          ),
        ),
      );
      this.runCommittedProjectionBestEffort("metadata", "broadcast", () =>
        this.deps.broadcastSessions([sessionId], false),
      );
      return summary;
    });
  }

  /** 実行中でないSessionの空でないタイトルを保存し、保存後の投影成否を別に返す。 */
  async setSessionTitle(
    sessionId: string,
    incarnationId: string,
    title: string,
  ): Promise<SetSessionTitleResult> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (
        this.deps.isSessionRunInFlight(sessionId) ||
        isRunningSession(current)
      ) {
        throw new Error("A running session cannot be updated.");
      }
      if (!title.trim()) throw new Error("The Session title cannot be empty.");
      if (!this.deps.setStoredSessionTitle)
        throw new Error("Session title storage is unavailable.");
      await this.deps.setStoredSessionTitle(sessionId, incarnationId, title);
      let projectionUpdated = true;
      try {
        this.deps.setSessions(
          this.deps
            .getSessions()
            .map((session) =>
              session.id === sessionId &&
              getSessionIncarnationId(session) === incarnationId
                ? { ...session, taskTitle: title }
                : session,
            ),
        );
      } catch (error) {
        projectionUpdated = false;
        console.warn("Committed Session title cache projection failed", error);
      }
      try {
        this.deps.broadcastSessions([sessionId], false);
      } catch (error) {
        projectionUpdated = false;
        console.warn("Committed Session title broadcast failed", error);
      }
      return { status: "committed", projectionUpdated };
    });
  }

  /** 現在の世代を確認し、キャッシュの置換や一覧通知を行わず履歴上のブックマークだけを保存する。 */
  async setSessionMessageBookmark(
    sessionId: string,
    incarnationId: string,
    messageIndex: number,
    isBookmarked: boolean,
  ): Promise<void> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId)
        throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (!this.deps.setStoredSessionMessageBookmark)
        throw new Error("Session bookmark storage is unavailable.");
      await this.deps.setStoredSessionMessageBookmark(
        sessionId,
        incarnationId,
        messageIndex,
        isBookmarked,
      );
    });
  }

  /** 最新の要求だけを次回送信用設定として受理し、Sessionごとに直列化した永続化の成否を受理結果とは別に返す。 */
  async setSessionExecutionOptions(
    sessionId: string,
    incarnationId: string,
    options: SessionExecutionOptions,
    confirmedReviewerChange?: ConfirmedReviewerChange,
    approvalChoice?: SessionApprovalChoice,
  ): Promise<SetExecutionOptionsResult> {
    const revision = (this.selectionRequestRevisions.get(sessionId) ?? 0) + 1;
    this.selectionRequestRevisions.set(sessionId, revision);
    const catalog = await this.deps.getModelCatalogSnapshot();
    if (this.selectionRequestRevisions.get(sessionId) !== revision) {
      throw new Error("The Session execution option selection was superseded.");
    }
    const current = this.deps.getSession(sessionId);
    if (!current || getSessionIncarnationId(current) !== incarnationId)
      throw new SessionNotFoundError(sessionId);
    assertSessionWritable(current);
    const fresh =
      this.deps.overlayCurrentExecutionOptions?.(current) ?? current;
    const provider = catalog.providers.find(
      (entry) => entry.id === fresh.provider,
    );
    if (!provider)
      throw new Error("The Session provider is not in the model catalog.");
    const { withMateReviewerExplicit: _explicit, ...requested } =
      validateSessionExecutionOptions(options, provider);
    const validated = {
      ...requested,
      ...resolveExecutionOptionsReviewerUpdate(
        fresh,
        requested,
        confirmedReviewerChange,
        approvalChoice,
      ),
    };
    if (validated.codexReviewer !== options.codexReviewer)
      validateSessionExecutionOptions(validated, provider);
    this.deps.rememberExecutionOptions?.(fresh, validated);
    this.deps.setSessions(
      this.deps
        .getSessions()
        .map((session) =>
          session.id === sessionId &&
          getSessionIncarnationId(session) === incarnationId
            ? { ...session, ...validated }
            : session,
        ),
    );
    const previous =
      this.selectionCheckpoints.get(sessionId) ?? Promise.resolve();
    const checkpoint = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.deps.setStoredSessionExecutionOptions)
          throw new Error("Session execution option storage is unavailable.");
        await this.deps.setStoredSessionExecutionOptions(
          sessionId,
          incarnationId,
          validated,
        );
      });
    this.selectionCheckpoints.set(sessionId, checkpoint);
    try {
      await checkpoint;
      return { status: "accepted", checkpointSaved: true };
    } catch {
      return { status: "accepted", checkpointSaved: false };
    } finally {
      if (this.selectionCheckpoints.get(sessionId) === checkpoint)
        this.selectionCheckpoints.delete(sessionId);
    }
  }

  /** 他の保存操作と直列化して、ピン留め状態の変更を確定する。 */
  async setSessionPinned(
    sessionId: string,
    isPinned: boolean,
  ): Promise<SessionSummary> {
    return this.enqueueSessionMutation(() =>
      this.setSessionPinnedNow(sessionId, isPinned),
    );
  }

  /** 保存後はキャッシュのピン留めだけ反映し、実行状態や活動日時を置き換えない。 */
  private async setSessionPinnedNow(
    sessionId: string,
    isPinned: boolean,
  ): Promise<SessionSummary> {
    if (!this.deps.setStoredSessionPinned) {
      throw new Error("Pinning is not available for this session format.");
    }
    const stored = await this.deps.setStoredSessionPinned(sessionId, isPinned);
    this.deps.setSessions(
      this.deps
        .getSessions()
        .map((session) =>
          session.id === stored.id
            ? { ...session, isPinned: stored.isPinned }
            : session,
        ),
    );
    this.deps.broadcastSessions([stored.id], false);
    return projectSessionSummary(stored);
  }

  /** 指定したルートからCrew全体を削除し、実行中のメンバーがいる場合は拒否する。 */
  async deleteSession(
    sessionId: string,
    lifecycleOperationId?: string,
  ): Promise<DeleteSessionsResult> {
    /** 実行管理側の排他制御に渡せるよう、実行中のCrewを拒否する削除処理をまとめる。 */
    const commit = () =>
      this.deleteSessionsByIds([sessionId], {
        runningPolicy: "throw",
        allowUncachedDeletion: false,
        lifecycleOperationId,
      });
    const committed = await (this.deps.runProviderRuntimeOperationExclusive?.(
      commit,
    ) ?? commit());
    return this.finishSessionDeletion(committed);
  }

  /** 基準時刻より前の候補をまとめて削除し、実行中のCrewはスキップ結果に分ける。 */
  async deleteSessionsLastActiveBefore(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): Promise<DeleteSessionsResult> {
    /** 候補の検索と削除をまとめ、キャッシュ未読込のCrewも対象にできるようにする。 */
    const commit = async () => {
      const sessionIds = this.deps.listStoredSessionIdsLastActiveBefore
        ? await this.deps.listStoredSessionIdsLastActiveBefore(cutoff)
        : (await this.deps.listStoredSessions())
            .filter(
              (session) =>
                Date.parse(session.updatedAt) < cutoff.cutoffTimestampMs,
            )
            .map((session) => session.id);
      return this.deleteSessionsByIds(sessionIds, {
        runningPolicy: "skip",
        cutoff,
        allowUncachedDeletion: true,
      });
    };
    const committed = await (this.deps.runProviderRuntimeOperationExclusive?.(
      commit,
    ) ?? commit());
    return this.finishSessionDeletion(committed);
  }

  /** 削除は行わず、活動期限を過ぎたCrewのルートSession IDだけを保存層から取得する。 */
  async listCrewRootsLastActiveBefore(
    cutoff: DeleteSessionsLastActiveBeforeCutoff,
  ): Promise<string[]> {
    if (!this.deps.listStoredSessionIdsLastActiveBefore)
      throw new Error("Crew cutoff storage is unavailable.");
    return this.deps.listStoredSessionIdsLastActiveBefore(cutoff);
  }

  /** 保存層の削除阻害要因に、同じCrewで処理中のSessionを重複なく加えて可否を返す。 */
  async getCrewDeletionStatus(
    rootSessionId: string,
    incarnationId: string,
  ): Promise<CrewDeletionStatus> {
    if (!this.deps.getStoredCrewDeletionStatus)
      throw new Error("Crew deletion status storage is unavailable.");
    const status = await this.deps.getStoredCrewDeletionStatus(
      rootSessionId,
      incarnationId,
    );
    const saved = this.deps.listStoredSessionSummaries
      ? await this.deps.listStoredSessionSummaries()
      : await this.deps.listStoredSessions();
    const inFlight = saved.filter(
      (session) =>
        normalizeSessionRelationship(session).rootSessionId === rootSessionId &&
        this.deps.isSessionRunInFlight(session.id),
    );
    const blockers = [
      ...status.blockers,
      ...inFlight
        .filter(
          (session) =>
            !status.blockers.some(
              (blocker) =>
                blocker.kind === "running" && blocker.sessionId === session.id,
            ),
        )
        .map((session) => ({
          kind: "running" as const,
          id: session.id,
          sessionId: session.id,
          message: "A Session execution is still in flight.",
        })),
    ];
    return { allowed: blockers.length === 0, blockers };
  }

  /** 保存時に世代・Provider・旧スレッドを照合し、キャッシュでも同じ期待値が成立する場合だけ反映する。 */
  async updateSessionThreadIfMatches(
    input: SessionThreadPatchInput,
  ): Promise<SessionThreadPatchResult | null> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.updateStoredSessionThreadIfMatches) {
        throw new Error(
          "Conditional Session thread update storage is unavailable.",
        );
      }
      const stored = await this.deps.updateStoredSessionThreadIfMatches(input);
      if (!stored) {
        return null;
      }
      const current = this.deps.getSession(input.sessionId);
      if (
        current &&
        getSessionIncarnationId(current) === input.incarnationId &&
        current.provider === input.provider &&
        current.threadId === input.expectedThreadId
      ) {
        this.deps.setSessions(
          this.deps.getSessions().map((session) =>
            session.id === input.sessionId
              ? {
                  ...session,
                  threadId: input.nextThreadId,
                  updatedAt: stored.updatedAt,
                }
              : session,
          ),
        );
      }
      return stored;
    });
  }

  /** 保存済みのランタイム設定を条件付きで更新し、期待した旧値が残るキャッシュだけに結果を反映する。 */
  async updateSessionRuntimeMetadataIfMatches(
    input: SessionRuntimeMetadataPatchInput,
  ): Promise<SessionRuntimeMetadataPatchResult | null> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.updateStoredSessionRuntimeMetadataIfMatches) {
        throw new Error(
          "Conditional Session runtime metadata update storage is unavailable.",
        );
      }
      const stored =
        await this.deps.updateStoredSessionRuntimeMetadataIfMatches(input);
      if (!stored) {
        return null;
      }
      const current = this.deps.getSession(input.sessionId);
      if (
        current &&
        getSessionIncarnationId(current) === input.incarnationId &&
        current.provider === input.expected.provider &&
        current.model === input.expected.model &&
        current.reasoningEffort === input.expected.reasoningEffort &&
        current.threadId === input.expected.threadId
      ) {
        this.deps.setSessions(
          this.deps.getSessions().map((session) =>
            session.id === input.sessionId
              ? {
                  ...session,
                  provider: input.next.provider,
                  catalogRevision: input.next.catalogRevision,
                  model: input.next.model,
                  reasoningEffort: input.next.reasoningEffort,
                  threadId: input.next.threadId,
                  updatedAt: stored.updatedAt,
                }
              : session,
          ),
        );
      }
      return stored;
    });
  }

  /** 保存済みの削除結果を変えず、投影とProvider解放で生じた失敗をひとつの例外にまとめる。 */
  private async finishSessionDeletion(
    committed: CommittedSessionDeletion,
  ): Promise<DeleteSessionsResult> {
    const results = await Promise.all(committed.providerCleanup);
    const failures = [
      ...committed.projectionFailures,
      ...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "The Session was deleted, but post-deletion projection or provider thread cleanup failed.",
      );
    }
    return committed.result;
  }

  /** ルートごとにCrewと実行状態を確定し、保存層の削除後にキャッシュ・ランタイムを整理する。 */
  private async deleteSessionsByIds(
    sessionIds: readonly string[],
    options: {
      runningPolicy: "throw" | "skip";
      cutoff?: DeleteSessionsLastActiveBeforeCutoff;
      allowUncachedDeletion: boolean;
      lifecycleOperationId?: string;
    },
  ): Promise<CommittedSessionDeletion> {
    const requestedSessionIds = Array.from(
      new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    );
    const savedSessions = this.deps.listStoredSessionSummaries
      ? await this.deps.listStoredSessionSummaries()
      : await this.deps.listStoredSessions();
    const allSessionsById = new Map(
      [...savedSessions, ...this.deps.getSessions()].map(
        (session) => [session.id, session] as const,
      ),
    );
    const crews = requestedSessionIds.map((rootId) => {
      const root = allSessionsById.get(rootId);
      if (root?.parentSessionId)
        throw new Error(
          "Only an entire Crew can be deleted from its root Session.",
        );
      return Array.from(allSessionsById.values())
        .filter(
          (member) =>
            normalizeSessionRelationship(member).rootSessionId === rootId,
        )
        .map((member) => member.id);
    });
    const uniqueSessionIds = Array.from(new Set(crews.flat()));
    const skippedRunningSessionIds: string[] = [];
    const deletableSessionIds: string[] = [];
    const currentSessionsById = allSessionsById;
    const runningActiveAuxiliaryParentIds =
      (await this.deps.listRunningActiveAuxiliaryParentIds?.(
        uniqueSessionIds,
      )) ?? new Set<string>();
    const auxiliaryRuntimeIdentities =
      (await this.deps.listAuxiliarySessionRuntimeIdentities?.(
        uniqueSessionIds,
      )) ?? [];

    for (const crew of crews) {
      if (
        crew.some((sessionId) => {
          const session = currentSessionsById.get(sessionId);
          return (
            this.deps.isSessionRunInFlight(sessionId) ||
            runningActiveAuxiliaryParentIds.has(sessionId) ||
            (session
              ? session.status === "running" || session.runState === "running"
              : false)
          );
        })
      ) {
        if (options.runningPolicy === "throw") {
          throw new SessionCrewDeletionBlockedError(
            "A running Crew cannot be deleted.",
          );
        }
        skippedRunningSessionIds.push(...crew);
        continue;
      }
      deletableSessionIds.push(...crew);
    }

    if (deletableSessionIds.length === 0) {
      return {
        result: {
          cutoffDate: options.cutoff?.cutoffDate,
          cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
          deletedSessionIds: [],
          deletedAuxiliarySessionIds: [],
          skippedRunningSessionIds,
        },
        providerCleanup: [],
        projectionFailures: [],
      };
    }

    if (options.lifecycleOperationId) {
      if (!this.deps.deleteSessionCrewForLifecycle)
        throw new Error("Crew lifecycle deletion storage is unavailable.");
      await this.deps.deleteSessionCrewForLifecycle(
        options.lifecycleOperationId,
      );
    } else if (this.deps.deleteStoredSessions) {
      await this.deps.deleteStoredSessions(deletableSessionIds);
    } else if (this.deps.deleteStoredSession) {
      for (const sessionId of deletableSessionIds) {
        await this.deps.deleteStoredSession(sessionId);
      }
    } else {
      throw new Error("session delete storage dependency is not configured.");
    }
    const deletableSessionIdSet = new Set(deletableSessionIds);
    const projectionFailures: unknown[] = [];
    /** 保存後の個別処理に失敗しても残りの整理を続けられるよう、例外を控える。 */
    const projectDeletion = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        projectionFailures.push(error);
      }
    };
    projectDeletion(() =>
      this.deps.setSessions(
        this.deps
          .getSessions()
          .filter((entry) => !deletableSessionIdSet.has(entry.id)),
      ),
    );
    const runtimeIdentities: { id: string; provider: string | null }[] = [];

    for (const sessionId of deletableSessionIds) {
      const deletedSession = currentSessionsById.get(sessionId);
      projectDeletion(() =>
        this.deps.revokeSessionAgentRuntimeBindings?.(sessionId),
      );
      runtimeIdentities.push({
        id: sessionId,
        provider: deletedSession?.provider ?? null,
      });
      projectDeletion(() => this.deps.clearSessionContextTelemetry(sessionId));
      projectDeletion(() =>
        (this.deps.discardSessionWindow ?? this.deps.closeSessionWindow)(
          sessionId,
        ),
      );
    }
    const deletableParentIds = new Set(deletableSessionIds);
    const deletedAuxiliarySessionIds = auxiliaryRuntimeIdentities
      .filter((auxiliary) => deletableParentIds.has(auxiliary.parentSessionId))
      .map((auxiliary) => auxiliary.id);
    for (const auxiliary of auxiliaryRuntimeIdentities) {
      if (!deletableParentIds.has(auxiliary.parentSessionId)) {
        continue;
      }
      projectDeletion(() =>
        this.deps.revokeSessionAgentRuntimeBindings?.(auxiliary.id),
      );
      runtimeIdentities.push({
        id: auxiliary.id,
        provider: auxiliary.provider,
      });
      projectDeletion(() =>
        this.deps.clearSessionContextTelemetry(auxiliary.id),
      );
      projectDeletion(() =>
        (this.deps.discardSessionWindow ?? this.deps.closeSessionWindow)(
          auxiliary.id,
        ),
      );
    }

    projectDeletion(() => this.deps.broadcastSessions(deletableSessionIds));

    // 新しい所有者が入れるようになる前に、古いランタイムをすべて同期的に切り離す。
    // プロバイダーアダプターは、最初の非同期待機に入る前に古いリソースを取得する。
    const providerCleanup = runtimeIdentities.map(
      (identity): Promise<PromiseSettledResult<void>> => {
        try {
          return Promise.resolve(
            this.deps.invalidateProviderSessionThread(
              identity.provider,
              identity.id,
            ),
          ).then(
            () => ({ status: "fulfilled", value: undefined }),
            (reason: unknown) => ({ status: "rejected", reason }),
          );
        } catch (reason) {
          return Promise.resolve({ status: "rejected", reason });
        }
      },
    );

    return {
      result: {
        cutoffDate: options.cutoff?.cutoffDate,
        cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
        deletedSessionIds: deletableSessionIds,
        deletedAuxiliarySessionIds,
        skippedRunningSessionIds,
      },
      providerCleanup,
      projectionFailures,
    };
  }

  /** Sessionの新規作成または通常更新を保存キューで実行し、必要ならキャッシュ公開を延期する。 */
  async upsertSession(
    nextSession: Session,
    operation: "create" | "upsert" = "upsert",
    deferPublication = false,
  ): Promise<Session> {
    return this.enqueueSessionMutation(() =>
      this.upsertSessionNow(
        nextSession,
        operation,
        undefined,
        deferPublication,
      ),
    );
  }

  /** 現在の整理情報を保ったSession全体を、Turn終端の確定情報とともに保存する。 */
  async upsertTerminalSession(
    nextSession: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.enqueueSessionMutation(() =>
      this.upsertSessionPreservingPinNow(nextSession, terminalCommit),
    );
  }

  /** 履歴件数を照合して通常Turnの開始と先頭のユーザー入力を保存し、確定後のSessionを返す。 */
  async persistRunningTurnStart(
    nextSession: Session,
    expectedMessageCount: number,
  ): Promise<Session> {
    return this.enqueueSessionMutation(
      async () =>
        (
          await this.persistRunningTurnStartNow(
            nextSession,
            expectedMessageCount,
          )
        ).session,
    );
  }

  /** キュー項目を指定してTurn開始を確定し、保存済みのSessionとTurn記録を返す。 */
  async persistQueuedTurnStart(
    nextSession: Session,
    expectedMessageCount: number,
    queueId: string,
    turn: SessionTurnInput,
  ): Promise<{ session: Session; turn: SessionTurnRecord }> {
    return this.enqueueSessionMutation(async () => {
      const result = await this.persistRunningTurnStartNow(
        nextSession,
        expectedMessageCount,
        { queueId, turn },
      );
      if (!result.turn)
        throw new Error(
          "The queued turn start did not return its committed turn.",
        );
      return { session: result.session, turn: result.turn };
    });
  }

  /** 実行状態と末尾のユーザー入力を検証し、Characterスナップショットを含む開始情報を増分保存して反映する。 */
  private async persistRunningTurnStartNow(
    nextSession: Session,
    expectedMessageCount: number,
    queuedTurn?: SessionRunningTurnStartInput["queuedTurn"],
  ): Promise<{ session: Session; turn?: SessionTurnRecord }> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }
    const userMessage = nextSession.messages.at(-1);
    if (
      nextSession.status !== "running" ||
      nextSession.runState !== "running" ||
      (nextSession.messageCount ?? nextSession.messages.length) !==
        expectedMessageCount + 1 ||
      !userMessage ||
      userMessage.role !== "user"
    ) {
      throw new Error("The Session is invalid for starting a running turn.");
    }
    if (!this.deps.appendStoredRunningTurnStart) {
      throw new Error(
        "Incremental storage for starting a running turn is unavailable.",
      );
    }

    const storedResult = await this.deps.appendStoredRunningTurnStart({
      sessionId: nextSession.id,
      incarnationId: nextSession.incarnationId,
      expectedMessageCount,
      userMessage,
      updatedAt: nextSession.updatedAt,
      characterRuntimeSnapshot: nextSession.characterRuntimeSnapshot,
      ...(queuedTurn ? { queuedTurn } : {}),
    });
    if (queuedTurn && !storedResult.queuedTurn)
      throw new Error(
        "The queued turn start did not return its committed turn.",
      );
    const stored = cloneSessions([
      {
        ...nextSession,
        ...storedResult.summary,
        characterRuntimeSnapshot: storedResult.characterRuntimeSnapshot,
        ...(nextSession.messageCount !== undefined
          ? { messageCount: expectedMessageCount + 1 }
          : {}),
      },
    ])[0];
    this.runCommittedProjectionBestEffort(
      "running turn",
      "cache update",
      () => {
        this.deps.setSessions(
          upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)),
        );
      },
    );
    this.runCommittedProjectionBestEffort("running turn", "broadcast", () => {
      this.deps.broadcastSessions([stored.id]);
    });
    return {
      session: stored,
      ...(storedResult.queuedTurn ? { turn: storedResult.queuedTurn } : {}),
    };
  }

  /** 対象Turnへ追加のユーザー入力を増分保存し、キューや返信先の指定があれば併せて渡す。 */
  async appendRunningInput(
    nextSession: Session,
    text: string,
    turnId: number,
    queuedInput?: SessionSteerAppendInput["queuedInput"],
    replyTo?: import("../../src-shared/session/session-reply.js").SessionReply,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.appendStoredSessionSteer)
        throw new Error("Incremental Session input storage is unavailable.");
      const message = {
        role: "user" as const,
        text,
        ...(replyTo ? { replyTo } : {}),
      };
      const result = await this.deps.appendStoredSessionSteer({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount:
          nextSession.messageCount ?? nextSession.messages.length,
        turnId,
        userMessage: message,
        updatedAt: nextSession.updatedAt,
        ...(queuedInput ? { queuedInput } : {}),
      });
      return this.projectRuntimeAppend(nextSession, result, [
        ...nextSession.messages,
        message,
      ]);
    });
  }

  /** Provider側のTurnと添付に紐づく追加入力を、配送結果が未確定の状態で先に履歴へ保存する。 */
  async beginRunningInput(
    nextSession: Session,
    text: string,
    turnId: number,
    nativeTurnId: string,
    attachments: ComposerAttachment[],
    origin?: import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin,
    questionRequestId?: string,
    replyTo?: import("../../src-shared/session/session-reply.js").SessionReply,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.beginStoredSessionSteer)
        throw new Error("Durable Session input storage is unavailable.");
      const message = {
        role: "user" as const,
        text,
        ...(replyTo ? { replyTo } : {}),
        turnInput: {
          turnId: String(turnId),
          nativeTurnId,
          attachments,
          state: "pending" as const,
          ...(origin ? { origin } : {}),
          ...(questionRequestId ? { questionRequestId } : {}),
        },
      };
      const result = await this.deps.beginStoredSessionSteer({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount:
          nextSession.messageCount ?? nextSession.messages.length,
        turnId,
        userMessage: message,
        nativeTurnId,
        attachments,
        updatedAt: nextSession.updatedAt,
      });
      return this.projectRuntimeAppend(nextSession, result, [
        ...nextSession.messages,
        message,
      ]);
    });
  }

  /** 既存入力の配送結果を履歴位置で確定し、部分履歴でも同じ位置のメッセージに反映する。 */
  async settleRunningInput(
    nextSession: Session,
    messageSeq: number,
    turnId: number,
    state: Exclude<TurnInputDeliveryState, "pending">,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.settleStoredSessionSteer)
        throw new Error("Durable Session input storage is unavailable.");
      const count = nextSession.messageCount ?? nextSession.messages.length;
      const result = await this.deps.settleStoredSessionSteer({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount: count,
        turnId,
        messageSeq,
        state,
        updatedAt: nextSession.updatedAt,
      });
      return this.projectRuntimeAppend(
        nextSession,
        result,
        nextSession.messages.map((message, index) =>
          (message.historyIndex ??
            count - nextSession.messages.length + index) === messageSeq &&
          message.turnInput
            ? { ...message, turnInput: { ...message.turnInput, state } }
            : message,
        ),
      );
    });
  }

  /** 期待する実行状態とスレッドが一致する場合だけメタデータを更新し、不一致を失敗として返す。 */
  async checkpointRuntimeMetadata(
    nextSession: Session,
    expected: Session,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.checkpointStoredSessionRunMetadata)
        throw new Error("Session runtime checkpoint storage is unavailable.");
      const result = await this.deps.checkpointStoredSessionRunMetadata({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expected: {
          status: expected.status,
          runState: expected.runState,
          threadId: expected.threadId,
        },
        next: {
          status: nextSession.status,
          runState: nextSession.runState,
          threadId: nextSession.threadId,
          updatedAt: nextSession.updatedAt,
        },
      });
      if (!result)
        throw new Error(
          "The Session runtime checkpoint no longer matches its owner.",
        );
      return this.projectRuntimeAppend(
        nextSession,
        result,
        nextSession.messages,
      );
    });
  }

  /** 末尾のAssistant応答・実行状態・Turn終端情報を、全履歴を書き直さずまとめて確定する。 */
  async appendTerminalSession(
    nextSession: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      const message = nextSession.messages.at(-1);
      if (!message || message.role !== "assistant")
        throw new Error("Terminal Session requires an assistant message.");
      if (!this.deps.appendStoredSessionTerminal)
        throw new Error("Incremental terminal Session storage is unavailable.");
      const result = await this.deps.appendStoredSessionTerminal({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount:
          (nextSession.messageCount ?? nextSession.messages.length) - 1,
        assistantMessage: message,
        metadata: {
          status: nextSession.status,
          runState: nextSession.runState,
          threadId: nextSession.threadId,
          updatedAt: nextSession.updatedAt,
        },
        terminalCommit,
      });
      return this.projectRuntimeAppend(
        nextSession,
        result,
        nextSession.messages,
      );
    });
  }

  /** 増分保存で確定した要約・件数と現行の実行設定を重ね、ランタイムの履歴断片を保って反映する。 */
  private projectRuntimeAppend(
    nextSession: Session,
    result: SessionMetadataResult,
    messages: Session["messages"],
  ): Session {
    const projected: Session = {
      ...nextSession,
      ...result.summary,
      characterRuntimeSnapshot: result.characterRuntimeSnapshot,
      messageCount: result.messageCount,
      messages,
    };
    const stored =
      this.deps.overlayCurrentExecutionOptions?.(projected) ?? projected;
    this.runCommittedProjectionBestEffort(
      "runtime Session",
      "dependency sync",
      () => this.syncStoredSession(stored),
    );
    this.runCommittedProjectionBestEffort(
      "runtime Session",
      "cache update",
      () => {
        this.deps.setSessions(
          upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)),
        );
      },
    );
    this.runCommittedProjectionBestEffort("runtime Session", "broadcast", () =>
      this.deps.broadcastSessions([stored.id]),
    );
    return stored;
  }

  /** Character作成Sessionだけを対象に、ランタイム状態を保存層で消去して確定結果を反映する。 */
  async clearCharacterAuthoringRuntimeState(
    nextSession: Session,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      const currentSession = this.deps.getSession(nextSession.id);
      if (currentSession) {
        assertSessionWritable(currentSession);
      }
      if (nextSession.sessionKind !== "character-authoring") {
        throw new Error(
          "The Character authoring runtime clear owner does not match the Session.",
        );
      }
      if (!this.deps.clearStoredCharacterAuthoringRuntimeState) {
        throw new Error(
          "Storage for clearing Character authoring runtime state is unavailable.",
        );
      }

      const storedResult =
        await this.deps.clearStoredCharacterAuthoringRuntimeState({
          sessionId: nextSession.id,
          incarnationId: nextSession.incarnationId,
        });
      const stored = cloneSessions([
        {
          ...nextSession,
          ...storedResult.summary,
          characterRuntimeSnapshot: storedResult.characterRuntimeSnapshot,
        },
      ])[0];
      this.runCommittedProjectionBestEffort(
        "Character authoring runtime clear",
        "cache update",
        () => {
          this.deps.setSessions(
            upsertSessionInList(
              this.deps.getSessions(),
              toCachedSession(stored),
            ),
          );
        },
      );
      this.runCommittedProjectionBestEffort(
        "Character authoring runtime clear",
        "broadcast",
        () => {
          this.deps.broadcastSessions([stored.id]);
        },
      );
      return stored;
    });
  }

  /** 実行側のSessionを保存する際、現在のピン留め・タイトル・追加ディレクトリを維持する。 */
  async upsertSessionPreservingPin(nextSession: Session): Promise<Session> {
    return this.enqueueSessionMutation(() =>
      this.upsertSessionPreservingPinNow(nextSession),
    );
  }

  /** 保存キュー内で最新の整理情報を読み直し、古い実行側の値で上書きしないようにする。 */
  private upsertSessionPreservingPinNow(
    nextSession: Session,
    terminalCommit?: SessionTurnTerminalCommit,
  ): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    return this.upsertSessionNow(
      {
        ...nextSession,
        isPinned: currentSession?.isPinned ?? nextSession.isPinned,
        taskTitle: currentSession?.taskTitle ?? nextSession.taskTitle,
        allowedAdditionalDirectories:
          currentSession?.allowedAdditionalDirectories ??
          nextSession.allowedAdditionalDirectories,
      },
      "upsert",
      terminalCommit,
    );
  }

  /** 保存前に履歴と実行設定を補正し、終端保存では確定後の投影エラーを保存結果から切り離す。 */
  private async upsertSessionNow(
    nextSession: Session,
    operation: "create" | "upsert",
    terminalCommit?: SessionTurnTerminalCommit,
    deferPublication = false,
  ): Promise<Session> {
    const startedAt = Date.now();
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }

    const sessionToStore = await this.mergeStoredMessagesForSummaryOnlySession(
      operation === "create"
        ? nextSession
        : (this.deps.overlayCurrentExecutionOptions?.(nextSession) ??
            nextSession),
    );
    const storeStartedAt = Date.now();
    const normalizedSession = {
      ...sessionToStore,
      codexReviewer: resolveCodexReviewerUpdate(
        currentSession,
        sessionToStore.codexReviewer,
      ),
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        sessionToStore.workspacePath,
        sessionToStore.allowedAdditionalDirectories,
      ),
    };
    const stored = terminalCommit
      ? await this.deps.upsertStoredTerminalSession?.(
          normalizedSession,
          terminalCommit,
        )
      : await this.deps.upsertStoredSession(normalizedSession, operation);
    if (!stored) {
      throw new Error(
        "Atomic commit storage for the terminal Session is unavailable.",
      );
    }
    if (deferPublication) return cloneSessions([stored])[0];
    const storeDurationMs = Date.now() - storeStartedAt;
    const cacheStartedAt = Date.now();
    if (terminalCommit) {
      this.runCommittedProjectionBestEffort(
        "terminal Session",
        "dependency sync",
        () => this.syncStoredSession(stored),
      );
      this.runCommittedProjectionBestEffort(
        "terminal Session",
        "cache update",
        () => {
          this.deps.setSessions(
            upsertSessionInList(
              this.deps.getSessions(),
              toCachedSession(stored),
            ),
          );
        },
      );
    } else {
      this.syncStoredSession(stored);
      this.deps.setSessions(
        upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)),
      );
    }
    const cacheDurationMs = Date.now() - cacheStartedAt;
    const broadcastStartedAt = Date.now();
    if (terminalCommit) {
      this.runCommittedProjectionBestEffort(
        "terminal Session",
        "broadcast",
        () => this.deps.broadcastSessions([stored.id]),
      );
    } else {
      this.deps.broadcastSessions([stored.id]);
    }
    logSessionRunStuckInvestigation("persistence.upsert-session.done", {
      sessionId: stored.id,
      durationMs: Date.now() - startedAt,
      storeDurationMs,
      cacheDurationMs,
      broadcastDurationMs: Date.now() - broadcastStartedAt,
      messageCount: stored.messages.length,
      runState: stored.runState,
      status: stored.status,
      cachedRunState: this.deps.getSession(stored.id)?.runState ?? null,
      cachedStatus: this.deps.getSession(stored.id)?.status ?? null,
    });
    return cloneSessions([stored])[0];
  }

  /** Session集合の全置換をほかの保存と直列化し、通知やスレッド無効化の指定を引き渡す。 */
  async replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Promise<Session[]> {
    return this.enqueueSessionMutation(() =>
      this.replaceAllSessionsNow(nextSessions, options),
    );
  }

  /** 集合を保存して再読込し、削除・Provider変更・明示指定に応じて古いランタイムを解放する。 */
  private async replaceAllSessionsNow(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Promise<Session[]> {
    const previousSessions = cloneSessions(this.deps.getSessions());
    const normalizedSessions = nextSessions.map((session) => ({
      ...session,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        session.workspacePath,
        session.allowedAdditionalDirectories,
      ),
    }));

    await this.deps.replaceStoredSessions(normalizedSessions);
    const storedSessions = await this.deps.listStoredSessions();
    this.deps.setSessions(toCachedSessions(storedSessions));
    for (const session of storedSessions) {
      this.syncStoredSession(session);
    }

    const previousSessionsById = new Map(
      previousSessions.map((session) => [session.id, session] as const),
    );
    const nextSessionsById = new Map(
      storedSessions.map((session) => [session.id, session] as const),
    );
    for (const previousSession of previousSessions) {
      const nextSession = nextSessionsById.get(previousSession.id);
      if (!nextSession || nextSession.provider !== previousSession.provider) {
        this.deps.clearSessionContextTelemetry(previousSession.id);
        this.deps.revokeSessionAgentRuntimeBindings?.(previousSession.id);
        await this.deps.invalidateProviderSessionThread(
          previousSession.provider,
          previousSession.id,
        );
      }
      if (!nextSession) {
      }
    }

    for (const sessionId of options?.invalidateSessionIds ?? []) {
      this.deps.revokeSessionAgentRuntimeBindings?.(sessionId);
      const sessionProvider =
        nextSessionsById.get(sessionId)?.provider ??
        previousSessionsById.get(sessionId)?.provider ??
        null;
      await this.deps.invalidateProviderSessionThread(
        sessionProvider,
        sessionId,
      );
    }

    if (options?.broadcast ?? true) {
      this.deps.broadcastSessions(
        new Set([
          ...previousSessions.map((session) => session.id),
          ...storedSessions.map((session) => session.id),
        ]),
      );
    }

    return cloneSessions(storedSessions);
  }

  /** 履歴を持たない更新で既存の会話が消えないよう、キャッシュまたは保存層から履歴とストリームを補う。 */
  private async mergeStoredMessagesForSummaryOnlySession(
    nextSession: Session,
  ): Promise<Session> {
    if (nextSession.messages.length > 0) {
      return nextSession;
    }

    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      return nextSession;
    }

    const sourceSession =
      currentSession.messages.length > 0
        ? currentSession
        : ((await this.deps.getStoredSession?.(nextSession.id)) ?? null);

    if (!sourceSession || sourceSession.messages.length === 0) {
      return nextSession;
    }

    return {
      ...nextSession,
      messages: sourceSession.messages,
      stream: sourceSession.stream,
    };
  }

  /** 明示必須でない要求だけ既定Providerを補い、未探索または無効なProviderを拒否する。 */
  private resolveEnabledProviderCatalog(
    snapshot: ModelCatalogSnapshot,
    appSettings: AppSettings,
    requestedProviderId?: string | null,
    requireRequestedProvider = false,
  ): ModelCatalogProvider {
    const providerId =
      requestedProviderId?.trim() ||
      (requireRequestedProvider ? "" : DEFAULT_PROVIDER_ID);
    if (!providerId)
      throw new Error("Select a provider for Character authoring.");
    const provider = getProviderCatalog(snapshot.providers, providerId);
    if (!provider)
      throw new Error(`Provider ${providerId} model discovery is unavailable.`);
    if (!getProviderAppSettings(appSettings, providerId).enabled) {
      throw new Error(`Provider ${providerId} is disabled in Settings.`);
    }
    return provider;
  }

  /** 保存後の依存先同期として呼ばれるが、現実装では追加の処理を行わない。 */
  private syncStoredSession(stored: Session): void {}

  /** 確定後の投影を試み、失敗は警告として記録して保存済みの結果には波及させない。 */
  private runCommittedProjectionBestEffort(
    owner: string,
    label: string,
    operation: () => void,
  ): void {
    try {
      operation();
    } catch (error) {
      console.warn(`Committed ${owner} ${label} failed`, error);
    }
  }
}
