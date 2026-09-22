import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type DeleteSessionsResult,
  type ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";

export const SETTINGS_SKILL_ROOT_LABEL = "Skill root";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "Parent folder for skills";
export const SETTINGS_PROVIDER_FILE_SETTINGS_LABEL = "Provider file settings";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL = "Root directory";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER = "Provider settings root directory";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL = "Skill relative path";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER = "skills";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL = "Instruction relative path";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER = "AGENTS.md";
export const SETTINGS_PROVIDER_FILE_SETTINGS_HELP =
  "Set the base paths for this provider's skill folder and instruction file. If the root directory is empty, skills use the workspace default directory.";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_HELP =
  "Set the skill folder relative to the root directory. Example: skills";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_HELP =
  "Set the instruction file relative to the root directory. This path is stored for the provider and is not synchronized in V5.";
export const SETTINGS_API_KEY_LABEL = "OpenAI API key (coding agent)";
export const SETTINGS_API_KEY_PLACEHOLDER = "Enter the OpenAI API key for the coding agent";
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "Set the OpenAI API key used by the coding agent for Character Stream.";
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "Other providers are future scope; the current setup assumes OpenAI.";
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "Settings schema compatibility is not supported before the first release.";
export const SETTINGS_LAUNCH_AT_LOGIN_LABEL = "Start WithMate in the background when the PC starts";
export const SETTINGS_SESSION_TURN_NOTIFICATION_LABEL = "Show a Windows notification when a session turn finishes";
export const SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL =
  "Show the start of the response in the Windows notification";
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL = "Close the action dock after sending";
export const SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL = "Scroll to the latest message after sending";
export const SETTINGS_CHARACTER_DEFINITION_LABEL = "Character definition snapshot";
export const SETTINGS_CHARACTER_AFFECT_CONTEXT_LABEL = "Character affect context";
export const SETTINGS_CONVERSATION_TIMING_LABEL = "Conversation timing";
export const SETTINGS_TOOL_CALL_PRESENCE_LABEL = "Tool call presence";
export const SETTINGS_MEMORY_FILE_QUOTA_LABEL = "Memory file quota";
export const SETTINGS_MEMORY_FILE_QUOTA_HELP =
  "Maximum total size for protected objects. New file appends fail when current usage exceeds this limit.";
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL = "Glossary proactive create limit";
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP =
  "Maximum terms an agent can create proactively in one turn. 0 disables proactive creation but not explicit requests.";
export const SETTINGS_RESET_DATABASE_LABEL = "Reset database";
export const SETTINGS_RESET_DATABASE_HELP =
  "Danger zone: reset selected database content, including app settings.";
export const SETTINGS_DELETE_OLD_SESSIONS_LABEL = "Delete old sessions";
export const SETTINGS_DELETE_OLD_SESSIONS_HELP =
  "Delete sessions last active before the selected date. Running sessions are kept.";
export const SETTINGS_DIAGNOSTICS_LABEL = "Diagnostics";
export const SETTINGS_OPEN_LOG_FOLDER_LABEL = "Open logs";
export const SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL = "Open crash dumps";
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
