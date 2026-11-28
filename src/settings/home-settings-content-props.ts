import type { HomeSettingsContentProps } from "./SettingsContent.js";

/** 設定画面に渡す値と操作の組を、呼び出し側でも同じ型で扱う。 */
export type HomeSettingsContentBaseProps = HomeSettingsContentProps;

/** 設定画面に渡す props を組み立てる。各値とコールバックは置き換えない。 */
export const buildHomeSettingsContentProps = (
  input: HomeSettingsContentBaseProps,
): HomeSettingsContentProps => ({
  ...input,
});
