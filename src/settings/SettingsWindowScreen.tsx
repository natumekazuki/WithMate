import type { ReactNode } from "react";

/** ウィンドウに適用する Home のクラスと、設定の本体として描画する内容。 */
type SettingsWindowScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

/** 設定の内容を独立したウィンドウ用のレイアウトに配置する。 */
export function SettingsWindowScreen({
  homePageClassName,
  content,
}: SettingsWindowScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="settings-window-shell">{content}</main>
    </div>
  );
}
