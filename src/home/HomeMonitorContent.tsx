import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";

import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../withmate-window-types.js";
import type {
  HomeMonitorAuxiliaryDataState,
  HomeMonitorEntry,
  HomeSessionState,
} from "./home-session-projection.js";
import { CharacterAvatar } from "../ui-utils.js";

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  auxiliaryDataState?: HomeMonitorAuxiliaryDataState;
  feedback?: string;
  onOpenSession: (sessionId: string, auxiliarySessionId?: string) => void;
  onOpenCompanionReview: (sessionId: string, auxiliarySessionId?: string) => void;
  onShowContextMenu: (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => void;
};

type HomeMonitorStatusKind = HomeSessionState["kind"] | "loading" | "closed";

function getEntryKey(entry: HomeMonitorEntry): string {
  return `${entry.kind}:${entry.session.id}`;
}

function getAuxiliaryStatus(summary: HomeMonitorEntry["auxiliarySessions"][number]): {
  kind: HomeMonitorStatusKind;
  label: string;
} {
  if (summary.runState === "running") {
    return { kind: "running", label: "実行中" };
  }
  if (summary.runState === "error") {
    return { kind: "error", label: "エラー" };
  }
  if (summary.status === "closed") {
    return { kind: "closed", label: "終了" };
  }
  return { kind: "neutral", label: "待機" };
}

function MonitorStatusIcon({
  kind,
  label,
  count,
}: {
  kind: HomeMonitorStatusKind;
  label: string;
  count?: number;
}) {
  return (
    <span className={`home-monitor-status-icon ${kind}`} aria-label={count === undefined ? label : `${label} ${count}件`}>
      <span className="home-monitor-status-icon-mark" aria-hidden="true" />
      {count === undefined ? null : <span className="home-monitor-status-icon-count">: {count}</span>}
    </span>
  );
}

