export const WITHMATE_BACKGROUND_LAUNCH_ARG = "--background";
export const WITHMATE_APP_USER_MODEL_ID = "com.natumekazuki.withmate";

type AppUserModelIdContext = {
  isPackaged: boolean;
  execPath: string;
};

type LoginItemAppLike = {
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args?: string[];
  }): void;
};

export function shouldLaunchInBackground(argv: readonly string[]): boolean {
  return argv.includes(WITHMATE_BACKGROUND_LAUNCH_ARG);
}

export function resolveAppUserModelId(context: AppUserModelIdContext): string {
  return context.isPackaged ? WITHMATE_APP_USER_MODEL_ID : context.execPath;
}

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
