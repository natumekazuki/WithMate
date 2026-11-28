import type { LiveSessionRunState, MessageOperation } from "./runtime-state.js";

/** 実行中のステップを表示用に写し、各要素の最上位フィールドを元から切り離す。 */
export function buildLiveRunMessageOperations(
  state: Pick<LiveSessionRunState, "steps">,
): MessageOperation[] {
  return state.steps.map((step) => ({ ...step }));
}
