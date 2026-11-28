import type { AuxiliaryLiveRunParents } from "../auxiliary/auxiliary-live-run-parents.js";
import type { SessionRuntimeService } from "./session-runtime-service.js";

/** Main とその Auxiliary の実行識別子を閉じる操作の検証用に集める。既知の実行を識別できない場合は安全に続行できないため拒否する。 */
export function readHomeCrewCloseRunIdentities(
  sessionId: string,
  deps: {
    mainRuntime: Pick<SessionRuntimeService, "getCloseRunIdentity"> | null;
    auxiliaryRuntime: Pick<SessionRuntimeService, "getCloseRunIdentity"> | null;
    directAuxiliaryRuns: ReadonlyMap<string, { parentSessionId: string }>;
    liveAuxiliaryParents: Pick<
      AuxiliaryLiveRunParents,
      "pendingRunIdsForParent"
    >;
  },
): object[] {
  const runs: object[] = [];
  const mainRun = deps.mainRuntime?.getCloseRunIdentity(sessionId);
  if (mainRun) runs.push(mainRun);
  for (const run of deps.directAuxiliaryRuns.values()) {
    // 直接実行された Auxiliary のリクエストは、ドラフトの受付からプロバイダーの実行まで実行権を保持する。
    if (run.parentSessionId === sessionId) runs.push(run);
  }
  for (const id of deps.liveAuxiliaryParents.pendingRunIdsForParent(
    sessionId,
  )) {
    if (deps.directAuxiliaryRuns.has(id)) continue;
    const run = deps.auxiliaryRuntime?.getCloseRunIdentity(id);
    if (!run) throw new Error("Auxiliary run identity is unavailable.");
    runs.push(run);
  }
  return runs;
}
