import type { ReactNode } from "react";

type SettingsWindowScreenProps = {
  homePageClassName: string;
  ready: boolean;
  content: ReactNode;
};

export function SettingsWindowScreen({ homePageClassName, ready, content }: SettingsWindowScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="settings-window-shell">
        {ready ? (
          content
        ) : (
          <div className="settings-loading-state" role="status" aria-label="Loading settings">
            <span className="settings-action-spinner" aria-hidden="true" />
          </div>
        )}
      </main>
    </div>
  );
}
