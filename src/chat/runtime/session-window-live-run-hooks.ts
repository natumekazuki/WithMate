import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";
import {
  getSessionLiveRevision,
  projectSessionRunControls,
  subscribeSessionLiveSelection,
  subscribeSessionRunControls,
  updateSessionLiveState,
} from "./session-window-live-ingress.js";

/** 詳細を表示する間だけ実行情報を購読し、対象切替後に以前のセッションの情報を返さない。 */
export function useActiveSessionLiveRun(
  api: WithMateWindowApi | null,
  selectedSession: Session | null,
  activeRunSessionId: string | null,
  enabled = true,
) {
  const [owned, setOwned] = useState<OwnedLiveSessionRunState>({
    ownerSessionId: null,
    state: null,
  });
  const id = enabled && selectedSession ? activeRunSessionId : null;
  useEffect(() => {
    if (!api || !id) {
      setOwned({ ownerSessionId: null, state: null });
      return;
    }
    return subscribeSessionLiveSelection({
      api,
      sessionId: id,
      /** 表示機能には実行情報の全体を渡す。 */
      select: (state) => state,
      /** 受信時の購読対象を添えて、後続の表示で所有者を照合できるようにする。 */
      onChange: (state) => setOwned({ ownerSessionId: id, state }),
    });
  }, [api, id]);
  return {
    selectedSessionLiveRun:
      id && owned.ownerSessionId === id ? owned.state : null,
  };
}

/** 詳細購読を必要としない操作部向けの実行投影。 */
type RunControls = ReturnType<typeof projectSessionRunControls>;
/** 対象ごとの操作情報を購読し、以前の対象の操作を表示しない。 */
function useOwnerControls(
  api: WithMateWindowApi | null,
  id: string | null,
): RunControls {
  const [owned, setOwned] = useState<{
    id: string | null;
    controls: RunControls;
  }>({ id: null, controls: projectSessionRunControls(null) });
  useEffect(() => {
    if (!api || !id) {
      setOwned({ id: null, controls: projectSessionRunControls(null) });
      return;
    }
    return subscribeSessionRunControls({
      api,
      sessionId: id,
      /** 受信した操作情報を購読元のセッションIDと結び付ける。 */
      onChange: (controls) => setOwned({ id, controls }),
    });
  }, [api, id]);
  return owned.id === id ? owned.controls : projectSessionRunControls(null);
}

/** シェルが保持するのは Main と現在の対象の簡易操作情報で、詳細全体は持たない。 */
export function useSessionRunControls(
  api: WithMateWindowApi | null,
  selectedSession: Session | null,
  activeRunSessionId: string | null,
) {
  const active = useOwnerControls(
    api,
    selectedSession ? activeRunSessionId : null,
  );
  const main = useOwnerControls(api, selectedSession?.id ?? null);
  const getLiveRunRevision = useCallback(
    () =>
      api && activeRunSessionId
        ? getSessionLiveRevision(api, activeRunSessionId)
        : 0,
    [api, activeRunSessionId],
  );
  const setLiveRunState = useCallback(
    (update: SetStateAction<OwnedLiveSessionRunState>) => {
      if (api && activeRunSessionId)
        updateSessionLiveState(api, activeRunSessionId, update);
    },
    [api, activeRunSessionId],
  );
  return {
    ...active,
    getLiveRunRevision,
    setLiveRunState,
    hasSelectedSessionLiveRun: main.hasLiveRun,
    selectedSessionCancellationState: main.cancellationState,
    mainStopTurnId: main.stopTurnId,
    mainStopReceiptId: main.stopReceiptId,
    mainStopIncarnationId: main.stopIncarnationId,
  };
}
