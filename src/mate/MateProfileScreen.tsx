import type { ReactNode } from "react";

type MateProfileScreenProps = {
  homePageClassName: string;
  content: ReactNode;
};

export function MateProfileScreen({ homePageClassName, content }: MateProfileScreenProps) {
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
