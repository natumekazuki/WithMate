import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseTarget,
} from "./withmate-window.js";

export const SETTINGS_API_KEY_LABEL = "OpenAI API Key (Coding Agent)";
export const SETTINGS_API_KEY_PLACEHOLDER = "Coding Agent 用 OpenAI API Key を入力";
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "ここで保存する credential は Coding Agent Providers 専用。Character Stream 用 API ではない。";
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "Character Stream 用 API 設定は future scope。current milestone ではまだ追加しない。";
export const SETTINGS_SKILL_ROOT_LABEL = "Skill Root";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "skill folder の親ディレクトリを入力";
export const SETTINGS_SKILL_ROOT_HELP =
  "provider ごとの共有 skill root を指定できる。workspace 配下の標準 skill roots と合わせて Session の Skill picker 候補に出す。";
export const SETTINGS_MEMORY_EXTRACTION_MODEL_LABEL = "Model";
export const SETTINGS_MEMORY_EXTRACTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_MEMORY_EXTRACTION_THRESHOLD_LABEL = "Output Tokens Threshold";
export const SETTINGS_MEMORY_EXTRACTION_HELP =
  "Memory extraction は provider ごとに専用 model / reasoning depth / outputTokens threshold を持つ。`compact 前` と `session close 前` は threshold に関係なく強制実行する。";
export const SETTINGS_CHARACTER_REFLECTION_MODEL_LABEL = "Model";
export const SETTINGS_CHARACTER_REFLECTION_REASONING_LABEL = "Reasoning Depth";
export const SETTINGS_CHARACTER_REFLECTION_HELP =
  "Character reflection は provider ごとに専用 model / reasoning depth を持つ。trigger 条件は app 側の仕様で固定する。";
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "初回リリース前のため後方互換性は考慮しない。互換性のない変更が入った場合は Settings の DB 初期化で復旧する。";
export const SETTINGS_RESET_DATABASE_LABEL = "DB を初期化";
export const SETTINGS_RESET_DATABASE_HELP =
  "互換性のない変更に追従できなくなったら、Settings の Danger Zone から reset 対象を選んで DB を初期化できる。characters は DB 外ファイルなので保持される。sessions を選ぶと audit logs も一緒に初期化される。";

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
