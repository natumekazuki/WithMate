import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
} from "../action-dock-state.js";
import { buildExclusiveComposerPickerToggleState } from "../session-composer-selection.js";

export function toggleExpandedArtifactState(
  current: Record<string, boolean>,
  artifactKey: string,
): Record<string, boolean> {
  return {
    ...current,
    [artifactKey]: !current[artifactKey],
  };
}

export function resolveHeaderExpandedToggle(
  current: boolean,
  isEditingTitle: boolean,
): boolean {
  return isEditingTitle ? current : !current;
}

export function applyActionDockExpandCommand(input: {
  options?: { focusComposer?: boolean };
  setPinnedExpanded: (expanded: boolean) => void;
  focusComposer: () => void;
}): void {
  const nextState = buildActionDockExpandState(input.options);
  input.setPinnedExpanded(nextState.isActionDockPinnedExpanded);

  if (nextState.shouldFocusComposer) {
    input.focusComposer();
  }
}

export function applyActionDockCollapseCommand(input: {
  canCollapse: boolean;
  setPinnedExpanded: (expanded: boolean) => void;
}): void {
  const nextState = buildActionDockCollapseState(input.canCollapse);
  if (!nextState) {
    return;
  }

  input.setPinnedExpanded(nextState.isActionDockPinnedExpanded);
}

export function applyExclusiveComposerPickerToggle(input: {
  target: "agent" | "skill";
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  if (input.target === "agent") {
    input.setSkillPickerOpen(() => buildExclusiveComposerPickerToggleState("agent", false).isSkillPickerOpen);
    input.setAgentPickerOpen((current) => (
      buildExclusiveComposerPickerToggleState("agent", current).isAgentPickerOpen
    ));
    return;
  }

  input.setAgentPickerOpen(() => buildExclusiveComposerPickerToggleState("skill", false).isAgentPickerOpen);
  input.setSkillPickerOpen((current) => (
    buildExclusiveComposerPickerToggleState("skill", current).isSkillPickerOpen
  ));
}
