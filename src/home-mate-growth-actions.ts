import type { MateGrowthApplyResult } from "./mate-growth-apply-result.js";
import type { WithMateWindowMateApi } from "./withmate-window-api.js";
import { buildApplyPendingGrowthFeedback } from "./mate-growth-feedback.js";

export type HomeMateGrowthApplyApi = Pick<WithMateWindowMateApi, "applyPendingGrowth">;

export async function applyHomePendingGrowth(api: HomeMateGrowthApplyApi): Promise<string> {
  const result: MateGrowthApplyResult = await api.applyPendingGrowth();
  return buildApplyPendingGrowthFeedback(result);
}
