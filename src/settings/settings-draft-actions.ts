import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  updateAutoCollapseActionDockOnSend,
  updateCharacterDefinitionEnabled,
  updateCurrentDateEnabled,
  updateGlossaryProactiveCreateLimitDraft,
  updateCodingProviderEnabledDraft,
  updateCodingProviderInstructionRelativePathDraft,
  updateCodingProviderSkillRelativePathDraft,
  updateCodingProviderSkillRootPathDraft,
  updateLaunchAtLoginEnabled,
  updateKeyboardShortcuts,
  updateScrollToLatestOnSend,
  updatePreviewWheelZoomStep,
  updateSessionTurnNotificationEnabled,
  updateSessionApprovalNotificationEnabled,
  updateSessionTurnNotificationResponsePreviewEnabled,
} from "./settings-draft.js";

type SetSettingsDraft = (updater: (current: AppSettings) => AppSettings) => void;

type SettingsDraftActionInput = {
  setSettingsDraft: SetSettingsDraft;
};

export function handleChangeProviderEnabled(input: SettingsDraftActionInput & {
  providerId: string;
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateCodingProviderEnabledDraft(current, input.providerId, input.enabled));
}

export function handleChangeProviderSkillRootPath(input: SettingsDraftActionInput & {
  providerId: string;
  skillRootPath: string;
}): void {
  input.setSettingsDraft((current) => updateCodingProviderSkillRootPathDraft(current, input.providerId, input.skillRootPath));
}

export function handleChangeProviderSkillRelativePath(input: SettingsDraftActionInput & {
  providerId: string;
  skillRelativePath: string;
}): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderSkillRelativePathDraft(current, input.providerId, input.skillRelativePath));
}

export function handleChangeProviderInstructionRelativePath(input: SettingsDraftActionInput & {
  providerId: string;
  instructionRelativePath: string;
}): void {
  input.setSettingsDraft((current) =>
    updateCodingProviderInstructionRelativePathDraft(current, input.providerId, input.instructionRelativePath));
}

export function handleChangeAutoCollapseActionDockOnSend(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateAutoCollapseActionDockOnSend(current, input.enabled));
}

export function handleChangeCharacterDefinitionEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateCharacterDefinitionEnabled(current, input.enabled));
}

export function handleChangeCurrentDateEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateCurrentDateEnabled(current, input.enabled));
}

export function handleChangeScrollToLatestOnSend(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateScrollToLatestOnSend(current, input.enabled));
}

export function handleChangeKeyboardShortcuts(input: SettingsDraftActionInput & {
  keyboardShortcuts: KeyboardShortcutSettings;
}): void {
  input.setSettingsDraft((current) => updateKeyboardShortcuts(current, input.keyboardShortcuts));
}

export function handleChangePreviewWheelZoomStep(input: SettingsDraftActionInput & { value: number }): void {
  input.setSettingsDraft((current) => updatePreviewWheelZoomStep(current, input.value));
}

export function handleChangeLaunchAtLoginEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateLaunchAtLoginEnabled(current, input.enabled));
}

export function handleChangeSessionTurnNotificationEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateSessionTurnNotificationEnabled(current, input.enabled));
}

export function handleChangeSessionApprovalNotificationEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) => updateSessionApprovalNotificationEnabled(current, input.enabled));
}

export function handleChangeSessionTurnNotificationResponsePreviewEnabled(input: SettingsDraftActionInput & {
  enabled: boolean;
}): void {
  input.setSettingsDraft((current) =>
    updateSessionTurnNotificationResponsePreviewEnabled(current, input.enabled));
}

export function handleChangeGlossaryProactiveCreateLimit(input: SettingsDraftActionInput & {
  value: string;
}): void {
  input.setSettingsDraft((current) => updateGlossaryProactiveCreateLimitDraft(current, input.value));
}
