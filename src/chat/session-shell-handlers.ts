import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
} from "../action-dock-state.js";
import {
  buildExclusiveComposerPickerToggleState,
  type SkillPromptInsertionState,
} from "../session-composer-selection.js";
import { createQuotedMessageInsertionFromComposer } from "./message-text-actions.js";
import {
  buildPathReferenceRemovalWithClosedWorkspaceMatchesState,
  buildSelectedPathReferenceInsertionState,
  buildWorkspacePathMatchSelectionState,
  resolvePickedPathBaseDirectory,
  toDirectoryPath,
  type ComposerPathPickerKind,
  type WorkspacePathMatchSelectionState,
} from "../session-composer-paths.js";
import {
  cycleContextPaneTab,
  type ContextPaneTabKey,
} from "../session-ui-projection.js";

export function toggleExpandedArtifactState(
  current: Record<string, boolean>,
  artifactKey: string,
): Record<string, boolean> {
  return {
    ...current,
    [artifactKey]: !current[artifactKey],
  };
}

export function applyExpandedArtifactToggleCommand(input: {
  artifactKey: string;
  setExpandedArtifacts: (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;
}): void {
  input.setExpandedArtifacts((current) => toggleExpandedArtifactState(current, input.artifactKey));
}

export function resolveHeaderExpandedToggle(
  current: boolean,
  isEditingTitle: boolean,
): boolean {
  return isEditingTitle ? current : !current;
}

export function applyHeaderExpandedToggleCommand(input: {
  isEditingTitle: boolean;
  setHeaderExpanded: (updater: (current: boolean) => boolean) => void;
}): void {
  input.setHeaderExpanded((current) => resolveHeaderExpandedToggle(current, input.isEditingTitle));
}

export function applyTitleInputKeyCommand(input: {
  key: string;
  preventDefault: () => void;
  saveTitle: () => void;
  cancelTitleEdit: () => void;
}): void {
  if (input.key === "Enter") {
    input.preventDefault();
    input.saveTitle();
    return;
  }

  if (input.key === "Escape") {
    input.preventDefault();
    input.cancelTitleEdit();
  }
}

export function applyStartTitleEditCommand(input: {
  title: string;
  setTitleDraft: (title: string) => void;
  setHeaderExpanded: (expanded: boolean) => void;
  setEditingTitle: (editing: boolean) => void;
}): void {
  input.setTitleDraft(input.title);
  input.setHeaderExpanded(true);
  input.setEditingTitle(true);
}

export function applyCancelTitleEditCommand(input: {
  title: string;
  setTitleDraft: (title: string) => void;
  setEditingTitle: (editing: boolean) => void;
}): void {
  input.setTitleDraft(input.title);
  input.setEditingTitle(false);
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

export function applyAgentPickerToggleCommand(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  applyExclusiveComposerPickerToggle({
    target: "agent",
    setAgentPickerOpen: input.setAgentPickerOpen,
    setSkillPickerOpen: input.setSkillPickerOpen,
  });
}

export function applySkillPickerToggleCommand(input: {
  setAgentPickerOpen: (updater: (current: boolean) => boolean) => void;
  setSkillPickerOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  applyExclusiveComposerPickerToggle({
    target: "skill",
    setAgentPickerOpen: input.setAgentPickerOpen,
    setSkillPickerOpen: input.setSkillPickerOpen,
  });
}

export function applySkillPromptInsertionUiState(input: {
  state: Pick<SkillPromptInsertionState, "caret" | "isActionDockPinnedExpanded" | "isSkillPickerOpen">;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setCaret: (caret: number) => void;
  setSkillPickerOpen: (open: boolean) => void;
}): void {
  input.setActionDockPinnedExpanded(input.state.isActionDockPinnedExpanded);
  input.setCaret(input.state.caret);
  input.setSkillPickerOpen(input.state.isSkillPickerOpen);
}

export function applyAdditionalDirectoryListToggle(input: {
  setAdditionalDirectoryListOpen: (updater: (current: boolean) => boolean) => void;
}): void {
  input.setAdditionalDirectoryListOpen((current) => !current);
}

export function applyPickedAdditionalDirectoryUiStateCommand(input: {
  selectedPath: string | null | undefined;
  setPickerBaseDirectory: (baseDirectory: string) => void;
  applyPickedDirectory?: (selectedPath: string) => void;
  setAdditionalDirectoryListOpen?: (open: boolean) => void;
}): boolean {
  if (!input.selectedPath) {
    return false;
  }

  input.setPickerBaseDirectory(input.selectedPath);
  input.applyPickedDirectory?.(input.selectedPath);
  input.setAdditionalDirectoryListOpen?.(true);
  return true;
}

export function applyContextPaneTabCycleCommand(input: {
  direction: -1 | 1;
  availableTabs: ContextPaneTabKey[];
  setActiveTab: (value: ContextPaneTabKey | ((current: ContextPaneTabKey) => ContextPaneTabKey)) => void;
}): void {
  input.setActiveTab((current) => cycleContextPaneTab(current, input.direction, input.availableTabs));
}

export function applyUnavailableContextPaneTabFallbackCommand(input: {
  activeTab: ContextPaneTabKey;
  availableTabs: ContextPaneTabKey[];
  setActiveTab: (value: ContextPaneTabKey) => void;
}): void {
  if (input.availableTabs.includes(input.activeTab)) {
    return;
  }

  input.setActiveTab(input.availableTabs[0] ?? "latest-command");
}

export function applyPickedComposerReferencePathCommand(input: {
  kind: ComposerPathPickerKind;
  selectedPath: string | null | undefined;
  setPickerBaseDirectory: (baseDirectory: string) => void;
  insertReferencePath: (selectedPath: string, kind: ComposerPathPickerKind) => void;
}): boolean {
  if (!input.selectedPath) {
    return false;
  }

  input.setPickerBaseDirectory(resolvePickedPathBaseDirectory(input.kind, input.selectedPath));
  input.insertReferencePath(input.selectedPath, input.kind);
  return true;
}

export function applyQuoteMessageTextCommand(input: {
  messageText: string;
  draft: string;
  fallbackCaret: number;
  textarea: HTMLTextAreaElement | null;
  applyInsertion: (insertion: { draft: string; caret: number }) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  const insertion = createQuotedMessageInsertionFromComposer({
    messageText: input.messageText,
    draft: input.draft,
    fallbackCaret: input.fallbackCaret,
    textarea: input.textarea,
  });
  if (!insertion) {
    return false;
  }

  input.applyInsertion(insertion);
  input.restoreComposerTextareaFocusAndCaret(input.textarea, insertion.caret);
  return true;
}

export function applyWorkspacePathMatchSelectionCommand(input: {
  draft: string;
  caret: number;
  match: string;
  textarea: HTMLTextAreaElement | null;
  applySelection: (state: WorkspacePathMatchSelectionState) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  if (!input.textarea) {
    return false;
  }

  const nextState = buildWorkspacePathMatchSelectionState(input.draft, input.caret, input.match);
  if (!nextState) {
    return false;
  }

  input.applySelection(nextState);
  input.restoreComposerTextareaFocusAndCaret(input.textarea, nextState.caret);
  return true;
}

export function applyPathReferenceRemovalCommand(input: {
  draft: string;
  attachmentPathCandidates: string[];
  applyRemoval: (state: WorkspacePathMatchSelectionState) => void;
}): void {
  input.applyRemoval(
    buildPathReferenceRemovalWithClosedWorkspaceMatchesState(
      input.draft,
      input.attachmentPathCandidates,
    ),
  );
}

export function applySelectedPathReferenceInsertionCommand(input: {
  draft: string;
  fallbackCaret: number;
  selectedPaths: string[];
  textarea: HTMLTextAreaElement | null;
  workspacePath: string | null;
  applyInsertion: (state: WorkspacePathMatchSelectionState) => void;
  restoreComposerTextareaFocusAndCaret: (
    textarea: HTMLTextAreaElement | null,
    caret: number,
  ) => void;
}): boolean {
  const insertionState = buildSelectedPathReferenceInsertionState({
    draft: input.draft,
    caret: input.textarea?.selectionStart ?? input.fallbackCaret,
    selectedPaths: input.selectedPaths,
    workspacePath: input.workspacePath,
  });
  if (!insertionState) {
    return false;
  }

  input.applyInsertion(insertionState);
  input.restoreComposerTextareaFocusAndCaret(input.textarea, insertionState.caret);
  return true;
}

export function applySessionFilesReferencePathsCommand(input: {
  selectedPaths: string[];
  referencePaths: string[];
  setPickerBaseDirectory: (baseDirectory: string) => void;
  insertReferencePaths: (referencePaths: string[]) => void;
}): boolean {
  const firstSelectedPath = input.selectedPaths[0];
  if (!firstSelectedPath || input.referencePaths.length === 0) {
    return false;
  }

  input.setPickerBaseDirectory(toDirectoryPath(firstSelectedPath));
  input.insertReferencePaths(input.referencePaths);
  return true;
}

export function applyPastedSessionAttachmentPathsCommand(input: {
  savedPaths: string[];
  insertReferencePaths: (referencePaths: string[]) => void;
}): boolean {
  if (input.savedPaths.length === 0) {
    return false;
  }

  input.insertReferencePaths(input.savedPaths);
  return true;
}
