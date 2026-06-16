import type { HomeMonitorEntry } from "./home-session-projection.js";
import { CharacterAvatar } from "../ui-utils.js";

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  onOpenSession,
  onOpenCompanionReview,
}: HomeMonitorContentProps) {
  const companionGroupMarkerClassName = (groupId: string): string => {
    let hash = 0;
    for (let index = 0; index < groupId.length; index += 1) {
      hash = (hash * 31 + groupId.charCodeAt(index)) >>> 0;
    }
    return `companion-group-${hash % 6}`;
  };

  const renderMonitorEntries = (entries: HomeMonitorEntry[]) => {
    return entries.map((entry) => {
      if (entry.kind === "companion") {
        const { session, state } = entry;
        const groupClassName = companionGroupMarkerClassName(session.groupId);
        return (
          <button
            key={`companion-${session.id}`}
            className={`home-monitor-row companion ${groupClassName}`}
            type="button"
            onClick={() => onOpenCompanionReview(session.id)}
          >
            <CharacterAvatar
              character={{ name: session.character, iconPath: session.characterIconPath }}
              size="tiny"
              className="home-monitor-avatar"
            />
            <div className="home-monitor-row-copy">
              <strong>{session.taskTitle}</strong>
              <span>{entry.groupLabel}</span>
            </div>
            <div className="home-monitor-row-badges">
              <span className="session-mode-badge companion">Companion</span>
              <span className={`home-monitor-group-chip ${groupClassName}`} aria-label="同じ Companion group の目印" />
              <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
            </div>
          </button>
        );
      }

      const { session, state } = entry;
      return (
        <button
          key={`agent-${session.id}`}
          className="home-monitor-row"
          type="button"
          onClick={() => onOpenSession(session.id)}
        >
          <CharacterAvatar
            character={{ name: session.character, iconPath: session.characterIconPath }}
            size="tiny"
            className="home-monitor-avatar"
          />
          <div className="home-monitor-row-copy">
            <strong>{session.taskTitle}</strong>
            <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
          </div>
          <div className="home-monitor-row-badges">
            <span className="session-mode-badge agent">Agent</span>
            <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
          </div>
        </button>
      );
    });
  };

  return (
    <div className="home-monitor-body">
      <section className="home-monitor-section" aria-labelledby="home-monitor-running">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-running">実行中</h3>
          <span className="home-monitor-count">{runningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {runningEntries.length > 0 ? (
            renderMonitorEntries(runningEntries)
          ) : null}
        </div>
      </section>

      <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-inactive">停止・完了</h3>
          <span className="home-monitor-count">{nonRunningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {nonRunningEntries.length > 0 ? (
            renderMonitorEntries(nonRunningEntries)
          ) : null}
        </div>
      </section>
    </div>
  );
}
