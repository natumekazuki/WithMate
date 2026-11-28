import {
  useId,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionMonitorContextMenuPoint } from "../../src-shared/window/withmate-window-types.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import {
  getHomeAuxiliarySessionState,
  HOME_SESSION_FAILURE_STATE,
  type HomeSessionState,
} from "./home-session-projection.js";

/** 状態をアイコンで示し、件数や内訳があれば同じ意味を読み上げ名とツールチップに付ける。 */
export function MonitorStatusIcon({
  kind,
  label,
  count,
  description,
}: {
  kind: HomeSessionState["kind"];
  label: string;
  count?: number;
  description?: string;
}) {
  const accessibleText =
    description ?? (count === undefined ? label : `${label}: ${count}`);
  return (
    <span
      className={`home-monitor-status-icon ${kind}`}
      role="img"
      aria-label={accessibleText}
      title={accessibleText}
    >
      <span className="home-monitor-status-icon-mark" aria-hidden="true" />
      {count === undefined ? null : (
        <span className="home-monitor-status-icon-count">: {count}</span>
      )}
    </span>
  );
}

/** 一つの Main と関連 Auxiliary の表示状態、および Main・Auxiliary を別々に開く操作。 */
type HomeSessionCardProps = {
  session: HomeSessionSummary;
  mainState: HomeSessionState;
  auxiliarySessions: readonly AuxiliarySessionSummary[];
  auxiliaryExpanded: boolean;
  onToggleAuxiliary: () => void;
  onOpenMain: () => void;
  onOpenAuxiliary: (auxiliarySessionId: string) => void;
  onShowContextMenu: (point: SessionMonitorContextMenuPoint) => void;
  coordinationPrimary?: boolean;
  isWindowOpen?: boolean;
  mainDisclosure?: ReactNode;
};

