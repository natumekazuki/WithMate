import type { ReactNode } from "react";

type SettingsWindowScreenProps = {
  homePageClassName: string;
  ready: boolean;
  content: ReactNode;
};

export function SettingsWindowScreen({ homePageClassName, ready, content }: SettingsWindowScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="home-layout home-layout-settings-window">
        <section className="launch-dialog settings-dialog panel settings-window-shell">
          {ready ? (
            content
          ) : (
            <div className="settings-loading-state">
              <p>Settings を読み込み中...</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
