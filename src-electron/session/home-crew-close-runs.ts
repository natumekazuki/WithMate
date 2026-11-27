import type { AuxiliaryLiveRunParents } from "../auxiliary/auxiliary-live-run-parents.js";
import type { SessionRuntimeService } from "./session-runtime-service.js";

export function readHomeCrewCloseRunIdentities(sessionId: string, deps: {
  mainRuntime: Pick<SessionRuntimeService, "getCloseRunIdentity"> | null;
  auxiliaryRuntime: Pick<SessionRuntimeService, "getCloseRunIdentity"> | null;
  directAuxiliaryRuns: ReadonlyMap<string, { parentSessionId: string }>;
  liveAuxiliaryParents: Pick<AuxiliaryLiveRunParents, "pendingRunIdsForParent">;
}): object[] {
  const runs: object[] = [];
  const mainRun = deps.mainRuntime?.getCloseRunIdentity(sessionId);
  if (mainRun) runs.push(mainRun);
  for (const run of deps.directAuxiliaryRuns.values()) {
    // The direct Auxiliary request owns its claim across draft admission and provider execution.
    if (run.parentSessionId === sessionId) runs.push(run);
  }
  for (const id of deps.liveAuxiliaryParents.pendingRunIdsForParent(sessionId)) {
    if (deps.directAuxiliaryRuns.has(id)) continue;
    const run = deps.auxiliaryRuntime?.getCloseRunIdentity(id);
    if (!run) throw new Error("Auxiliary run identity is unavailable.");
    runs.push(run);
  }
  return runs;
}
