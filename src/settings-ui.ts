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
export const SETTINGS_RELEASE_COMPATIBILITY_NOTE =
  "初回リリース前のため後方互換性は考慮しない。互換性のない変更が入った場合は Settings の DB 初期化で復旧する。";
export const SETTINGS_RESET_DATABASE_LABEL = "DB を初期化";
export const SETTINGS_RESET_DATABASE_HELP =
  "互換性のない変更に追従できなくなったら、Settings の Danger Zone から DB を初期化して sessions / audit logs / app settings / model catalog を bundled の初期状態へ戻す。characters は保持される。";
export const SETTINGS_RESET_DATABASE_CONFIRM_MESSAGE = [
  "DB を初期化すると、sessions / audit logs / app settings / model catalog を bundled の初期状態へ戻すよ。",
  "characters は DB 外ファイルなので保持されるよ。",
  "実行中の session がある間は初期化できないよ。",
  "本当に続ける？",
].join("\n\n");
export const SETTINGS_RESET_DATABASE_SUCCESS_MESSAGE =
  "DB を初期化して、sessions / audit logs / app settings / model catalog を初期状態へ戻したよ。characters は保持したよ。";
