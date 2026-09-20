import { useEffect } from "react";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
} from "../open-session-window-subscription.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type UseHomeOpenWindowSubscriptionsInput = {
  getApi: () => WithMateWindowApi | null;
  setOpenSessionWindowIdsState: (state: OpenSessionWindowIdsState) => void;
};

export function useHomeOpenWindowSubscriptions({
  getApi,
  setOpenSessionWindowIdsState,
}: UseHomeOpenWindowSubscriptionsInput): void {
  useEffect(() => {
    return startOpenSessionWindowIdsSubscription({
      api: getApi(),
      applyState: setOpenSessionWindowIdsState,
    });
  }, [getApi, setOpenSessionWindowIdsState]);

}
