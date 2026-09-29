import type { ReactNode } from "react";

type SettingsWindowScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

export function SettingsWindowScreen({ homePageClassName, content }: SettingsWindowScreenProps) {
  return (
    <div className={`${homePageClassName} home-page-settings-window`.trim()}>
      <main className="settings-window-shell">
        {content}
      </main>
    </div>
  );
}