/** Main の状態と未読を示し、配下の Auxiliary は集計表示から個別の行へ展開できるようにする。 */
export function HomeSessionCard({
  session,
  mainState,
  auxiliarySessions,
  auxiliaryExpanded,
  onToggleAuxiliary,
  onOpenMain,
  onOpenAuxiliary,
  onShowContextMenu,
  coordinationPrimary,
  isWindowOpen,
  mainDisclosure,
}: HomeSessionCardProps) {
  const auxiliaryId = useId();
  const title = session.taskTitle || session.id;
  const mainUnread = session.hasUnreadResult === true;
  const auxiliaryUnread = auxiliarySessions.some(
    (summary) => summary.hasUnreadResult,
  );
  const discloseAuxiliary = `${auxiliaryExpanded ? "Hide" : "Show"} Auxiliary sessions for ${title}`;
  const windowState =
    isWindowOpen === undefined
      ? ""
      : `Window ${isWindowOpen ? "Open" : "Closed"}`;
  const mainLabel = coordinationPrimary
    ? `Open Coordination for ${title}`
    : `${isWindowOpen ? "Focus Session" : isWindowOpen === false ? "Open Session" : "Open session"}: ${title}` +
      (windowState ? `; ${windowState}; Main ${mainState.label}` : "") +
      (mainUnread ? "; Unread Result" : "");
  const auxCounts = [
    { kind: "approval" as const, label: "Attention" },
    { kind: "running" as const, label: "Running" },
    { kind: "running" as const, label: "Canceling" },
    { kind: "running" as const, label: "Waiting For Stop" },
    HOME_SESSION_FAILURE_STATE,
    { kind: "neutral" as const, label: "Idle" },
  ]
    .map((group) => ({
      ...group,
      count: auxiliarySessions.filter(
        (summary) =>
          getHomeAuxiliarySessionState(summary).label === group.label,
      ).length,
    }))
    .filter((group) => group.count > 0);
  const auxDetails = windowState
    ? `; ${auxCounts.map(({ label, count }) => `${label}: ${count}`).join(", ")}`
    : "";

  /** 受け付けたメニュー操作を、ポインター座標またはキー操作元の行の位置とともに通知する。 */
  const showMenu = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => {
    if ("key" in event) {
      // Chromium はコンテキストメニューキーで contextmenu を発火する。Crew はそのイベントを一度だけ処理する。
      const contextMenuKey = event.key === "ContextMenu" && !windowState;
      if (!contextMenuKey && !(event.key === "F10" && event.shiftKey)) return;
    }
    event.preventDefault();
    const rect = (
      "key" in event ? (event.target as HTMLElement) : event.currentTarget
    ).getBoundingClientRect();
    onShowContextMenu({
      x: Math.max(
        0,
        Math.round("clientX" in event ? event.clientX : rect.left),
      ),
      y: Math.max(
        0,
        Math.round("clientY" in event ? event.clientY : rect.bottom),
      ),
    });
  };

  const auxiliaryDisclosure = auxiliarySessions.length ? (
    <button
      className={`home-monitor-disclosure${auxiliaryUnread ? " has-unread-result" : ""}`}
      type="button"
      aria-label={`${discloseAuxiliary}${auxDetails}${auxiliaryUnread ? "; Unread Result" : ""}`}
      title={discloseAuxiliary + auxDetails}
      aria-expanded={auxiliaryExpanded}
      aria-controls={auxiliaryExpanded ? auxiliaryId : undefined}
      onClick={onToggleAuxiliary}
    >
      <ComposerIcon name="auxiliary" />
      <span
        className="home-monitor-status-cluster home-monitor-auxiliary-status"
        aria-label="Auxiliary status"
      >
        {auxCounts.map((group) => (
          <MonitorStatusIcon
            key={group.label}
            kind={group.kind}
            label={`Auxiliary ${group.label}`}
            count={group.count}
          />
        ))}
      </span>
      <span aria-hidden="true">{auxiliaryExpanded ? "▾" : "▸"}</span>
    </button>
  ) : null;

  return (
    <div
      className="home-monitor-card"
      onContextMenu={windowState ? undefined : showMenu}
    >
      <div
        className="home-monitor-parent-row"
        onContextMenu={windowState ? showMenu : undefined}
        onKeyDown={windowState ? showMenu : undefined}
      >
        <div
          className="home-monitor-parent-identity"
          role="group"
          aria-label={`Main session: ${title}`}
        >
          <span
            className="home-monitor-status-cluster"
            aria-label={`Main status: ${mainState.label}`}
          >
            <MonitorStatusIcon
              kind={mainState.kind}
              label={`Main ${mainState.label}`}
            />
          </span>
          <button
            className={`home-monitor-parent-button${mainUnread ? " has-unread-result" : ""}`}
            type="button"
            onClick={onOpenMain}
            onKeyDown={windowState ? undefined : showMenu}
            aria-haspopup="menu"
            aria-label={mainLabel}
            title={windowState ? `${title} — ${windowState}` : title}
          >
            <CharacterAvatar
              character={{
                name: session.character,
                iconPath: session.characterIconPath,
              }}
              size="tiny"
              className="home-monitor-avatar"
            />
            <strong className="home-monitor-parent-title">{title}</strong>
          </button>
        </div>
        {mainDisclosure && auxiliaryDisclosure ? (
          <div className="home-crew-disclosures">
            {mainDisclosure}
            {auxiliaryDisclosure}
          </div>
        ) : (
          (mainDisclosure ?? auxiliaryDisclosure)
        )}
      </div>
      {auxiliaryExpanded ? (
        <div
          className="home-monitor-auxiliary-list"
          id={auxiliaryId}
          aria-label={`Auxiliary sessions for ${title}`}
        >
          {auxiliarySessions.map((summary, index) => {
            const status = getHomeAuxiliarySessionState(summary);
            const preview = summary.preview?.trim() ?? "";
            return (
              <button
                key={summary.id}
                className={`home-monitor-auxiliary-row${summary.hasUnreadResult ? " has-unread-result" : ""}`}
                type="button"
                onClick={() => onOpenAuxiliary(summary.id)}
                aria-label={`${preview ? `Open Auxiliary: ${preview}` : `Open Auxiliary ${index + 1}`}${summary.hasUnreadResult ? "; Unread Result" : ""}${windowState ? `; ${status.label}` : ""}`}
              >
                <CharacterAvatar
                  character={{
                    name: "",
                    iconPath: summary.characterIconPath ?? "",
                  }}
                  size="tiny"
                  className="home-monitor-auxiliary-avatar"
                />
                <span className="home-monitor-auxiliary-preview">
                  {preview}
                </span>
                <MonitorStatusIcon
                  kind={status.kind}
                  label={`Auxiliary ${status.label}`}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
