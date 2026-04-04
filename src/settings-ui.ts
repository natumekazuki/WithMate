import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseTarget,
} from "./withmate-window-types.js";

export const SETTINGS_SKILL_ROOT_LABEL = "Skill Root";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "skill folder の親ディレクトリを入力";
export const SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL = "Model";
export const SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL = "Output Tokens Threshold";
export const SETTINGS_MEMORY_EXTRACTION_TIMEOUT_LABEL = "Timeout Seconds";
export const SETTINGS_MEMORY_GENERATION_LABEL = "Memory Generation";
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL = "送信後に Action Dock を自動で閉じる";
export const SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL = "Model";
export const SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_CHARACTER_REFLECTION_TIMEOUT_LABEL = "Timeout Seconds";
export const SETTINGS_CHARACTER_REFLECTION_COOLDOWN_LABEL = "Cooldown Seconds";
export const SETTINGS_CHARACTER_REFLECTION_CHAR_DELTA_LABEL = "Min Char Delta";
export const SETTINGS_CHARACTER_REFLECTION_MESSAGE_DELTA_LABEL = "Min Message Delta";

export const SETTINGS_RESET_DATABASE_TARGET_LABELS: Record<ResetAppDatabaseTarget, string> = {
  sessions: "sessions",
  auditLogs: "audit logs",
  appSettings: "app settings",
  modelCatalog: "model catalog",
  projectMemory: "project memory",
  characterMemory: "character memory",
};

export function describeResetDatabaseTargets(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  if (normalized.length === 0) {
    return "なし";
  }

  return normalized.map((target) => SETTINGS_RESET_DATABASE_TARGET_LABELS[target]).join(" / ");
}

export function buildResetDatabaseConfirmMessage(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const lines = [
    `次を初期化するよ: ${describeResetDatabaseTargets(normalized)}`,
    "characters は DB 外ファイルなので保持されるよ。",
    "実行中の session がある間は初期化できないよ。",
  ];

  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    lines.splice(1, 0, "全対象を選んでいるので、DB ファイルを再生成して schema も初期化するよ。");
  }

  lines.push("本当に続ける？");
  return lines.join("\n\n");
}

export function buildResetDatabaseSuccessMessage(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const targetSummary = describeResetDatabaseTargets(normalized);
  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    return `DB を再生成して ${targetSummary} を初期状態へ戻したよ。characters は保持したよ。`;
  }

  return `${targetSummary} を初期状態へ戻したよ。characters は保持したよ。`;
}

export { ALL_RESET_APP_DATABASE_TARGETS };
