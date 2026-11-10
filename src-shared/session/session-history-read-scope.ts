export type SessionHistorySource = Readonly<{
  sessionId: string;
  incarnationId: string;
  /** Captured from the storage owner's existing conversation-query snapshot. */
  ownerIdentity: string;
}> & (
  | Readonly<{ kind: "main" }>
  | Readonly<{
      kind: "auxiliary";
      parent: Readonly<{ sessionId: string; incarnationId: string }>;
    }>
);

/** Read authority, independent of the consumer's generation purpose or progress. */
export type SessionHistoryReadScope = Readonly<{
  source: SessionHistorySource;
  fromMessageSeq: number;
  throughMessageSeq: number;
}>;

export function assertSessionHistoryReadScope(scope: SessionHistoryReadScope): void {
  const source = scope.source;
  if (!source.sessionId.trim() || !source.incarnationId.trim() || !source.ownerIdentity.trim()
    || (source.kind === "auxiliary" && (!source.parent.sessionId.trim() || !source.parent.incarnationId.trim()))
    || !Number.isSafeInteger(scope.fromMessageSeq) || scope.fromMessageSeq < 0
    || !Number.isSafeInteger(scope.throughMessageSeq) || scope.throughMessageSeq < scope.fromMessageSeq) {
    throw new Error("Session history requires a captured source and valid message sequence range.");
  }
}

/** Call inside the same storage read boundary as the requested history data. */
export function matchesSessionHistorySource(
  source: SessionHistorySource,
  current: { ownerIdentity: string; incarnationId: string } | null,
): boolean {
  return current !== null && current.ownerIdentity === source.ownerIdentity
    && current.incarnationId === source.incarnationId;
}
