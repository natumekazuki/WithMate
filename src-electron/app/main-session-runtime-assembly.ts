import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { MainSessionTarget } from "../../src-shared/session/session-target.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../session/session-runtime-service.js";

/** ランタイムが新しい Turn 記録を作る際に渡す入力。 */
type CreateSessionTurnInput = Parameters<
  NonNullable<SessionRuntimeServiceDeps["createSessionTurn"]>
>[0];

/** Main のストア所有者と、Session ランタイムへ配線する機能別の依存。 */
export type MainSessionRuntimeAssemblyDeps = {
  owner: {
    /** このランタイムの所有者が操作可能でなければ拒否する。 */
    assertActive(operation: string): void;
    /** 通知を受け取れる現行の所有者かを、副作用なしで調べる。 */
    isActive(): boolean;
  };
  admission: Required<
    Pick<SessionRuntimeServiceDeps, "runSessionAdmissionExclusive">
  >;
  sessions: Required<
    Pick<
      SessionRuntimeServiceDeps,
      | "getSession"
      | "persistRunningTurnStart"
      | "clearCharacterAuthoringRuntimeState"
      | "appendRunningInput"
      | "appendTerminalSession"
      | "checkpointRuntimeMetadata"
    >
  > &
    Pick<
      SessionRuntimeServiceDeps,
      | "persistQueuedTurnStart"
      | "getQueuedInputReceipt"
      | "beginRunningInput"
      | "settleRunningInput"
      | "beginSourceDisplayTurn"
    >;
  resolution: Pick<
    SessionRuntimeServiceDeps,
    | "resolveRuntimeSessionForTurn"
    | "resolveComposerPreview"
    | "resolveProviderSession"
    | "resolveSessionFolderPath"
    | "resolveProviderCatalog"
  > & {
    resolveRuntimeSessionForTurn: NonNullable<
      SessionRuntimeServiceDeps["resolveRuntimeSessionForTurn"]
    >;
    resolveComposerPreview: SessionRuntimeServiceDeps["resolveComposerPreview"];
    resolveProviderSession: NonNullable<
      SessionRuntimeServiceDeps["resolveProviderSession"]
    >;
    resolveSessionFolderPath: NonNullable<
      SessionRuntimeServiceDeps["resolveSessionFolderPath"]
    >;
    resolveCrewFolderPath?: SessionRuntimeServiceDeps["resolveCrewFolderPath"];
    resolveProviderCatalog: SessionRuntimeServiceDeps["resolveProviderCatalog"];
    assertCapturedComposerAttachmentsAvailable?: SessionRuntimeServiceDeps["assertCapturedComposerAttachmentsAvailable"];
  };
  provider: Pick<
    SessionRuntimeServiceDeps,
    | "getProviderCodingAdapter"
    | "resetProviderSessionThread"
    | "getProviderAgentRuntimeBinding"
    | "beginProviderAgentRuntimeTurn"
    | "endProviderAgentRuntimeTurn"
  >;
  context: {
    getAppSettings: SessionRuntimeServiceDeps["getAppSettings"];
    /** Session ID と世代が一致する Main Session の指示本文を取得する。 */
    readSessionInstructions(target: MainSessionTarget): Promise<string>;
    assertSavedReplyTo?: SessionRuntimeServiceDeps["assertSavedReplyTo"];
    readMainMessageThread?: SessionRuntimeServiceDeps["readMainMessageThread"];
  };
  turn: Pick<
    SessionRuntimeServiceDeps,
    "createSessionTurn" | "updateSessionTurn"
  >;
  live: Pick<
    SessionRuntimeServiceDeps,
    | "setLiveSessionRun"
    | "getLiveSessionRun"
    | "setProviderQuotaTelemetry"
    | "setSessionContextTelemetry"
    | "scheduleProviderQuotaTelemetryRefresh"
    | "broadcastLiveSessionRun"
  >;
  interaction: Pick<
    SessionRuntimeServiceDeps,
    | "waitForApprovalDecision"
    | "startWithMateApprovalReview"
    | "waitForElicitationResponse"
    | "resolvePendingApprovalRequest"
    | "resolvePendingElicitationRequest"
    | "invalidateProviderSessionThread"
  >;
  notification: Pick<
    SessionRuntimeServiceDeps,
    "notifySessionTurnTerminal" | "onSessionRunReleased" | "onSentInputChanged"
  >;
  timing: {
    currentTimestampLabel?: () => string;
  };
};

