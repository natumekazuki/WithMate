import type { ReactNode } from "react";

type MemoryManagementWindowScreenProps = {
  homePageClassName: string;
  loaded: boolean;
  content: ReactNode;
};

export function MemoryManagementWindowScreen({ homePageClassName, loaded, content }: MemoryManagementWindowScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="home-layout home-layout-settings-window">
        <section className="launch-dialog settings-dialog panel settings-window-shell memory-window-shell">
          {loaded ? (
            content
          ) : (
            <div className="settings-loading-state">
              <p>Memory 管理を読み込み中...</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
