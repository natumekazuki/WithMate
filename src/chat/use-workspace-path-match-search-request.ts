import { useMemo } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import type { WorkspacePathMatchSearch } from "./use-workspace-path-match-search.js";

export type WorkspacePathMatchSearchSource = "session" | "companion";

export function useWorkspacePathMatchSearchRequest(input: {
  searchSource: WorkspacePathMatchSearchSource;
  sessionId: string | null;
  withmateApi: WithMateWindowApi | null;
}): WorkspacePathMatchSearch | null {
  return useMemo(() => {
    if (!input.withmateApi || !input.sessionId) {
      return null;
    }
    const withmateApi = input.withmateApi;
    const sessionId = input.sessionId;
    return input.searchSource === "companion"
      ? (query: string) => withmateApi.searchCompanionWorkspaceFiles(sessionId, query)
      : (query: string) => withmateApi.searchWorkspaceFiles(sessionId, query);
  }, [input.searchSource, input.sessionId, input.withmateApi]);
}
