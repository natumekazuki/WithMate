import type { ReactNode } from "react";

type HomeMonitorWindowScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

export function HomeMonitorWindowScreen({ homePageClassName, content }: HomeMonitorWindowScreenProps) {
  return (
    <div className={homePageClassName}>
      <main className="home-layout home-layout-monitor-window">
        <section className="panel home-monitor-window-panel rise-3">
          <section className="home-monitor-panel compact" aria-label="Session Monitor">
            {content}
          </section>
        </section>
      </main>
    </div>
  );
}
