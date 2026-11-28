import { useEffect } from "react";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
} from "../app/open-session-window-subscription.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** Home の表示条件と、開いている Session の一覧を読み書きする接続先。 */
type UseHomeOpenWindowSubscriptionsInput = {
  enabled?: boolean;
  getApi: () => WithMateWindowApi | null;
  setOpenSessionWindowIdsState: (state: OpenSessionWindowIdsState) => void;
};

/** 機能が有効な間だけ既存の Window 一覧購読を保持し、取得状態を Home へ渡す。 */
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
