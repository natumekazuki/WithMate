import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  type WorkspacePathMatchSearchSource,
  useWorkspacePathMatchSearchRequest,
} from "./use-workspace-path-match-search-request.js";
import {
  useWorkspacePathMatchSearch,
} from "./use-workspace-path-match-search.js";
import type { WorkspacePathMatchState } from "../session-composer-paths.js";

export function useWorkspacePathMatchSearchFlow(input: {
  isComposerImeComposing: boolean;
  isEditingPathReference: boolean;
  isSearchBlocked: boolean;
  normalizedActivePathQuery: string;
  onWorkspacePathMatchStateChange: (state: WorkspacePathMatchState) => void;
  searchSource: WorkspacePathMatchSearchSource;
  sessionId: string | null;
  withmateApi: WithMateWindowApi | null;
}): void {
  const searchWorkspacePathMatches = useWorkspacePathMatchSearchRequest({
    searchSource: input.searchSource,
    sessionId: input.sessionId,
    withmateApi: input.withmateApi,
  });
  useWorkspacePathMatchSearch({
    searchWorkspacePathMatches,
    isSearchBlocked: input.isSearchBlocked,
    isComposerImeComposing: input.isComposerImeComposing,
    isEditingPathReference: input.isEditingPathReference,
    normalizedActivePathQuery: input.normalizedActivePathQuery,
    onWorkspacePathMatchStateChange: input.onWorkspacePathMatchStateChange,
  });
}
