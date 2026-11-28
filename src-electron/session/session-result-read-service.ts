import type { UnreadSessionResult } from "../../src-shared/session/session-turn-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

/** 各 Session の最新の終了結果をメモリで追い、一致する Turn に対する既読だけを受け付ける。 */
export class SessionResultReadService {
  private readonly results = new Map<
    string,
    { result: UnreadSessionResult; unread: boolean }
  >();

  /** 新しい結果と既読による変化を通知するため、Session ID を受け取る処理を設定する。 */
  constructor(private readonly onChanged: (sessionId: string) => void) {}

  /** より新しい Turn の終了だけを未読として記録し、対象 Session の変化を知らせる。 */
  recordResult(commit: SessionTurnTerminalCommit): void {
    if (
      (this.results.get(commit.sessionId)?.result.turnId ?? 0) >= commit.turnId
    )
      return;
    this.results.set(commit.sessionId, {
      result: {
        turnId: commit.turnId,
        assistantMessageSeq: commit.assistantMessageSeq,
      },
      unread: true,
    });
    this.onChanged(commit.sessionId);
  }

  /** 現在の結果が未読ならコピーを返し、結果がない場合や既読の場合は null を返す。 */
  getUnreadResult(sessionId: string): UnreadSessionResult | null {
    const entry = this.results.get(sessionId);
    return entry?.unread ? { ...entry.result } : null;
  }

  /** 指定 Turn が現在の未読結果と一致する場合だけ既読にし、一覧へ変化を通知する。 */
  markRead(sessionId: string, turnId: number): boolean {
    const entry = this.results.get(sessionId);
    if (!entry?.unread || entry.result.turnId !== turnId) return false;
    entry.unread = false;
    this.onChanged(sessionId);
    return true;
  }

  /** すべての追跡情報を、個別の変更通知を送らずに破棄する。 */
  clear(): void {
    this.results.clear();
  }
}
