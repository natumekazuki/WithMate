export class SessionIdCollisionError extends Error {
  constructor(readonly sessionId: string) {
    super("A Session with the same ID already exists.");
    this.name = "SessionIdCollisionError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super("The session could not be found.");
    this.name = "SessionNotFoundError";
  }
}

export class SessionRunningTurnStartConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedMessageCount: number,
    readonly actualMessageCount: number,
  ) {
    super("The Session message sequence changed, so the turn cannot start.");
    this.name = "SessionRunningTurnStartConflictError";
  }
}
