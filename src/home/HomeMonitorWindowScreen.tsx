import type { ReactNode } from "react";

/** 独立 Monitor の外枠に使うクラスと、監視パネルとして表示する内容。 */
type HomeMonitorWindowScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

/** 監視の内容を、Home の一覧を含まない独立 Monitor レイアウトに配置する。 */
export function HomeMonitorWindowScreen({
  homePageClassName,
  content,
}: HomeMonitorWindowScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout home-layout-monitor-window">
        <section
          className="home-monitor-panel compact"
          aria-label="Session monitor"
        >
          {content}
        </section>
      </main>
    </div>
  );
}
