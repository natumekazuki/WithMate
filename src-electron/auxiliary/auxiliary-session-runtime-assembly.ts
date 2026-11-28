import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  LiveElicitationResponse,
  LiveElicitationRequest,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionTurnNotificationTarget } from "../session/session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../session/session-runtime-service.js";
import type { AgentRuntimeSourceRef } from "../../src-shared/agent-runtime/agent-runtime-source.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";

/** Auxiliary の実行依存が現在のストレージ世代に属するか検証する境界。 */
type AuxiliaryRuntimeOwner = {
  /** 操作時点で所有世代が失効していれば、その操作を続行させない。 */
  assertActive(operation: string): void;
};

/** 共通 Session ランタイムを Auxiliary の永続化・親の解決・プロバイダー操作に接続する依存関係。 */
export type AuxiliarySessionRuntimeAssemblyDeps = {
  owner: AuxiliaryRuntimeOwner;
  admission: Required<
    Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">
  >;
  auxiliary: {
    /** 共通ランタイムが使える Session の形で、対象の Auxiliary を読み出す。 */
    getRuntimeSession(sessionId: string): Promise<Session | null>;
    /** 親や所有者を解決するため、Auxiliary 自身の保存データを読み取る。 */
    getSession(sessionId: string): Promise<AuxiliarySession | null>;
    appendRunningInput: SessionRuntimeServiceDeps["appendRunningInput"];
    beginRunningInput?: SessionRuntimeServiceDeps["beginRunningInput"];
    settleRunningInput?: SessionRuntimeServiceDeps["settleRunningInput"];
    appendTerminalSession: SessionRuntimeServiceDeps["appendTerminalSession"];
    beginSourceDisplayTurn?: SessionRuntimeServiceDeps["beginSourceDisplayTurn"];
    checkpointRuntimeMetadata: SessionRuntimeServiceDeps["checkpointRuntimeMetadata"];
    /** 想定した履歴件数を前提に、実行が始まった Turn を Auxiliary の履歴に確定する。 */
    persistRunningTurnStart(
      session: Session,
      expectedMessageCount: number,
    ): Promise<Session>;
    persistQueuedTurnStart?: SessionRuntimeServiceDeps["persistQueuedTurnStart"];
    /** 指定 ID が Auxiliary の保存先に属するかを確認する。 */
    isAuxiliarySession(sessionId: string): Promise<boolean>;
  };
  parent: {
    /** Auxiliary を所有する親 Main Session の保存データを読む。 */
    getSession(sessionId: string): Promise<Session | null>;
  };
  resolution: {
    assertSavedReplyTo?: SessionRuntimeServiceDeps["assertSavedReplyTo"];
    resolveRuntimeSessionForTurn: NonNullable<
      SessionRuntimeServiceDeps["resolveRuntimeSessionForTurn"]
    >;
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
    assertCapturedComposerAttachmentsAvailable?: SessionRuntimeServiceDeps["assertCapturedComposerAttachmentsAvailable"];
  };
  provider: {
    getProviderCodingAdapter: NonNullable<
      SessionRuntimeServiceDeps["getProviderCodingAdapter"]
    >;
    resetProviderSessionThread: NonNullable<
      SessionRuntimeServiceDeps["resetProviderSessionThread"]
    >;
    endProviderAgentRuntimeTurn?: SessionRuntimeServiceDeps["endProviderAgentRuntimeTurn"];
    /** 親の作業範囲を踏まえた、プロバイダーへ渡す実行時の Session を解決する。 */
    resolveProviderSession(
      session: Session,
      parentSessionId: string,
    ): Session | Promise<Session>;
    /** 親 Main に紐付く SessionFolder のパスを返す。 */
    resolveSessionFolderPath(parentSessionId: string): string;
    resolveCrewFolderPath?: (
      parentSessionId: string,
    ) => string | Promise<string>;
    /** 対象と親の保存済み識別情報を元に、プロバイダー用のツールの紐付けを発行する。 */
    issueRuntimeBinding(
      session: Session,
      provider: ModelCatalogProvider,
      source: AgentRuntimeSourceRef,
    ): Promise<ProviderAgentRuntimeBindingProjection>;
    beginRuntimeTurn?: SessionRuntimeServiceDeps["beginProviderAgentRuntimeTurn"];
  };
  context: {
    getAppSettings: SessionRuntimeServiceDeps["getAppSettings"];
    /** Auxiliary と親の識別情報で、当該 Auxiliary の非公開指示本文を取得する。 */
    readSessionInstructions(
      target: Extract<SessionInstructionsTarget, { kind: "auxiliary" }>,
    ): Promise<string>;
  };
  turn: Pick<
    SessionRuntimeServiceDeps,
    "createSessionTurn" | "updateSessionTurn"
  >;
  live: {
    /** Auxiliary 実行の最新状態を更新し、終端を示す null も受け付ける。 */
    setLiveSessionRun(
      sessionId: string,
      state: LiveSessionRunState | null,
    ): void;
    /** 対象 Auxiliary の現在の実行状態を照会する。 */
    getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
    /** プロバイダー単位の利用枠の観測結果を状態に反映する。 */
    setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
    /** 実行中に取得した会話コンテキストの観測結果を状態に反映する。 */
    setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
    /** 実行後に再取得する利用枠の観測を、指定した遅延で予約する。 */
    scheduleProviderQuotaTelemetryRefresh(
      providerId: string,
      delaysMs: number[],
    ): void;
    /** 変更された Auxiliary の実行状態を、親へ配送する共通経路に渡す。 */
    broadcastLiveSessionRun(sessionId: string): void;
  };
  interaction: {
    waitForApprovalDecision: SessionRuntimeServiceDeps["waitForApprovalDecision"];
    startWithMateApprovalReview?: SessionRuntimeServiceDeps["startWithMateApprovalReview"];
    /** 現在の Auxiliary の質問要求に対する応答を待ち、取消シグナルも受け取る。 */
    waitForElicitationResponse(
      sessionId: string,
      request: LiveElicitationRequest,
      signal: AbortSignal,
    ): Promise<LiveElicitationResponse> | LiveElicitationResponse;
    /** 指定 Auxiliary に残る承認待ちを取り消す。 */
    cancelApprovals(sessionId: string): void;
    /** 指定 Auxiliary に残る質問への応答待ちを取り消す。 */
    cancelElicitations(sessionId: string): void;
    /** 指定したプロバイダーに対応する Auxiliary の旧スレッドを無効化する。 */
    invalidateProviderSessionThread(
      providerId: string | null | undefined,
      sessionId: string,
    ): Promise<void>;
  };
  /** Auxiliary の Turn が終端したことを、親と対象の両方を指定して通知する。 */
  notification(
    notification: Parameters<
      NonNullable<SessionRuntimeServiceDeps["notifySessionTurnTerminal"]>
    >[0],
    target: SessionTurnNotificationTarget,
  ): void | Promise<void>;
  currentTimestampLabel?: () => string;
  getQueuedInputReceipt?: SessionRuntimeServiceDeps["getQueuedInputReceipt"];
  onSessionRunReleased?: SessionRuntimeServiceDeps["onSessionRunReleased"];
};

