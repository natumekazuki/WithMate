/** 指定された ID が使用済みのため新規 Session を作成できないことを表す。 */
export class SessionIdCollisionError extends Error {
  /** 衝突した ID を保持し、別の保存例外と区別できる名前を付ける。 */
  constructor(readonly sessionId: string) {
    super("A Session with the same ID already exists.");
    this.name = "SessionIdCollisionError";
  }
}

/** 保存処理の対象となる Session が見つからないことを表す。 */
export class SessionNotFoundError extends Error {
  /** 見つからなかった Session の ID を、処理側で特定できるよう保持する。 */
  constructor(readonly sessionId: string) {
    super("The session could not be found.");
    this.name = "SessionNotFoundError";
  }
}

/** Crew の削除を許可できない条件が検出されたことを表す。 */
export class SessionCrewDeletionBlockedError extends Error {
  /** 削除を止めた条件の説明を、そのままエラーメッセージにする。 */
  constructor(message: string) {
    super(message);
    this.name = "SessionCrewDeletionBlockedError";
  }
}

/** 子 Session の作成要求が初期化の完了前に拒否されたことを表す。 */
export class ChildSessionCreationRejectedError extends Error {
  /** 拒否した作成条件の説明を保持し、その他の保存失敗と区別できるようにする。 */
  constructor(message: string) {
    super(message);
    this.name = "ChildSessionCreationRejectedError";
  }
}

/** メッセージ列が読み取り時から変わり、想定した位置では Turn を開始できない競合。 */
export class SessionRunningTurnStartConflictError extends Error {
  /** 対象 Session と、想定していた件数・保存されていた実際の件数を保持する。 */
  constructor(
    readonly sessionId: string,
    readonly expectedMessageCount: number,
    readonly actualMessageCount: number,
  ) {
    super("The Session message sequence changed, so the turn cannot start.");
    this.name = "SessionRunningTurnStartConflictError";
  }
}
