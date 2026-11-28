import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
  type DeleteSessionsResult,
  type ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";

/** スキルの親ディレクトリを指定する入力欄の見出し。 */
export const SETTINGS_SKILL_ROOT_LABEL = "Skill Root";
/** スキルそのものではなく親フォルダーを指定することを示す入力ヒント。 */
export const SETTINGS_SKILL_ROOT_PLACEHOLDER = "Parent folder for skills";
/** プロバイダーのルートと相対パスの設定をまとめる節の見出し。 */
export const SETTINGS_PROVIDER_FILE_SETTINGS_LABEL = "Provider File Settings";
/** プロバイダーの相対パスの基準になるディレクトリ欄の見出し。 */
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_LABEL = "Root Directory";
/** 設定対象のプロバイダーを基準にルートを指定することを示す入力ヒント。 */
export const SETTINGS_PROVIDER_ROOT_DIRECTORY_PLACEHOLDER =
  "Provider settings root directory";
/** ルート基準のスキルディレクトリを設定する入力欄の見出し。 */
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_LABEL =
  "Skill Relative Path";
/** ルート直下のスキルディレクトリを相対パスで書く例。 */
export const SETTINGS_PROVIDER_SKILL_RELATIVE_PATH_PLACEHOLDER = "skills";
/** ルート基準の指示ファイルを設定する入力欄の見出し。 */
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_LABEL =
  "Instruction Relative Path";
/** 指示ファイル名だけでルート直下を指定する場合の入力例。 */
export const SETTINGS_PROVIDER_INSTRUCTION_RELATIVE_PATH_PLACEHOLDER =
  "AGENTS.md";
/** ルート未指定時にワークスペースの既定ディレクトリが使われることを伝える。 */
export const SETTINGS_PROVIDER_FILE_SETTINGS_HELP =
  "Leave the root directory empty to use the workspace default directory.";
/** OpenAI のコーディングエージェント用資格情報を入力する欄の見出し。 */
export const SETTINGS_API_KEY_LABEL = "OpenAI API Key";
/** コーディングエージェント向けの OpenAI キーを求める入力ヒント。 */
export const SETTINGS_API_KEY_PLACEHOLDER =
  "Enter the OpenAI API key for the coding agent";
/** 入力したキーの用途を Character Stream のコーディングエージェントと示す案内。 */
export const SETTINGS_CODING_CREDENTIALS_HELP =
  "Set the OpenAI API key used by the coding agent for Character Stream.";
/** 資格情報の設定が OpenAI を前提にしていることを示す従来の案内文。 */
export const SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE =
  "Other providers are future scope; the current setup assumes OpenAI.";
/** 初回リリース前の設定スキーマを互換対象にしないことを示す案内文。 */
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "Settings schema compatibility is not supported before the first release.";
/** OS へのログイン時に WithMate を起動する切り替えの見出し。 */
export const SETTINGS_LAUNCH_AT_LOGIN_LABEL = "Launch At Login";
/** セッション応答完了時の通知を切り替える項目名。 */
export const SETTINGS_SESSION_TURN_NOTIFICATION_LABEL =
  "Session Turn Notification";
/** セッションが承認を待っていることを通知する設定の項目名。 */
export const SETTINGS_SESSION_APPROVAL_NOTIFICATION_LABEL =
  "Session Approval Notification";
/** 応答完了通知への応答プレビュー掲載を切り替える項目名。 */
export const SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL =
  "Notification Response Preview";
/** 送信後にアクションドックを閉じる設定の項目名。 */
export const SETTINGS_ACTION_DOCK_AUTO_CLOSE_LABEL =
  "Close Action Dock After Send";
/** 送信時にチャット表示を最新位置へ移動する設定の項目名。 */
export const SETTINGS_SCROLL_TO_LATEST_ON_SEND_LABEL =
  "Scroll To Latest On Send";
/** キャラクター定義のスナップショットをプロンプトに添える設定の項目名。 */
export const SETTINGS_CHARACTER_DEFINITION_LABEL =
  "Character Definition Snapshot";
/** 現在日付をプロンプトへ添える設定の項目名。 */
export const SETTINGS_CURRENT_DATE_LABEL = "Current Date";
/** エージェントが能動登録できる用語数の上限欄の見出し。 */
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_LABEL =
  "Glossary Proactive Create Limit";
/** 上限がターン単位であり、0 でも明示依頼による登録は妨げないことを伝える。 */
export const SETTINGS_GLOSSARY_PROACTIVE_CREATE_LIMIT_HELP =
  "Maximum terms an agent can create proactively in one turn. 0 disables proactive creation but not explicit requests.";
