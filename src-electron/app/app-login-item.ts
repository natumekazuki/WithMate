/** ログイン項目から Home を開かずに起動するときに渡す引数。 */
export const WITHMATE_BACKGROUND_LAUNCH_ARG = "--background";
/** パッケージ版の Windows アプリ識別に使う固定の AppUserModelID。 */
export const WITHMATE_APP_USER_MODEL_ID = "com.natumekazuki.withmate";

/** パッケージ版と開発起動で異なる AppUserModelID を選ぶための情報。 */
type AppUserModelIdContext = {
  isPackaged: boolean;
  execPath: string;
};

/** OS のログイン項目を変更するために必要な Electron アプリの操作。 */
type LoginItemAppLike = {
  /** ログイン時の起動有無と、登録する起動引数を更新する。 */
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args?: string[];
  }): void;
};

/** 起動引数に完全一致するバックグラウンド起動フラグがあるかを返す。 */
export function shouldLaunchInBackground(argv: readonly string[]): boolean {
  return argv.includes(WITHMATE_BACKGROUND_LAUNCH_ARG);
}

/** パッケージ版では固定の製品 ID、開発起動では実行ファイルのパスを返す。 */
export function resolveAppUserModelId(context: AppUserModelIdContext): string {
  return context.isPackaged ? WITHMATE_APP_USER_MODEL_ID : context.execPath;
}

/** パッケージ版だけでログイン起動を更新し、有効時はバックグラウンド起動を指定する。 */
export function applyLaunchAtLoginSetting(
  app: LoginItemAppLike,
  enabled: boolean,
  isPackaged: boolean,
): void {
  if (!isPackaged) {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? [WITHMATE_BACKGROUND_LAUNCH_ARG] : [],
  });
}
