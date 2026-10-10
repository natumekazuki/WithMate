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
  const key = turn?.assistantMessageSeq === undefined ? null
    : `${input.scope}:${turn.sessionId}:${turn.id}:${turn.assistantMessageSeq}:${turn.updatedAt ?? turn.phase}:${latest.revision}`;
  const [state, setState] = useState<{ key: string; artifact: MessageArtifact | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!input.enabled || !input.api || !key || !turn || turn.assistantMessageSeq === undefined) return;
    let active = true;
    setState(null);
    void input.api.getSessionMessageArtifact(turn.sessionId, turn.assistantMessageSeq).then((artifact) => {
      if (active) setState({ key, artifact, error: null });
    }).catch((error: unknown) => {
      if (active) setState({ key, artifact: null, error: error instanceof Error ? error.message : "Could not load command history." });
    });
    return () => { active = false; };
  }, [input.api, input.enabled, key]);
  const artifact = state?.key === key ? state : null;
  return {
    onRetryCommandHistory: latest.retry,
    operations: input.hasLiveRun ? [] : artifact?.artifact?.operationTimeline ?? [],
    commandHistoryLoading: !input.hasLiveRun && (latest.loading || !!key && !artifact),
    commandHistoryError: latest.error ?? artifact?.error,
    commandHistoryUnrecorded: !input.hasLiveRun && !!turn && !latest.loading && !latest.error && !artifact?.error
      && ((!key && turn.phase !== "running") || !!artifact && artifact.artifact?.operationTimeline === undefined),
  };
}
