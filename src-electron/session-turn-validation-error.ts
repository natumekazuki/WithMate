export class SessionTurnValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionTurnValidationError";
  }
}
