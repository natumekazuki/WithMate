import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionPersistenceService } from "../session/session-persistence-service.js";
import type { SessionTurnTerminalCommit } from "../session/session-turn-terminal-commit.js";
import type {
  SessionRuntimeMetadataPatchInput,
  SessionThreadPatchInput,
} from "../session/session-storage-v6.js";
import type {
  SessionRuntimeMetadataPatchResult,
  SessionThreadPatchResult,
} from "../session/session-storage-v6.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  SetExecutionOptionsResult,
  SetSessionTitleResult,
} from "../../src-shared/session/session-mutation-contract.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";

/** Session 一覧の置き換えに伴う通知の有無と、失効させる追加の Session ID。 */
type ReplaceAllSessionsOptions = {
  broadcast?: boolean;
  invalidateSessionIds?: Iterable<string>;
};

/** Main の保存呼び出しを、現在の世代の永続化サービスへ接続する入力。 */
type MainSessionPersistenceFacadeDeps = {
  /** 操作を委譲する時点で有効な Session 永続化サービスを取得する。 */
  getSessionPersistenceService(): SessionPersistenceService;
};

/** Main の Session 書き込みを集約し、保存の確定と失敗判定は永続化サービスに委ねる。 */
export class MainSessionPersistenceFacade {
  /** 保存先を固定せず、呼び出し時に永続化サービスを取得する関数を保持する。 */
  constructor(private readonly deps: MainSessionPersistenceFacadeDeps) {}

  /** Session の保存用スナップショットを挿入または更新し、確定した状態を返す。 */
  async upsertSession(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().upsertSession(session);
  }

  /** 保存対象の incarnation を照合して件名だけを更新し、保存結果をそのまま返す。 */
  async setSessionTitle(
    sessionId: string,
    incarnationId: string,
    title: string,
  ): Promise<SetSessionTitleResult> {
    return this.deps
      .getSessionPersistenceService()
      .setSessionTitle(sessionId, incarnationId, title);
  }

  /** 指定した incarnation の保存済みメッセージに対して、ブックマークの付与または解除を委譲する。 */
  async setSessionMessageBookmark(
    sessionId: string,
    incarnationId: string,
    messageIndex: number,
    isBookmarked: boolean,
  ): Promise<void> {
    await this.deps
      .getSessionPersistenceService()
      .setSessionMessageBookmark(
        sessionId,
        incarnationId,
        messageIndex,
        isBookmarked,
      );
  }

  /** 対象の incarnation と実行設定を永続化サービスに渡し、設定単位の更新結果を返す。 */
  async setSessionExecutionOptions(
    sessionId: string,
    incarnationId: string,
    options: SessionExecutionOptions,
  ): Promise<SetExecutionOptionsResult> {
    return this.deps
      .getSessionPersistenceService()
      .setSessionExecutionOptions(sessionId, incarnationId, options);
  }

  /** 終端の確定情報とともに Session 全体を保存する経路。現在のピン状態は保持する。 */
  async upsertTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .upsertTerminalSession(session, terminalCommit);
  }

  /** 呼び出し元のスナップショットで現在のピン状態を上書きせずに Session を保存する。 */
  async upsertSessionPreservingPin(session: Session): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .upsertSessionPreservingPin(session);
  }

  /** 保存済みのメッセージ数を前提に Turn 開始を保存し、確定した Session を返す。 */
  async persistRunningTurnStart(
    session: Session,
    expectedMessageCount: number,
  ): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .persistRunningTurnStart(session, expectedMessageCount);
  }

  /** キューの入力を Turn 開始とともに確定し、永続化された Turn 記録と Session を返す。 */
  async persistQueuedTurnStart(
    session: Session,
    expectedMessageCount: number,
    queueId: string,
    turn: SessionTurnInput,
  ): Promise<{ session: Session; turn: SessionTurnRecord }> {
    return this.deps
      .getSessionPersistenceService()
      .persistQueuedTurnStart(session, expectedMessageCount, queueId, turn);
  }

  /** 実行中の Turn に追加入力を記録する。既存の履歴全体は置き換えない。 */
  async appendRunningInput(
    ...args: Parameters<SessionPersistenceService["appendRunningInput"]>
  ): Promise<Session> {
    return this.deps.getSessionPersistenceService().appendRunningInput(...args);
  }

  /** 実行中の Turn の追加入力を、配送結果が未確定の状態で保存する。 */
  beginRunningInput(
    ...args: Parameters<SessionPersistenceService["beginRunningInput"]>
  ): Promise<Session> {
    return this.deps.getSessionPersistenceService().beginRunningInput(...args);
  }

  /** Turn とメッセージの識別情報をもとに、保存済み追加入力の配送結果を確定する。 */
  settleRunningInput(
    ...args: Parameters<SessionPersistenceService["settleRunningInput"]>
  ): Promise<Session> {
    return this.deps.getSessionPersistenceService().settleRunningInput(...args);
  }

  /** 履歴全体の更新ではなく、末尾のアシスタント応答を終端情報とともに追記する。 */
  async appendTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .appendTerminalSession(session, terminalCommit);
  }

  /** 実行状態とスレッドが期待値に一致するときだけ、ランタイムのメタデータを保存する。 */
  async checkpointRuntimeMetadata(
    session: Session,
    expected: Session,
  ): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .checkpointRuntimeMetadata(session, expected);
  }

  /** Character 作成用 Session に限り、保存済みのランタイム状態を解除する。 */
  async clearCharacterAuthoringRuntimeState(
    session: Session,
  ): Promise<Session> {
    return this.deps
      .getSessionPersistenceService()
      .clearCharacterAuthoringRuntimeState(session);
  }

  /** 永続化サービスの一括置き換えを呼び、通知指定を引き継いで確定した一覧を返す。 */
  async replaceAllSessions(
    nextSessions: Session[],
    options?: ReplaceAllSessionsOptions,
  ): Promise<Session[]> {
    return this.deps
      .getSessionPersistenceService()
      .replaceAllSessions(nextSessions, options);
  }

  /** 保存先の照合条件付きでスレッドだけを更新し、条件不一致では null を返す。 */
  async updateSessionThreadIfMatches(
    input: SessionThreadPatchInput,
  ): Promise<SessionThreadPatchResult | null> {
    return this.deps
      .getSessionPersistenceService()
      .updateSessionThreadIfMatches(input);
  }

  /** 保存先の照合条件付きでランタイムのメタデータを更新し、条件不一致では null を返す。 */
  async updateSessionRuntimeMetadataIfMatches(
    input: SessionRuntimeMetadataPatchInput,
  ): Promise<SessionRuntimeMetadataPatchResult | null> {
    return this.deps
      .getSessionPersistenceService()
      .updateSessionRuntimeMetadataIfMatches(input);
  }
}
