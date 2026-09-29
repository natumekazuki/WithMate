import { useEffect, useState } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionSummary } from "../../../src-shared/session/session-state.js";
import type { ReadStatus } from "../../ui/loading-indicator.js";

export function useSessionSummaryRead(
  api: Pick<WithMateWindowApi, "getSessionSummary" | "subscribeSessionInvalidation"> | null,
  sessionId: string | null,
) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    ownerId: string | null;
    status: ReadStatus;
    value: SessionSummary | null;
    error: string;
  }>({ ownerId: sessionId, status: "loading", value: null, error: "" });

  useEffect(() => {
    if (!api || !sessionId) return;
    let active = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      setState((previous) => ({
        ownerId: sessionId, status: "loading", error: "",
        value: previous.ownerId === sessionId ? previous.value : null,
      }));
      void api.getSessionSummary(sessionId).then((value) => {
        if (active && current === request) setState({ ownerId: sessionId, status: "ready", value, error: "" });
      }).catch((error: unknown) => {
        if (active && current === request) setState((previous) => ({
          ...previous, status: "error",
          error: `Session information could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        }));
      });
    };
    const unsubscribe = api.subscribeSessionInvalidation((event) => {
      if (event.scope === "all" || event.sessionIds.includes(sessionId)) load();
    });
    load();
    return () => { active = false; unsubscribe(); };
  }, [api, sessionId, revision]);

  return {
    summary: state.ownerId === sessionId ? state.value : null,
    status: state.ownerId === sessionId ? state.status : "loading" as const,
    error: state.ownerId === sessionId ? state.error : "",
    retry: () => setRevision((current) => current + 1),
  };
}
