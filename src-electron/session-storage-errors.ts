export class SessionIdCollisionError extends Error {
  constructor(readonly sessionId: string) {
    super("同じ ID の Session がすでに存在するよ。");
    this.name = "SessionIdCollisionError";
  }
}

export class SessionRunningTurnStartConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedMessageCount: number,
    readonly actualMessageCount: number,
  ) {
    super("Session の message sequence が更新されているため、turn を開始できないよ。");
    this.name = "SessionRunningTurnStartConflictError";
  }
}
