import {
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
  GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN,
  getProviderAppSettings,
  type AppSettings,
  type ProviderAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";

export function updateAutoCollapseActionDockOnSend(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    autoCollapseActionDockOnSend: enabled,
  };
}

export function updateCharacterDefinitionEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    characterDefinitionEnabled: enabled,
  };
}

export function updateCurrentDateEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    currentDateEnabled: enabled,
  };
}

export function updateScrollToLatestOnSend(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    scrollToLatestOnSend: enabled,
  };
}

export function updateKeyboardShortcuts(
  draft: AppSettings,
  keyboardShortcuts: KeyboardShortcutSettings,
): AppSettings {
  return {
    ...draft,
    keyboardShortcuts,
  };
}

export function updatePreviewWheelZoomStep(draft: AppSettings, value: number): AppSettings {
  return { ...draft, previewWheelZoomStep: value };
}

export function updateSessionTurnNotificationEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    sessionTurnNotificationEnabled: enabled,
  };
}

export function updateSessionApprovalNotificationEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return { ...draft, sessionApprovalNotificationEnabled: enabled };
}

export function updateSessionTurnNotificationResponsePreviewEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    sessionTurnNotificationResponsePreviewEnabled: enabled,
  };
}

export function updateLaunchAtLoginEnabled(
  draft: AppSettings,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    launchAtLoginEnabled: enabled,
  };
}

export function updateGlossaryProactiveCreateLimitDraft(
  draft: AppSettings,
  rawValue: string,
): AppSettings {
  if (!rawValue.trim()) {
    return { ...draft, glossaryProactiveCreateLimit: null };
  }
  const parsed = Number(rawValue);
  const limit = Number.isInteger(parsed)
    ? Math.min(
        GLOSSARY_PROACTIVE_CREATE_LIMIT_MAX,
        Math.max(GLOSSARY_PROACTIVE_CREATE_LIMIT_MIN, parsed),
      )
    : null;
  return { ...draft, glossaryProactiveCreateLimit: limit };
}

export function updateCodingProviderEnabledDraft(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderEnabled(draft, providerId, enabled),
  };
}

export function updateCodingProviderSkillRootPathDraft(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRootPath(draft, providerId, skillRootPath),
  };
}

export function updateCodingProviderSkillRelativePathDraft(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderSkillRelativePath(draft, providerId, skillRelativePath),
  };
}

export function updateCodingProviderInstructionRelativePathDraft(
  draft: AppSettings,
  providerId: string,
  instructionRelativePath: string,
): AppSettings {
  return {
    ...draft,
    codingProviderSettings: updateCodingProviderInstructionRelativePath(draft, providerId, instructionRelativePath),
  };
}

export function updateCodingProviderEnabled(
  draft: AppSettings,
  providerId: string,
  enabled: boolean,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      enabled,
    },
  };
}

export function updateCodingProviderSkillRootPath(
  draft: AppSettings,
  providerId: string,
  skillRootPath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRootPath,
    },
  };
}

export function updateCodingProviderSkillRelativePath(
  draft: AppSettings,
  providerId: string,
  skillRelativePath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      skillRelativePath,
    },
  };
}

export function updateCodingProviderInstructionRelativePath(
  draft: AppSettings,
  providerId: string,
  instructionRelativePath: string,
): Record<string, ProviderAppSettings> {
  return {
    ...draft.codingProviderSettings,
    [providerId]: {
      ...getProviderAppSettings(draft, providerId),
      instructionRelativePath,
    },
  };
}
