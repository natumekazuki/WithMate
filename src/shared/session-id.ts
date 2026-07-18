const ISSUED_SESSION_ID_PATTERN = /^session_[0-9a-f]{96}$/;

export function isIssuedSessionId(value: unknown): value is string {
  return typeof value === "string" && ISSUED_SESSION_ID_PATTERN.test(value);
}
