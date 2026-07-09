import { useEffect } from "react";

import { startOpenCompanionReviewWindowIdsSubscription } from "../open-companion-review-window-subscription.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type UseHomeOpenWindowSubscriptionsInput = {
  getApi: () => WithMateWindowApi | null;
  setOpenSessionWindowIds: (sessionIds: string[]) => void;
  setOpenCompanionReviewWindowIds: (sessionIds: string[]) => void;
};

export function useHomeOpenWindowSubscriptions({
  getApi,
  setOpenSessionWindowIds,
  setOpenCompanionReviewWindowIds,
}: UseHomeOpenWindowSubscriptionsInput): void {
  useEffect(() => {
    let active = true;
    let receivedSubscriptionUpdate = false;
    const api = getApi();

    if (!api) {
      return () => {
        active = false;
      };
    }

    const unsubscribeOpenSessionWindowIds = api.subscribeOpenSessionWindowIds((nextSessionIds) => {
      if (!active) {
        return;
      }

      receivedSubscriptionUpdate = true;
      setOpenSessionWindowIds(nextSessionIds);
    });

    void api.listOpenSessionWindowIds().then((nextSessionIds) => {
      if (!active || receivedSubscriptionUpdate) {
        return;
      }

      setOpenSessionWindowIds(nextSessionIds);
    });

    return () => {
      active = false;
      unsubscribeOpenSessionWindowIds();
    };
  }, [getApi, setOpenSessionWindowIds]);

  useEffect(() => {
    return startOpenCompanionReviewWindowIdsSubscription({
      api: getApi(),
      applyOpenWindowIds: setOpenCompanionReviewWindowIds,
    });
  }, [getApi, setOpenCompanionReviewWindowIds]);
}
