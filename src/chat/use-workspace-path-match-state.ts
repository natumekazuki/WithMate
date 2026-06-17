import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import {
  buildWorkspacePathMatchItems,
  type WorkspacePathMatchState,
} from "../session-composer-paths.js";
import type { WorkspacePathCandidate } from "../workspace-path-candidate.js";

export function useWorkspacePathMatchState(): {
  activeWorkspacePathMatchIndex: number;
  applyWorkspacePathMatchState: (state: WorkspacePathMatchState) => void;
  setActiveWorkspacePathMatchIndex: Dispatch<SetStateAction<number>>;
  setWorkspacePathMatches: Dispatch<SetStateAction<WorkspacePathCandidate[]>>;
  workspacePathMatchItems: ReturnType<typeof buildWorkspacePathMatchItems>;
  workspacePathMatches: WorkspacePathCandidate[];
} {
  const [workspacePathMatches, setWorkspacePathMatches] = useState<WorkspacePathCandidate[]>([]);
  const [activeWorkspacePathMatchIndex, setActiveWorkspacePathMatchIndex] = useState(-1);
  const applyWorkspacePathMatchState = useCallback((state: WorkspacePathMatchState) => {
    setWorkspacePathMatches(state.workspacePathMatches);
    setActiveWorkspacePathMatchIndex(state.activeWorkspacePathMatchIndex);
  }, []);
  const workspacePathMatchItems = useMemo(
    () => buildWorkspacePathMatchItems(workspacePathMatches, activeWorkspacePathMatchIndex),
    [activeWorkspacePathMatchIndex, workspacePathMatches],
  );

  return {
    workspacePathMatches,
    activeWorkspacePathMatchIndex,
    setWorkspacePathMatches,
    setActiveWorkspacePathMatchIndex,
    applyWorkspacePathMatchState,
    workspacePathMatchItems,
  };
}