/** Auxiliary の実行入口と永続化を接続し、対象処理の前後で捕捉した所有世代を照合するランタイムを作る。 */
export function createAuxiliarySessionRuntime(
  deps: AuxiliarySessionRuntimeAssemblyDeps,
): SessionRuntimeService {
  /** Auxiliary のどの操作で所有者の失効を検出したかを、共通の検証処理へ渡す。 */
  const assertOwner = (operation: string): void =>
    deps.owner.assertActive(`Auxiliary session runtime ${operation}`);
  /** 前後で所有者を照合し、非同期処理中に世代が変わった結果を現在のランタイムへ返さない。 */
  const guarded = async <T>(
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> => {
    assertOwner(operation);
    const result = await callback();
    assertOwner(operation);
    return result;
  };
  /** Auxiliary と親を読み、両方の保存済み識別情報を含む実行元を組み立てる。 */
  const resolveSource = async (
    session: Session,
  ): Promise<AgentRuntimeSourceRef> => {
    const auxiliary = await deps.auxiliary.getSession(session.id);
    const parent =
      auxiliary && (await deps.parent.getSession(auxiliary.parentSessionId));
    if (!auxiliary || !parent)
      throw new Error("Auxiliary conversation owner is unavailable.");
    return {
      kind: "auxiliary",
      sessionId: session.id,
      incarnationId: getSessionIncarnationId(session),
      parent: {
        sessionId: parent.id,
        incarnationId: getSessionIncarnationId(parent),
      },
    };
  };

  const runtime: SessionRuntimeServiceDeps = {
    /** 指定 Session の受付を直列化し、排他待ちが終わってから所有世代を照合する。 */
    runSessionAdmissionExclusive: (sessionId, operation, signal) =>
      deps.admission.runSessionAdmissionExclusive(
        sessionId,
        () => guarded("admission", operation),
        signal,
      ),
    /** 共通ランタイムからの Session 読み取りを Auxiliary の実行用投影へ接続する。 */
    getSession: (sessionId) =>
      guarded("session read", () =>
        deps.auxiliary.getRuntimeSession(sessionId),
      ),
    /** 対象の Auxiliary と親の識別を解決し、当該 Auxiliary の指示本文だけを取得する。 */
    readSessionInstructions: (session) =>
      guarded("instructions read", async () => {
        const source = await resolveSource(session);
        // ここで解決する所有者は Auxiliary に限る。Main の指示本文で代用しない。
        if (source.kind !== "auxiliary")
          throw new Error("Auxiliary conversation owner is unavailable.");
        return deps.context.readSessionInstructions({
          kind: "auxiliary",
          sessionId: source.sessionId,
          incarnationId: source.incarnationId,
          mainSessionId: source.parent.sessionId,
          mainIncarnationId: source.parent.incarnationId,
        });
      }),
    /** Auxiliary の実行中に届いた追加入力を、世代を確認したうえで履歴に追記する。 */
    appendRunningInput: (...args) =>
      guarded("Session input append", () =>
        deps.auxiliary.appendRunningInput(...args),
      ),
    beginRunningInput: deps.auxiliary.beginRunningInput
      ? (...args) =>
          guarded("Session input begin", () =>
            deps.auxiliary.beginRunningInput!(...args),
          )
      : undefined,
    settleRunningInput: deps.auxiliary.settleRunningInput
      ? (...args) =>
          guarded("Session input settle", () =>
            deps.auxiliary.settleRunningInput!(...args),
          )
      : undefined,
    /** Auxiliary の応答と終端情報を、その履歴の保存処理へ渡す。 */
    appendTerminalSession: (session, commit, options) =>
      guarded("terminal Session append", () =>
        deps.auxiliary.appendTerminalSession(session, commit, options),
      ),
    beginSourceDisplayTurn: deps.auxiliary.beginSourceDisplayTurn,
    /** 期待していた実行状態を照合する Auxiliary のメタデータ保存を呼ぶ。 */
    checkpointRuntimeMetadata: (session, expected) =>
      guarded("runtime metadata checkpoint", () =>
        deps.auxiliary.checkpointRuntimeMetadata(session, expected),
      ),
    /** 実行の開始記録と想定する履歴件数を、Auxiliary の保存処理へ渡す。 */
    persistRunningTurnStart: (session, expectedMessageCount) =>
      guarded("running turn start", () =>
        deps.auxiliary.persistRunningTurnStart(session, expectedMessageCount),
      ),
    persistQueuedTurnStart: deps.auxiliary.persistQueuedTurnStart
      ? (session, count, queueId, turn) =>
          guarded("queued turn start", () =>
            deps.auxiliary.persistQueuedTurnStart!(
              session,
              count,
              queueId,
              turn,
            ),
          )
      : undefined,
    assertCapturedComposerAttachmentsAvailable: deps.resolution
      .assertCapturedComposerAttachmentsAvailable
      ? (session, attachments) =>
          guarded("captured attachments", () =>
            deps.resolution.assertCapturedComposerAttachmentsAvailable!(
              session,
              attachments,
            ),
          )
      : undefined,
    getQueuedInputReceipt: deps.getQueuedInputReceipt
      ? (receipt) =>
          guarded("queued input receipt", () =>
            deps.getQueuedInputReceipt!(receipt),
          )
      : undefined,
    onSessionRunReleased: deps.onSessionRunReleased,
    /** プロバイダーに送る前の実行時 Session を、現在の Auxiliary 世代で解決する。 */
    resolveRuntimeSessionForTurn: (session) =>
      guarded("runtime session resolution", () =>
        deps.resolution.resolveRuntimeSessionForTurn(session),
      ),
    /** Auxiliary の作業範囲で送信前の本文に含まれる添付を解決する。 */
    resolveComposerPreview: (session, userMessage) =>
      guarded("composer preview", () =>
        deps.resolution.resolveComposerPreview(session, userMessage),
      ),
    assertSavedReplyTo: deps.resolution.assertSavedReplyTo,
    /** 保存済み Auxiliary から親 ID を得て、プロバイダーに渡す作業範囲を解決する。 */
    resolveProviderSession: (session) =>
      guarded("provider session path", async () => {
        const auxiliary = await deps.auxiliary.getSession(session.id);
        return deps.provider.resolveProviderSession(
          session,
          auxiliary?.parentSessionId ?? session.id,
        );
      }),
    /** 保存済みの親を優先し、Auxiliary の実行から使う SessionFolder を求める。 */
    resolveSessionFolderPath: (sessionId) =>
      guarded("session folder path", async () => {
        const auxiliary = await deps.auxiliary.getSession(sessionId);
        return deps.provider.resolveSessionFolderPath(
          auxiliary?.parentSessionId ?? sessionId,
        );
      }),
    resolveCrewFolderPath: deps.provider.resolveCrewFolderPath
      ? (sessionId) =>
          guarded("crew folder path", async () => {
            const auxiliary = await deps.auxiliary.getSession(sessionId);
            return deps.provider.resolveCrewFolderPath!(
              auxiliary?.parentSessionId ?? sessionId,
            );
          })
      : undefined,
    /** 現在の所有世代に属するアプリ設定を取得する。 */
    getAppSettings: () => guarded("settings read", deps.context.getAppSettings),
    /** 要求されたプロバイダーとカタログ指定を、実行用の候補解決へ渡す。 */
    resolveProviderCatalog: (providerId, revision) =>
      guarded("provider catalog", () =>
        deps.resolution.resolveProviderCatalog(providerId, revision),
      ),
    /** 所有世代が有効なときだけ、指定プロバイダーのコーディングアダプターを取得する。 */
    getProviderCodingAdapter: (providerId) => {
      assertOwner("provider coding adapter");
      return deps.provider.getProviderCodingAdapter(providerId);
    },
    /** 保存済みの実行元を解決してから、対象プロバイダーへのツールの紐付けを発行する。 */
    getProviderAgentRuntimeBinding: ({ session, provider }) =>
      guarded("provider runtime binding", async () =>
        deps.provider.issueRuntimeBinding(
          session,
          provider,
          await resolveSource(session),
        ),
      ),
    /** 紐付けと開始処理があるときだけ、捕捉した所有世代でランタイム Turn を開始する。 */
    beginProviderAgentRuntimeTurn: (input) =>
      input.binding && deps.provider.beginRuntimeTurn
        ? guarded("provider runtime turn", () =>
            deps.provider.beginRuntimeTurn!(input),
          )
        : undefined,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    /** 指定 Auxiliary のプロバイダースレッドをリセットする。 */
    resetProviderSessionThread: (providerId, sessionId) =>
      guarded("provider thread reset", () =>
        deps.provider.resetProviderSessionThread!(providerId, sessionId),
      ),
    /** 対象が現在の世代の Auxiliary か、保存先に問い合わせる。 */
    isAuxiliarySession: (sessionId) =>
      guarded("Auxiliary session check", () =>
        deps.auxiliary.isAuxiliarySession(sessionId),
      ),
    /** Auxiliary 実行の Turn 開始記録を、現在の所有世代で作成する。 */
    createSessionTurn: (entry) =>
      guarded("turn create", () => deps.turn.createSessionTurn(entry)),
    /** 指定された保存済み Turn の経過または終端を更新する。 */
    updateSessionTurn: (id, entry) =>
      guarded("turn update", () => deps.turn.updateSessionTurn(id, entry)),
    /** 所有世代を確認して、稼働中の Auxiliary の状態を公開用投影に書き込む。 */
    setLiveSessionRun: (id, state) => {
      assertOwner("live session projection");
      deps.live.setLiveSessionRun(id, state);
    },
    /** 現在の所有世代の稼働状態だけを読み取る。 */
    getLiveSessionRun: (id) => {
      assertOwner("live session read");
      return deps.live.getLiveSessionRun(id);
    },
    waitForApprovalDecision: deps.interaction.waitForApprovalDecision,
    startWithMateApprovalReview: deps.interaction.startWithMateApprovalReview,
    waitForElicitationResponse: deps.interaction.waitForElicitationResponse,
    /** 利用枠の観測値を、失効していないランタイムからだけ反映する。 */
    setProviderQuotaTelemetry: (telemetry) => {
      assertOwner("provider quota projection");
      deps.live.setProviderQuotaTelemetry(telemetry);
    },
    /** Auxiliary の会話コンテキスト観測値を、現在の世代の投影に反映する。 */
    setSessionContextTelemetry: (telemetry) => {
      assertOwner("session context projection");
      deps.live.setSessionContextTelemetry(telemetry);
    },
    /** 対象 Auxiliary のプロバイダースレッドを、現在の所有世代で無効化する。 */
    invalidateProviderSessionThread: (providerId, sessionId) =>
      guarded("provider thread invalidation", () =>
        deps.interaction.invalidateProviderSessionThread(providerId, sessionId),
      ),
    /** 利用枠の再取得を現在の世代のスケジューラーへ渡す。 */
    scheduleProviderQuotaTelemetryRefresh: (id, delays) => {
      assertOwner("provider quota schedule");
      deps.live.scheduleProviderQuotaTelemetryRefresh(id, delays);
    },
    /** 現在の Auxiliary 世代のライブ状態の更新を通知する。 */
    broadcastLiveSessionRun: (id) => {
      assertOwner("live session broadcast");
      deps.live.broadcastLiveSessionRun(id);
    },
    /** 現在の世代の Auxiliary に残る承認待ちを取り消す。 */
    resolvePendingApprovalRequest: (sessionId) => {
      assertOwner("pending approval cancellation");
      deps.interaction.cancelApprovals(sessionId);
    },
    /** 現在の世代の Auxiliary に残る質問への応答待ちを取り消す。 */
    resolvePendingElicitationRequest: (sessionId) => {
      assertOwner("pending elicitation resolution");
      deps.interaction.cancelElicitations(sessionId);
    },
    /** Auxiliary と親がまだ保存されている場合に限り、終端した対象と親を指定して通知する。 */
    notifySessionTurnTerminal: async (notification) =>
      guarded("terminal notification", async () => {
        const auxiliary = await deps.auxiliary.getSession(
          notification.session.id,
        );
        if (
          !auxiliary ||
          !(await deps.parent.getSession(auxiliary.parentSessionId))
        )
          return;
        await deps.notification(notification, {
          kind: "auxiliary",
          parentSessionId: auxiliary.parentSessionId,
          auxiliarySessionId: auxiliary.id,
        });
      }),
    currentTimestampLabel: deps.currentTimestampLabel,
  };
  return new SessionRuntimeService(runtime);
}
