import { useEffect } from "react";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
} from "../app/open-session-window-subscription.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

type UseHomeOpenWindowSubscriptionsInput = {
  enabled?: boolean;
  getApi: () => WithMateWindowApi | null;
  setOpenSessionWindowIdsState: (state: OpenSessionWindowIdsState) => void;
};

export function useHomeOpenWindowSubscriptions({
  enabled = true,
  getApi,
  setOpenSessionWindowIdsState,
}: UseHomeOpenWindowSubscriptionsInput): void {
  useEffect(() => {
    if (!enabled) return;
    return startOpenSessionWindowIdsSubscription({
      api: getApi(),
      applyState: setOpenSessionWindowIdsState,
    });
  }, [enabled, getApi, setOpenSessionWindowIdsState]);

}
