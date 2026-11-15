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

export class SessionCrewDeletionBlockedError extends Error {
  constructor(message: string) { super(message); this.name = "SessionCrewDeletionBlockedError"; }
}

export class ChildSessionCreationRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "ChildSessionCreationRejectedError"; }
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
