import type { LiveSessionRunState, MessageOperation } from "./runtime-state.js";

export function buildLiveRunMessageOperations(state: Pick<LiveSessionRunState, "steps">): MessageOperation[] {
  return state.steps.map((step) => ({ ...step }));
}
