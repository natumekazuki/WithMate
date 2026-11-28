import {
  getSessionIncarnationId,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import { normalizeSessionRelationship } from "../../src-shared/session/session-role.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionFileExplorerContext } from "./session-file-explorer-service.js";

/** ファイル操作の対象を決めるための保存情報の参照と、参照中の世代確認。 */
type SessionFileExplorerContextReads = {
  /** 参照を開始した保存領域の世代がまだ有効かを確認する。 */
  assertCurrent(): void;
  /** 補助セッションなら親を返し、該当する補助情報がなければnullを返す。 */
  getAuxiliaryMetadata(
    sessionId: string,
  ): Promise<Pick<AuxiliarySessionSummary, "parentSessionId"> | null>;
  /** ファイルの許可情報を持つ通常セッションを取得する。 */
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
};

/** 補助セッションでは親の作業場所と許可を使い、非同期参照ごとに保存領域の世代を確認する。 */
export async function readSessionFileExplorerContext(
  sessionId: string,
  reads: SessionFileExplorerContextReads,
): Promise<SessionFileExplorerContext | null> {
  reads.assertCurrent();
  const auxiliary = await reads.getAuxiliaryMetadata(sessionId);
  reads.assertCurrent();
  const session = await reads.getSessionSummary(
    auxiliary?.parentSessionId ?? sessionId,
  );
  reads.assertCurrent();
  if (!session) return null;
  return {
    workspacePath: session.workspacePath,
    parentSessionId: session.id,
    parentIncarnationId: getSessionIncarnationId(session),
    crewRootSessionId: normalizeSessionRelationship(session).rootSessionId,
    allowedAdditionalDirectories: session.allowedAdditionalDirectories,
  };
}
