import { useEffect } from "react";

import {
  buildWorkspacePathMatchState,
  canSearchWorkspacePathMatches,
  type WorkspacePathMatchState,
} from "../session-composer-paths.js";
import {
  WORKSPACE_PATH_QUERY_MIN_LENGTH,
  WORKSPACE_PATH_SEARCH_DEBOUNCE_MS,
} from "../composer-preview-config.js";
import type { WorkspacePathCandidate } from "../workspace-path-candidate.js";

export type WorkspacePathMatchSearch = (query: string) => Promise<WorkspacePathCandidate[]>;

export function useWorkspacePathMatchSearch(input: {
  isComposerImeComposing: boolean;
  isEditingPathReference: boolean;
  isSearchBlocked: boolean;
  normalizedActivePathQuery: string;
  onWorkspacePathMatchStateChange: (state: WorkspacePathMatchState) => void;
  searchWorkspacePathMatches: WorkspacePathMatchSearch | null;
}): void {
  useEffect(() => {
    let active = true;

    if (
      !input.searchWorkspacePathMatches
      || !canSearchWorkspacePathMatches({
        isSearchBlocked: input.isSearchBlocked,
        isComposerImeComposing: input.isComposerImeComposing,
        isEditingPathReference: input.isEditingPathReference,
        normalizedActivePathQuery: input.normalizedActivePathQuery,
        minQueryLength: WORKSPACE_PATH_QUERY_MIN_LENGTH,
      })
    ) {
      input.onWorkspacePathMatchStateChange(buildWorkspacePathMatchState([]));
      return () => {
        active = false;
      };
    }

    const searchWorkspacePathMatches = input.searchWorkspacePathMatches;
    const timeoutId = window.setTimeout(() => {
      void searchWorkspacePathMatches(input.normalizedActivePathQuery).then((matches) => {
        if (active) {
          input.onWorkspacePathMatchStateChange(buildWorkspacePathMatchState(matches));
        }
      }).catch(() => {
        if (active) {
          input.onWorkspacePathMatchStateChange(buildWorkspacePathMatchState([]));
        }
      });
    }, WORKSPACE_PATH_SEARCH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    input.isComposerImeComposing,
    input.isEditingPathReference,
    input.isSearchBlocked,
    input.normalizedActivePathQuery,
    input.onWorkspacePathMatchStateChange,
    input.searchWorkspacePathMatches,
  ]);
}
