export type SessionHistorySource = Readonly<{
  sessionId: string;
  incarnationId: string;
  /** ストレージの所有者が持つ既存の会話クエリのスナップショットから取得する。 */
  ownerIdentity: string;
}> & (
  | Readonly<{ kind: "main" }>
  | Readonly<{
      kind: "auxiliary";
      parent: Readonly<{ sessionId: string; incarnationId: string }>;
    }>
);

/** 読み取り権限は、利用側の生成目的や進捗とは独立している。 */
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

/** 対象の履歴データと同じストレージ読み取り境界の中で呼び出す。 */
export function matchesSessionHistorySource(
  source: SessionHistorySource,
  current: { ownerIdentity: string; incarnationId: string } | null,
): boolean {
  return current !== null && current.ownerIdentity === source.ownerIdentity
    && current.incarnationId === source.incarnationId;
}
