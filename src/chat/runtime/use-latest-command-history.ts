import { useEffect, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { MessageArtifact } from "../../../src-shared/session/session-state.js";
import { useLatestSessionTurn, type LatestSessionTurnApi } from "./use-latest-session-turn.js";

export type LatestCommandHistoryApi = LatestSessionTurnApi & Pick<WithMateWindowApi, "getSessionMessageArtifact">;

export function useLatestCommandHistory(input: {
  api: LatestCommandHistoryApi | null;
  sessionId: string | null;
  scope: string | null;
  revision?: string;
  enabled: boolean;
  hasLiveRun: boolean;
}) {
  const latest = useLatestSessionTurn(input.enabled ? input.api : null, input.sessionId, input.scope, input.revision);
  const turn = latest.turn;
  const key = !turn || turn.phase === "running" || turn.assistantMessageSeq === undefined ? null
    : `${latest.key}:${turn.id}:${turn.assistantMessageSeq}`;
  const [state, setState] = useState<{ key: string; artifact: MessageArtifact | null; loading: boolean; error: string | null } | null>(null);
  useEffect(() => {
    if (!key) { setState(null); return; }
    if (!input.enabled || !input.api || !turn || turn.assistantMessageSeq === undefined || latest.loading || latest.error) return;
    let active = true;
    setState((previous) => ({ key, artifact: previous?.key === key ? previous.artifact : null, loading: true, error: null }));
    void input.api.getSessionMessageArtifact(turn.sessionId, turn.assistantMessageSeq).then((artifact) => {
      if (active) setState({ key, artifact, loading: false, error: null });
    }).catch((error: unknown) => {
      if (active) setState((previous) => ({ key, artifact: previous?.key === key ? previous.artifact : null, loading: false, error: error instanceof Error ? error.message : "Could not load command history." }));
    });
    return () => { active = false; };
  }, [input.api, input.enabled, key, latest.loading, latest.error, latest.revision]);
  const artifact = state?.key === key ? state : null;
  return {
    onRetryCommandHistory: latest.retry,
    operations: input.hasLiveRun ? [] : artifact?.artifact?.operationTimeline ?? [],
    commandHistoryLoading: !input.hasLiveRun && !latest.error && (latest.loading || !!key && (!artifact || artifact.loading)),
    commandHistoryError: latest.error ?? artifact?.error,
    commandHistoryUnrecorded: !input.hasLiveRun && !!turn && !latest.loading && !latest.error && !artifact?.loading && !artifact?.error
      && ((!key && turn.phase !== "running") || !!artifact && artifact.artifact?.operationTimeline === undefined),
  };
}
