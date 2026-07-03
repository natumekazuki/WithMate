import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type DeleteSessionsResult,
  type ResetAppDatabaseTarget,
} from "../withmate-window-types.js";

export const SETTINGS_SKILL_ROOT_LABEL = "Skill Root";
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "skill folder の親ディレクトリを入力";
export const SETTINGS_PROVIDER_FILE_SETTINGS_LABEL = "Provider File Settings";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL = "Root Directory";
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER = "Provider 設定の root directory";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL = "Skill Relative Path";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER = "skills";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL = "Instruction Relative Path";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER = "AGENTS.md";
export const SETTINGS_PROVIDER_FILE_SETTINGS_HELP =
  "Provider ごとに skill folder と instruction file の基準 path を指定する。Root Directory が空欄の場合、skill は workspace 内の既定 directory だけを使う。";
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_HELP =
  "Root Directory 配下の skill folder を相対パスで指定する。例: skills";
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_HELP =
  "Root Directory 配下の instruction file を相対パスで指定する。V5では同期実行せず、provider ごとの設定値として保持する。";
export const SETTINGS_API_KEY_LABEL = "OpenAI API Key (Coding Agent)";
export const SETTINGS_API_KEY_PLACEHOLDER = "Coding Agent 用 OpenAI API Key を入力";
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "Coding Agent が Character Stream を使うための OpenAI API Key を設定する。";
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "他 provider 対応は future scope として、いまは OpenAI 前提で扱う。";
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "初回リリース前のため、設定 schema の後方互換性は考慮しない。";
export const SETTINGS_LAUNCH_AT_LOGIN_LABEL = "PC 起動時に WithMate をバックグラウンドで起動する";
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL = "送信後に Action Dock を自動で閉じる";
export const SETTINGS_RESET_DATABASE_LABEL = "DB を初期化";
export const SETTINGS_RESET_DATABASE_HELP =
  "Danger Zone: app settings などの DB 内容を初期化する。";
export const SETTINGS_DELETE_OLD_SESSIONS_LABEL = "古い Session を削除";
export const SETTINGS_DELETE_OLD_SESSIONS_HELP =
  "指定日より前に最後に使われた Session を削除する。実行中の Session は削除しない。";
export const SETTINGS_DIAGNOSTICS_LABEL = "Diagnostics";
export const SETTINGS_OPEN_LOG_FOLDER_LABEL = "Open Logs";
export const SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL = "Open Crash Dumps";
export const SETTINGS_MEMORY_PROVIDER_INSTRUCTION_SAMPLE_LABEL = "Provider Instruction Sample";
export const SETTINGS_MEMORY_PROVIDER_INSTRUCTION_SAMPLE_HELP =
  "必要な provider の user-level instruction file へ手動で貼り付けるための WithMate Memory 利用方針。WithMate は instruction file を自動編集しない。";
export const SETTINGS_COPY_MEMORY_PROVIDER_INSTRUCTION_SAMPLE_LABEL = "Copy Sample";

export const SETTINGS_RESET_DATABASE_TARGET_LABELS: Record<ResetAppDatabaseTarget, string> = {
  sessions: "sessions",
  auditLogs: "audit logs",
  appSettings: "app settings",
  modelCatalog: "model catalog",
  projectMemory: "project memory",
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
    "実行中の session がある間は初期化できないよ。",
  ];

  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    lines.splice(1, 0, "全対象を選んでいるので、DB ファイルと characters file body を再生成して schema も初期化するよ。");
  } else {
    lines.splice(1, 0, "characters file body は保持されるよ。");
  }

  lines.push("本当に続ける？");
  return lines.join("\n\n");
}

export function buildResetDatabaseSuccessMessage(targets: readonly ResetAppDatabaseTarget[]): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const targetSummary = describeResetDatabaseTargets(normalized);
  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    return `DB と characters file body を再生成して ${targetSummary} を初期状態へ戻したよ。`;
  }

  return `${targetSummary} を初期状態へ戻したよ。characters file body は保持したよ。`;
}

export function buildDeleteOldSessionsConfirmMessage(cutoffDate: string): string {
  return [
    `${cutoffDate} より前に最後に使われた Session を削除するよ。`,
    "実行中の Session は削除せずに残すよ。",
    "本当に続ける？",
  ].join("\n\n");
}

export function buildDeleteOldSessionsSuccessMessage(result: DeleteSessionsResult): string {
  const deletedCount = result.deletedSessionIds.length;
  const skippedCount = result.skippedRunningSessionIds.length;
  if (deletedCount === 0 && skippedCount === 0) {
    return "削除対象の古い Session はなかったよ。";
  }

  const skippedSuffix = skippedCount > 0 ? ` 実行中の ${skippedCount} 件は残したよ。` : "";
  return `${deletedCount} 件の古い Session を削除したよ。${skippedSuffix}`.trim();
}

export { ALL_RESET_APP_DATABASE_TARGETS };