/** 選択したデータベース項目をリセットする操作の表示名。 */
export const SETTINGS_RESET_DATABASE_LABEL = "Reset database";
/** アプリ設定を含み得る破壊的なリセット操作であることを警告する。 */
export const SETTINGS_RESET_DATABASE_HELP =
  "Danger zone: reset selected database content, including app settings.";
/** 最終活動日を基準に古いセッションを削除する設定の表示名。 */
export const SETTINGS_DELETE_OLD_SESSIONS_LABEL = "Delete Old Sessions";
/** 指定日より前が対象で、実行中のセッションは残ることを伝える。 */
export const SETTINGS_DELETE_OLD_SESSIONS_HELP =
  "Delete sessions last active before the selected date. Running sessions are kept.";
/** ログやクラッシュダンプの参照操作をまとめる診断節の見出し。 */
export const SETTINGS_DIAGNOSTICS_LABEL = "Diagnostics";
/** アプリケーションログの保存先を開く操作の表示名。 */
export const SETTINGS_OPEN_LOG_FOLDER_LABEL = "Open Logs";
/** クラッシュダンプの保存先を開く操作の表示名。 */
export const SETTINGS_OPEN_CRASH_DUMP_FOLDER_LABEL = "Open Crash Dumps";
/** リセット対象 ID に対応する、確認と結果表示用の名称。 */
export const SETTINGS_RESET_DATABASE_TARGET_LABELS: Record<
  ResetAppDatabaseTarget,
  string
> = {
  sessions: "Sessions",
  appSettings: "App settings",
};

/** 正規化したリセット対象を表示名で列挙し、有効な対象がない場合は未選択と示す。 */
export function describeResetDatabaseTargets(
  targets: readonly ResetAppDatabaseTarget[],
): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  if (normalized.length === 0) {
    return "None";
  }

  return normalized
    .map((target) => SETTINGS_RESET_DATABASE_TARGET_LABELS[target])
    .join(" / ");
}

/** リセットの確認文を作る。全対象なら DB とキャラクターファイル本文の再作成、部分選択なら本文の保持を案内する。 */
export function buildResetDatabaseConfirmMessage(
  targets: readonly ResetAppDatabaseTarget[],
): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const lines = [
    `Reset the following: ${describeResetDatabaseTargets(normalized)}.`,
    "Running sessions must finish before the reset can run.",
  ];

  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    lines.splice(
      1,
      0,
      "All targets are selected. The database file, including local pull requests, will be recreated along with character file bodies and schema.",
    );
  } else {
    lines.splice(1, 0, "Character file bodies will be preserved.");
  }

  lines.push("Continue?");
  return lines.join("\n\n");
}

/** リセット後の対象を列挙し、キャラクターファイル本文をリセットしたか保持したかを明示する。 */
export function buildResetDatabaseSuccessMessage(
  targets: readonly ResetAppDatabaseTarget[],
): string {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  const targetSummary = describeResetDatabaseTargets(normalized);
  if (areAllResetAppDatabaseTargetsSelected(normalized)) {
    return `Reset ${targetSummary}, including the database and character file bodies.`;
  }

  return `Reset ${targetSummary}. Character file bodies were preserved.`;
}

/** 境界日、実行中セッションの保持、削除対象の補助会話も消えることを確認文に含める。 */
export function buildDeleteOldSessionsConfirmMessage(
  cutoffDate: string,
): string {
  return [
    `Delete sessions last active before ${cutoffDate}.`,
    "Running sessions will be kept.",
    "Aux conversations of deleted sessions will also be deleted.",
    "Continue?",
  ].join("\n\n");
}

/** 削除件数と実行中のため保持した件数を区別する。どちらも 0 件なら対象なしと表示する。 */
export function buildDeleteOldSessionsSuccessMessage(
  result: DeleteSessionsResult,
): string {
  const deletedCount = result.deletedSessionIds.length;
  const skippedCount = result.skippedRunningSessionIds.length;
  if (deletedCount === 0 && skippedCount === 0) {
    return "No sessions matched the cleanup date.";
  }

  const deletedLabel = `${deletedCount} old session${deletedCount === 1 ? "" : "s"} deleted.`;
  const skippedSuffix =
    skippedCount > 0
      ? ` Kept ${skippedCount} running session${skippedCount === 1 ? "" : "s"}.`
      : "";
  return `${deletedLabel}${skippedSuffix}`.trim();
}

export { ALL_RESET_APP_DATABASE_TARGETS };
