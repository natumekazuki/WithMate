import type { ReactNode } from "react";

import type { HomeMonitorEntry } from "./home-session-projection.js";
import type { MateProfile } from "../mate/mate-state.js";
import { buildCardThemeStyle, CharacterAvatar } from "../ui-utils.js";
import { HomeMonitorContent } from "./HomeMonitorContent.js";

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "mate";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorWindowIcon: ReactNode;
  mateProfile: MateProfile | null;
  onChangeRightPaneView: (view: "monitor" | "mate") => void;
  onOpenSessionMonitorWindow: () => void;
  onOpenMemoryManagementWindow: () => void;
  onOpenSettingsWindow: () => void;
  onOpenMateProfile: () => void;
  onOpenMateTalk: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
};

export function HomeRightPane({
  rightPaneView,
  runningMonitorEntries,
  nonRunningMonitorEntries,
  monitorWindowIcon,
  mateProfile,
  onChangeRightPaneView,
  onOpenSessionMonitorWindow,
  onOpenMemoryManagementWindow,
  onOpenSettingsWindow,
  onOpenMateProfile,
  onOpenMateTalk,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
}: HomeRightPaneProps) {
  const mateDisplayName = mateProfile?.displayName ?? "Your Mate";
  const mateDescription = mateProfile?.description?.trim() ?? "";
  const mateThemeStyle = buildCardThemeStyle({
    main: mateProfile?.themeMain ?? "#3e4b65",
    sub: mateProfile?.themeSub ?? "#7b8fb0",
  });
  const openSessionMonitorWindow = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSessionMonitorWindow();
  };
  const openMemoryManagementWindow = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenMemoryManagementWindow();
  };
  const openMateProfile = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenMateProfile();
  };
  const openMateTalk = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenMateTalk();
  };
  const openSession = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenSession(sessionId);
  };
  const openCompanionReview = (sessionId: string) => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenCompanionReview(sessionId);
  };

  return (
    <section className="panel home-right-pane rise-3">
      <div className="home-settings-rail">
        <div className="home-settings-actions">
          <button
            className="launch-toggle home-monitor-window-button"
            type="button"
            aria-label="Session Monitor Window を開く"
            title="Session Monitor Window"
            onClick={openSessionMonitorWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            {monitorWindowIcon}
          </button>
          <button
            className="launch-toggle home-settings-button"
            type="button"
            onClick={openMemoryManagementWindow}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            Memory
          </button>
          <button className="launch-toggle home-settings-button" type="button" onClick={onOpenSettingsWindow}>
            Settings
          </button>
          <button
            className="launch-toggle home-settings-button"
            type="button"
            onClick={openMateTalk}
            aria-disabled={!canUsePrimaryFeatures}
            disabled={!canUsePrimaryFeatures}
          >
            メイトーク
          </button>
        </div>
        <div className="home-pane-toggle" role="tablist" aria-label="Home right pane">
          <button
            className={`home-pane-toggle-button ${rightPaneView === "monitor" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "monitor"}
            onClick={() => onChangeRightPaneView("monitor")}
          >
            Monitor
          </button>
          <button
            className={`home-pane-toggle-button ${rightPaneView === "mate" ? "active" : ""}`.trim()}
            type="button"
            role="tab"
            aria-selected={rightPaneView === "mate"}
            onClick={() => onChangeRightPaneView("mate")}
          >
            Your Mate
          </button>
        </div>
      </div>

      {rightPaneView === "monitor" ? (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Session Monitor">
          <HomeMonitorContent
            runningEntries={runningMonitorEntries}
            nonRunningEntries={nonRunningMonitorEntries}
            onOpenSession={openSession}
            onOpenCompanionReview={openCompanionReview}
          />
        </section>
      ) : (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Your Mate" style={mateThemeStyle}>
          <div className="home-monitor-section home-mate-card">
            <div className="home-monitor-section-head">
              <h3>Your Mate</h3>
            </div>
            <div className="home-mate-card-body">
              <CharacterAvatar
                character={{ name: mateDisplayName, iconPath: mateProfile?.avatarFilePath ?? "" }}
                size="large"
              />
              <strong>{mateDisplayName}</strong>
              {mateDescription ? <p>{mateDescription}</p> : null}
              <div className="home-monitor-actions">
                <button className="launch-toggle" type="button" onClick={openMateProfile} disabled={!canUsePrimaryFeatures}>
                  Mate を編集
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
