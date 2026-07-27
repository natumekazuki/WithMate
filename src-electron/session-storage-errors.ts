export class SessionIdCollisionError extends Error {
  constructor(readonly sessionId: string) {
    super("同じ ID の Session がすでに存在するよ。");
    this.name = "SessionIdCollisionError";
  }
}