/** 所有者のガードと業務処理のコールバックを組み合わせ、Main プロセスのランタイムを作る。 */
export function createMainSessionRuntime(
  deps: MainSessionRuntimeAssemblyDeps,
): SessionRuntimeService {
  /** 操作名を添えて、依存の所有者がまだ有効であることを確認する。 */
  const assertOwner = (operation: string): void =>
    deps.owner.assertActive(`Session runtime ${operation}`);
  /** 処理の前と正常終了後に所有者を照合し、古い世代の結果を返さない。 */
  const guarded = async <T>(
    operation: string,
    callback: () => T | Promise<T>,
  ): Promise<T> => {
    assertOwner(operation);
    const result = await callback();
    assertOwner(operation);
    return result;
  };

  const assembled: SessionRuntimeServiceDeps = {
    /** Session 単位で受付を直列化し、排他区間の前後で所有者を確認する。 */
    runSessionAdmissionExclusive: (sessionId, operation, signal) =>
      deps.admission.runSessionAdmissionExclusive(
        sessionId,
        () => guarded("admission", operation),
        signal,
      ),
    /** 現行の所有者から Session を読み取る。 */
    getSession: (sessionId) => {
      assertOwner("session read");
      return deps.sessions.getSession(sessionId);
    },
    /** Session の世代を含む宛先を作り、指示本文を読む。 */
    readSessionInstructions: (session) =>
      guarded("instructions read", () =>
        deps.context.readSessionInstructions({
          kind: "main",
          sessionId: session.id,
          incarnationId: getSessionIncarnationId(session),
        }),
      ),
    /** 実行中 Turn に受け付けた追加入力を履歴に保存する。 */
    appendRunningInput: (...args) =>
      guarded("Session input append", () =>
        deps.sessions.appendRunningInput(...args),
      ),
    beginRunningInput: deps.sessions.beginRunningInput
      ? (...args) =>
          guarded("Session input begin", () =>
            deps.sessions.beginRunningInput!(...args),
          )
      : undefined,
    settleRunningInput: deps.sessions.settleRunningInput
      ? (...args) =>
          guarded("Session input settle", () =>
            deps.sessions.settleRunningInput!(...args),
          )
      : undefined,
    getQueuedInputReceipt: deps.sessions.getQueuedInputReceipt
      ? (receipt) =>
          guarded("queued input receipt", () =>
            deps.sessions.getQueuedInputReceipt!(receipt),
          )
      : undefined,
    /** 終了時の更新内容を Session の永続履歴に反映する。 */
    appendTerminalSession: (session, commit, options) =>
      guarded("terminal Session append", () =>
        deps.sessions.appendTerminalSession(session, commit, options),
      ),
    beginSourceDisplayTurn: deps.sessions.beginSourceDisplayTurn,
    /** 想定する保存状態と照合しながら実行メタデータを保存する。 */
    checkpointRuntimeMetadata: (session, expected) =>
      guarded("runtime metadata checkpoint", () =>
        deps.sessions.checkpointRuntimeMetadata(session, expected),
      ),
    /** 実行開始時の Session 状態と基準メッセージ数を保存処理へ渡す。 */
    persistRunningTurnStart: (session, count) =>
      guarded("running turn start", () =>
        deps.sessions.persistRunningTurnStart(session, count),
      ),
    persistQueuedTurnStart: deps.sessions.persistQueuedTurnStart
      ? (session, count, queueId, turn) =>
          guarded("queued turn start", () =>
            deps.sessions.persistQueuedTurnStart!(
              session,
              count,
              queueId,
              turn,
            ),
          )
      : undefined,
    /** Character 作成支援に紐づく実行時状態を消去する。 */
    clearCharacterAuthoringRuntimeState: (session) =>
      guarded("authoring runtime clear", () =>
        deps.sessions.clearCharacterAuthoringRuntimeState(session),
      ),
    /** 現在の選択を含む、Turn 実行に使用する Session を解決する。 */
    resolveRuntimeSessionForTurn: (session) =>
      guarded("runtime session resolution", () =>
        deps.resolution.resolveRuntimeSessionForTurn(session),
      ),
    /** Session を基準に、送信本文の添付参照を解決する。 */
    resolveComposerPreview: (session, message) =>
      guarded("composer preview", () =>
        deps.resolution.resolveComposerPreview(session, message),
      ),
    assertSavedReplyTo: deps.context.assertSavedReplyTo,
    readMainMessageThread: deps.context.readMainMessageThread,
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
    /** Session が実行を継続する Provider 側のセッション情報を解決する。 */
    resolveProviderSession: (session) =>
      guarded("provider session path", () =>
        deps.resolution.resolveProviderSession(session),
      ),
    /** Session ID に対応するファイルのルートを解決する。 */
    resolveSessionFolderPath: (id) =>
      guarded("session folder path", () =>
        deps.resolution.resolveSessionFolderPath(id),
      ),
    resolveCrewFolderPath: deps.resolution.resolveCrewFolderPath
      ? (id) =>
          guarded("crew folder path", () =>
            deps.resolution.resolveCrewFolderPath!(id),
          )
      : undefined,
    /** 現行の所有者からアプリ設定を取得する。 */
    getAppSettings: () => guarded("settings read", deps.context.getAppSettings),
    /** Provider と設定の版に対応するモデルカタログを解決する。 */
    resolveProviderCatalog: (providerId, revision) =>
      guarded("provider catalog", () =>
        deps.resolution.resolveProviderCatalog(providerId, revision),
      ),
    getProviderCodingAdapter: deps.provider.getProviderCodingAdapter,
    resetProviderSessionThread: deps.provider.resetProviderSessionThread,
    getProviderAgentRuntimeBinding:
      deps.provider.getProviderAgentRuntimeBinding,
    beginProviderAgentRuntimeTurn: deps.provider.beginProviderAgentRuntimeTurn,
    endProviderAgentRuntimeTurn: deps.provider.endProviderAgentRuntimeTurn,
    /** 開始する Turn の記録を永続化する。 */
    createSessionTurn: (entry: CreateSessionTurnInput) =>
      guarded("turn create", () => deps.turn.createSessionTurn(entry)),
    /** 既存 Turn の記録を指定 ID で更新する。 */
    updateSessionTurn: (id, entry) =>
      guarded("turn update", () => deps.turn.updateSessionTurn(id, entry)),
    /** 現行の所有者に実行中状態を反映する。 */
    setLiveSessionRun: (id, state) => {
      assertOwner("live session projection");
      deps.live.setLiveSessionRun(id, state);
    },
    /** 現行の所有者から実行中状態を読む。 */
    getLiveSessionRun: (id) => {
      assertOwner("live session read");
      return deps.live.getLiveSessionRun(id);
    },
    waitForApprovalDecision: deps.interaction.waitForApprovalDecision,
    startWithMateApprovalReview: deps.interaction.startWithMateApprovalReview,
    waitForElicitationResponse: deps.interaction.waitForElicitationResponse,
    /** 現行の所有者に Provider の利用枠を反映する。 */
    setProviderQuotaTelemetry: (telemetry) => {
      assertOwner("provider quota projection");
      deps.live.setProviderQuotaTelemetry(telemetry);
    },
    /** 現行の所有者に Session のコンテキスト使用量を反映する。 */
    setSessionContextTelemetry: (telemetry) => {
      assertOwner("session context projection");
      deps.live.setSessionContextTelemetry(telemetry);
    },
    /** 指定 Session の Provider スレッドを無効化する。 */
    invalidateProviderSessionThread: (providerId, sessionId) =>
      guarded("provider thread invalidation", () =>
        deps.interaction.invalidateProviderSessionThread(providerId, sessionId),
      ),
    /** 現行の所有者で Provider 利用枠の再取得を予約する。 */
    scheduleProviderQuotaTelemetryRefresh: (id, delays) => {
      assertOwner("provider quota schedule");
      deps.live.scheduleProviderQuotaTelemetryRefresh(id, delays);
    },
    /** 現行の所有者から Session の実行中状態を配信する。 */
    broadcastLiveSessionRun: (id) => {
      assertOwner("live session broadcast");
      deps.live.broadcastLiveSessionRun(id);
    },
    resolvePendingApprovalRequest:
      deps.interaction.resolvePendingApprovalRequest,
    resolvePendingElicitationRequest:
      deps.interaction.resolvePendingElicitationRequest,
    notifySessionTurnTerminal: deps.notification.notifySessionTurnTerminal,
    /** 送信元に表示する入力の変更を、所有者が有効な間だけ通知する。 */
    onSentInputChanged: (origin) => {
      if (deps.owner.isActive()) deps.notification.onSentInputChanged?.(origin);
    },
    /** 実行枠が解放されたことを、所有者が有効な間だけ通知する。 */
    onSessionRunReleased: (sessionId) => {
      if (deps.owner.isActive())
        deps.notification.onSessionRunReleased?.(sessionId);
    },
    currentTimestampLabel: deps.timing.currentTimestampLabel,
  };
  return new SessionRuntimeService(assembled);
}
