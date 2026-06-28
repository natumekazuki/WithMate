export const WITHMATE_BACKGROUND_LAUNCH_ARG = "--background";

type LoginItemAppLike = {
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args?: string[];
  }): void;
};

export function shouldLaunchInBackground(argv: readonly string[]): boolean {
  return argv.includes(WITHMATE_BACKGROUND_LAUNCH_ARG);
}

export function applyLaunchAtLoginSetting(app: LoginItemAppLike, enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? [WITHMATE_BACKGROUND_LAUNCH_ARG] : [],
  });
}
