import { useEffect } from "react";

import { startOpenCompanionReviewWindowIdsSubscription } from "../open-companion-review-window-subscription.js";
import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
} from "../open-session-window-subscription.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type UseHomeOpenWindowSubscriptionsInput = {
  getApi: () => WithMateWindowApi | null;
  setOpenSessionWindowIdsState: (state: OpenSessionWindowIdsState) => void;
  setOpenCompanionReviewWindowIds: (sessionIds: string[]) => void;
};

export function useHomeOpenWindowSubscriptions({
  getApi,
  setOpenSessionWindowIdsState,
  setOpenCompanionReviewWindowIds,
}: UseHomeOpenWindowSubscriptionsInput): void {
  useEffect(() => {
    return startOpenSessionWindowIdsSubscription({
      api: getApi(),
      applyState: setOpenSessionWindowIdsState,
    });
  }, [getApi, setOpenSessionWindowIdsState]);

  useEffect(() => {
    return startOpenCompanionReviewWindowIdsSubscription({
      api: getApi(),
      applyOpenWindowIds: setOpenCompanionReviewWindowIds,
    });
  }, [getApi, setOpenCompanionReviewWindowIds]);
}