function renderAuxiliaryStatusIcons(entry: HomeMonitorEntry) {
  const summaries = entry.auxiliarySessions;
  const groups = [
    { kind: "running" as const, label: "実行中" },
    { kind: "error" as const, label: "エラー" },
    { kind: "neutral" as const, label: "待機" },
    { kind: "closed" as const, label: "終了" },
  ].map((group) => ({
    ...group,
    count: summaries.filter((summary) => getAuxiliaryStatus(summary).kind === group.kind).length,
  })).filter((group) => group.count > 0);

  return (
    <span className="home-monitor-status-cluster home-monitor-auxiliary-status" aria-label="Auxiliaryの状態">
      <span className="home-monitor-status-label">Aux</span>
      {groups.map((group) => (
        <MonitorStatusIcon
          key={group.kind}
          kind={group.kind}
          label={`Auxiliary ${group.label}`}
          count={group.count}
        />
      ))}
    </span>
  );
}

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  auxiliaryDataState = "ready",
  feedback = "",
  onOpenSession,
  onOpenCompanionReview,
  onShowContextMenu,
}: HomeMonitorContentProps) {
  const [expandedEntryKeys, setExpandedEntryKeys] = useState<Set<string>>(() => new Set());

  const toggleEntry = (entry: HomeMonitorEntry) => {
    const key = getEntryKey(entry);
    setExpandedEntryKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const showEntryContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: HomeMonitorEntry,
  ) => {
    event.preventDefault();
    if (entry.kind === "companion" && !entry.isWindowOpen) {
      return;
    }
    onShowContextMenu(entry.kind, entry.session.id, {
      x: Math.max(0, Math.round(event.clientX)),
      y: Math.max(0, Math.round(event.clientY)),
    });
  };

  const showEntryContextMenuFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    entry: HomeMonitorEntry,
  ) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) {
      return;
    }
    event.preventDefault();
    if (entry.kind === "companion" && !entry.isWindowOpen) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    onShowContextMenu(entry.kind, entry.session.id, {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.bottom)),
    });
  };

  const renderMonitorEntries = (entries: HomeMonitorEntry[]) => entries.map((entry) => {
    const auxiliarySessions = entry.auxiliarySessions;
    const entryKey = getEntryKey(entry);
    const isExpanded = expandedEntryKeys.has(entryKey);
    const canExpand = auxiliarySessions.length > 0;
    const title = entry.session.taskTitle || entry.session.id;
    const openParent = () => {
      if (entry.kind === "companion") {
        onOpenCompanionReview(entry.session.id);
      } else {
        onOpenSession(entry.session.id);
      }
    };

    return (
      <div
        key={entryKey}
        className={`home-monitor-card${entry.kind === "companion" ? ` companion ${companionGroupMarkerClassName(entry.session.groupId)}` : ""}`}
        onContextMenu={(event) => showEntryContextMenu(event, entry)}
      >
        <div className="home-monitor-parent-row">
          {canExpand ? (
            <button
              className="home-monitor-disclosure"
              type="button"
              aria-label={`${title} のAuxiliary一覧を${isExpanded ? "閉じる" : "開く"}`}
              aria-expanded={isExpanded}
              onClick={() => toggleEntry(entry)}
            >
              <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
            </button>
          ) : (
            <span className="home-monitor-disclosure-placeholder" aria-hidden="true" />
          )}
          <button
            className="home-monitor-parent-button"
            type="button"
            onClick={openParent}
            onKeyDown={(event) => showEntryContextMenuFromKeyboard(event, entry)}
            aria-haspopup={entry.kind === "agent" || entry.isWindowOpen ? "menu" : undefined}
            aria-label={`${entry.kind === "companion" ? "Companion Reviewを開く" : "Sessionを開く"}: ${title}`}
          >
            <CharacterAvatar
              character={{ name: entry.session.character, iconPath: entry.session.characterIconPath }}
              size="tiny"
              className="home-monitor-avatar"
            />
            <strong className="home-monitor-parent-title">{title}</strong>
          </button>
        </div>
        <div className="home-monitor-summary-row">
          <span className="home-monitor-status-cluster" aria-label={`Mainの状態: ${entry.mainState.label}`}>
            <span className="home-monitor-status-label">Main</span>
            <MonitorStatusIcon kind={entry.mainState.kind} label={`Main ${entry.mainState.label}`} />
          </span>
          {auxiliarySessions.length > 0 ? (
            <>
              <span className="home-monitor-summary-separator" aria-hidden="true" />
              {renderAuxiliaryStatusIcons(entry)}
            </>
          ) : null}
        </div>
        {isExpanded ? (
          <div className="home-monitor-auxiliary-list" aria-label={`${title} のAuxiliary一覧`}>
            {auxiliarySessions.map((summary) => {
              const status = getAuxiliaryStatus(summary);
              const preview = summary.preview?.trim() || "新しい会話";
              const openAuxiliary = () => {
                if (entry.kind === "companion") {
                  onOpenCompanionReview(entry.session.id, summary.id);
                } else {
                  onOpenSession(entry.session.id, summary.id);
                }
              };
              return (
                <button
                  key={summary.id}
                  className="home-monitor-auxiliary-row"
                  type="button"
                  onClick={openAuxiliary}
                  aria-label={`Auxiliaryを開く: ${preview}`}
                >
                  <CharacterAvatar
                    character={{ name: "", iconPath: summary.characterIconPath ?? "" }}
                    size="tiny"
                    className="home-monitor-auxiliary-avatar"
                  />
                  <span className="home-monitor-auxiliary-preview">{preview}</span>
                  <MonitorStatusIcon kind={status.kind} label={`Auxiliary ${status.label}`} />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  });

  const statusFeedback = feedback || (
    auxiliaryDataState === "loading"
      ? "Auxiliaryを確認中…"
      : auxiliaryDataState === "error"
        ? "Auxiliaryの読み込みに失敗したよ。"
        : ""
  );

  return (
    <div className="home-monitor-body">
      {statusFeedback ? (
        <p className="settings-feedback" role="status" aria-live="polite">
          {statusFeedback}
        </p>
      ) : null}
      <section className="home-monitor-section" aria-labelledby="home-monitor-running">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-running">実行中</h3>
          <span className="home-monitor-count">{runningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {runningEntries.length > 0 ? renderMonitorEntries(runningEntries) : null}
        </div>
      </section>

      <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
        <div className="home-monitor-section-head">
          <h3 id="home-monitor-inactive">停止・完了</h3>
          <span className="home-monitor-count">{nonRunningEntries.length}</span>
        </div>
        <div className="home-monitor-list">
          {nonRunningEntries.length > 0 ? renderMonitorEntries(nonRunningEntries) : null}
        </div>
      </section>
    </div>
  );
}

function companionGroupMarkerClassName(groupId: string): string {
  let hash = 0;
  for (let index = 0; index < groupId.length; index += 1) {
    hash = (hash * 31 + groupId.charCodeAt(index)) >>> 0;
  }
  return `companion-group-${hash % 6}`;
}
