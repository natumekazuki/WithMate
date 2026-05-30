import type { Dispatch, KeyboardEvent, SetStateAction } from "react";

import {
  buildClosedWorkspacePathMatchState,
  getWorkspacePathMatchNavigationIndex,
  resolveWorkspacePathMatchNavigation,
  type WorkspacePathMatchState,
} from "../session-composer-paths.js";
import type { WorkspacePathCandidate } from "../workspace-path-candidate.js";

export function handleWorkspacePathMatchKeyboardNavigation(input: {
  activeIndex: number;
  event: KeyboardEvent<HTMLTextAreaElement>;
  isComposerImeComposing: boolean;
  onActiveIndexChange: Dispatch<SetStateAction<number>>;
  onSelectWorkspacePathMatch: (path: string) => void;
  onWorkspacePathMatchStateChange: (state: WorkspacePathMatchState) => void;
  pathMatches: WorkspacePathCandidate[];
}): boolean {
  const pathMatchNavigation = resolveWorkspacePathMatchNavigation({
    pathMatches: input.pathMatches,
    activeIndex: input.activeIndex,
    key: input.event.key,
    ctrlKey: input.event.ctrlKey,
    metaKey: input.event.metaKey,
    isComposerImeComposing: input.isComposerImeComposing,
    isNativeComposing: input.event.nativeEvent.isComposing,
  });

  if (!pathMatchNavigation) {
    return false;
  }

  if (pathMatchNavigation.kind === "next" || pathMatchNavigation.kind === "previous") {
    input.event.preventDefault();
    input.onActiveIndexChange((current) => (
      getWorkspacePathMatchNavigationIndex(
        pathMatchNavigation,
        current,
        input.pathMatches.length,
      )
    ));
    return true;
  }

  if (pathMatchNavigation.kind === "dismiss") {
    if (pathMatchNavigation.shouldPreventDefault) {
      input.event.preventDefault();
    }
    input.onWorkspacePathMatchStateChange(buildClosedWorkspacePathMatchState());
    return true;
  }

  input.event.preventDefault();
  input.onSelectWorkspacePathMatch(pathMatchNavigation.match.path);
  return true;
}
