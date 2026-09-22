import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type DeleteSessionsResult,
  type ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";

export const SETTINGS_SKILL_ROOT_LABEL = "SkillRoot";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "Parent folder for skills";
export const SETTINGS_PROVIDER_FILE_SETTINGS_LABEL = "ProviderFileSettings";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL = "RootDirectory";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER = "Provider settings root directory";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL = "SkillRelativePath";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER = "skills";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL = "InstructionRelativePath";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER = "AGENTS.md";
export const SETTINGS_PROVIDER_FILE_SETTINGS_HELP =
  "Leave the root directory empty to use the workspace default directory.";
export const SETTINGS_API_KEY_LABEL = "OpenAIApiKey";
export const SETTINGS_API_KEY_PLACEHOLDER = "Enter the OpenAI API key for the coding agent";
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "Set the OpenAI API key used by the coding agent for Character Stream.";
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "Other providers are future scope; the current setup assumes OpenAI.";
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "Settings schema compatibility is not supported before the first release.";
export const SETTINGS_LAUNCH_AT_LOGIN_LABEL = "LaunchAtLogin";
export const SETTINGS_SESSION_TURN_NOTIFICATION_LABEL = "SessionTurnNotification";
export const SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL =
  "NotificationResponsePreview";
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL = "CloseActionDockAfterSend";
export const SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL = "ScrollToLatestOnSend";
export const SETTINGS_CHARACTER_DEFINITION_LABEL = "CharacterDefinitionSnapshot";
export const SETTINGS_CHARACTER_AFFECT_CONTEXT_LABEL = "CharacterAffectContext";
export const SETTINGS_CONVERSATION_TIMING_LABEL = "ConversationTiming";
export const SETTINGS_TOOL_CALL_PRESENCE_LABEL = "ToolCallPresence";
export const SETTINGS_MEMORY_FILE_QUOTA_LABEL = "MemoryFileQuota";
export const SETTINGS_MEMORY_FILE_QUOTA_HELP =
  "Maximum total size for protected objects. New file appends fail when current usage exceeds this limit.";
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL = "GlossaryProactiveCreateLimit";
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP =
  "Maximum terms an agent can create proactively in one turn. 0 disables proactive creation but not explicit requests.";
export const SETTINGS_RESET_DATABASE_LABEL = "Reset database";
export const SETTINGS_RESET_DATABASE_HELP =
  "Danger zone: reset selected database content, including app settings.";
export const SETTINGS_DELETE_OLD_SESSIONS_LABEL = "DeleteOldSessions";
export const SETTINGS_DELETE_OLD_SESSIONS_HELP =
  "Delete sessions last active before the selected date. Running sessions are kept.";
export const SETTINGS_DIAGNOSTICS_LABEL = "Diagnostics";
export const SETTINGS_OPEN_LOG_FOLDER_LABEL = "OpenLogs";
export const SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL = "OpenCrashDumps";
export const SETTINGS_RESET_DATABASE_TARGET_LABELS: Record<ResetAppDatabaseTarget, string> = {
  sessions: "Sessions",
  auditLogs: "Audit logs",
  appSettings: "App settings",
  modelCatalog: "Model catalog",
  projectMemory: "Project memory",
};

export function describeResetDatabaseTargets(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  if (normalized.length === 0) {
    return "None";
  }

  return normalized.map((target) => SETTINGS_RESET_DATABASE_TARGET_LABELS[target]).join(" / ");
}

export function buildResetDatabaseConfirmMessage(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const lines = [
    `Reset the following: ${describeResetDatabaseTargets(normalized)}.`,
    "Running sessions must finish before the reset can run.",
  ];

  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    lines.splice(1, 0, "All targets are selected. The database file, character file bodies, and schema will be recreated.");
  } else {
    lines.splice(1, 0, "Character file bodies will be preserved.");
  }

  lines.push("Continue?");
  return lines.join("\n\n");
}

export function buildResetDatabaseSuccessMessage(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const targetSummary = describeResetDatabaseTargets(normalized);
  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    return `Reset ${targetSummary}, including the database and character file bodies.`;
  }

  return `Reset ${targetSummary}. Character file bodies were preserved.`;
}

export function buildDeleteOldSessionsConfirmMessage(cutoffDate: string): string {
  return [
    `Delete sessions last active before ${cutoffDate}.`,
    "Running sessions will be kept.",
    "Continue?",
  ].join("\n\n");
}

export function buildDeleteOldSessionsSuccessMessage(result: DeleteSessionsResult): string {
  const deletedCount = result.deletedSessionIds.length;
  const skippedCount = result.skippedRunningSessionIds.length;
  if (deletedCount === 0 && skippedCount === 0) {
    return "No sessions matched the cleanup date.";
  }

  const deletedLabel = `${deletedCount} old session${deletedCount === 1 ? "" : "s"} deleted.`;
  const skippedSuffix = skippedCount > 0
    ? ` Kept ${skippedCount} running session${skippedCount === 1 ? "" : "s"}.`
    : "";
  return `${deletedLabel}${skippedSuffix}`.trim();
}

export { ALL_RESET_APP_DATABASE_TARGETS };
