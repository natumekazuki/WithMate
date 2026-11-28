import type { ReactNode } from "react";

/** プロフィール画面の外枠に重ねる Home のクラスと、パネル内に表示する内容。 */
type MateProfileScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

/** Mate プロフィールの内容を、設定ウィンドウ用の Home レイアウトに収める。 */
export function MateProfileScreen({
  homePageClassName,
  content,
}: MateProfileScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="home-layout home-layout-settings-window">
        <section className="launch-dialog settings-dialog home-mate-setup-shell">
          {content}
        </section>
      </main>
    </div>
  );
}
