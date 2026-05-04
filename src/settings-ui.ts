import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseTarget,
} from "./withmate-window-types.js";

export const SETTINGS_SKILL_ROOT_LABEL = "Skill Root";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "skill folder の親ディレクトリを入力";
export const SETTINGS_API_KEY_LABEL = "OpenAI API Key (Coding Agent)";
export const SETTINGS_API_KEY_PLACEHOLDER = "Coding Agent 用 OpenAI API Key を入力";
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "Coding Agent が Character Stream を使うための OpenAI API Key を設定する。";
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "他 provider 対応は future scope として、いまは OpenAI 前提で扱う。";
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "初回リリース前のため、設定 schema の後方互換性は考慮しない。";
export const SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL = "Model";
export const SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL = "Output Tokens Threshold";
export const SETTINGS_MEMORY_EXTRACTION_TIMEOUT_LABEL = "Timeout Seconds";
export const SETTINGS_PROVIDER_INSTRUCTION_SECTION_LABEL = "Provider Instruction Sync";
export const SETTINGS_PROVIDER_INSTRUCTION_WRITE_MODE_LABEL = "Write Mode";
export const SETTINGS_PROVIDER_INSTRUCTION_FAIL_POLICY_LABEL = "Fail Policy";
export const SETTINGS_MATE_MEMORY_GENERATION_LABEL = "Mate Memory Generation";
export const SETTINGS_MATE_MEMORY_GENERATION_TRIGGER_INTERVAL_LABEL = "Trigger Interval (Minutes)";
export const SETTINGS_MATE_MEMORY_GENERATION_MODEL_LABEL = "Model";
export const SETTINGS_MATE_MEMORY_GENERATION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_MATE_MEMORY_GENERATION_TIMEOUT_LABEL = "Timeout Seconds";
export const SETTINGS_MATE_EMBEDDING_LABEL = "Mate Embedding";
export const SETTINGS_MATE_EMBEDDING_DOWNLOAD_LABEL = "Download Model";
export const SETTINGS_MATE_EMBEDDING_MODEL_LABEL = "Model";
export const SETTINGS_MATE_EMBEDDING_DIMENSION_LABEL = "Dimension";
export const SETTINGS_MATE_EMBEDDING_CACHE_STATE_LABEL = "Cache";
export const SETTINGS_MEMORY_GENERATION_LABEL = "Memory Generation";
export const SETTINGS_MEMORY_GENERATION_HELP =
  "OFF にすると、turn 完了後の Generate Memory を実行しない。";
export const SETTINGS_MEMORY_EXTRACTION_HELP =
  "turn 完了後に Generate Memory を実行する際に使う memory extraction の設定。timeout に達したらその回の抽出は中断する。";
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL = "送信後に Action Dock を自動で閉じる";
export const SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL = "Model";
export const SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_CHARACTER_REFLECTION_TIMEOUT_LABEL = "Timeout Seconds";
export const SETTINGS_CHARACTER_REFLECTION_COOLDOWN_LABEL = "Cooldown Seconds";
export const SETTINGS_CHARACTER_REFLECTION_CHAR_DELTA_LABEL = "Min Char Delta";
export const SETTINGS_CHARACTER_REFLECTION_MESSAGE_DELTA_LABEL = "Min Message Delta";
export const SETTINGS_CHARACTER_REFLECTION_HELP =
  "app-wide な character reflection を SessionStart などで評価する設定。timeout に達したらその回は中断する。";
export const SETTINGS_RESET_DATABASE_LABEL = "DB を初期化";
export const SETTINGS_RESET_DATABASE_HELP =
  "Danger Zone: app settings などの DB 内容を初期化する。characters は DB 外ファイルなので保持される。";
export const SETTINGS_DIAGNOSTICS_LABEL = "Diagnostics";
export const SETTINGS_OPEN_LOG_FOLDER_LABEL = "Open Logs";
export const SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL = "Open Crash Dumps";

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
