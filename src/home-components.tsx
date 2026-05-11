import { useRef, type ReactNode } from "react";

import type { SessionSummary } from "./app-state.js";
import type { CompanionSessionSummary } from "./companion-state.js";
import type { LaunchWorkspace } from "./home-launch-projection.js";
import { getHomeCompanionSessionState, type HomeMonitorEntry, type HomeSessionState } from "./home-session-projection.js";
import { focusRovingItemByKey, useDialogA11y } from "./a11y.js";
import { buildCardThemeStyle, CharacterAvatar } from "./ui-utils.js";
import type { MateProfile } from "./mate/mate-state.js";

export type HomeLaunchDialogProps = {
  open: boolean;
  mode: "session" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
  launchWorkspacePathLabel: string;
  enabledLaunchProviders: Array<{ id: string; label: string }>;
  selectedLaunchProviderId: string | null;
  canStartSession: boolean;
  launchFeedback: string;
  launchStarting: boolean;
  onClose: () => void;
  onSelectMode: (mode: "session" | "companion") => void;
  onChangeTitle: (value: string) => void;
  onBrowseWorkspace: () => void;
  onSelectProvider: (providerId: string) => void;
  onStartSession: (mode: "session" | "companion") => void;
};

export function HomeLaunchDialog({
  open,
  mode,
  title,
  workspace,
  launchWorkspacePathLabel,
  enabledLaunchProviders,
  selectedLaunchProviderId,
  canStartSession,
  launchFeedback,
  launchStarting,
  onClose,
  onSelectMode,
  onChangeTitle,
  onBrowseWorkspace,
  onSelectProvider,
  onStartSession,
}: HomeLaunchDialogProps) {
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: titleInputRef,
  });

  if (!open) {
    return null;
  }

  return (
    <div className="launch-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="launch-dialog panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="launch-dialog-head minimal">
          <button className="diff-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="launch-panel minimal">
          <section className="launch-section minimal">
            <div
              className="choice-list launch-provider-list"
              role="tablist"
              aria-label="Session mode"
              onKeyDown={(event) => {
                focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
              }}
            >
              {[
                { value: "session" as const, label: "Agent Mode" },
                { value: "companion" as const, label: "Companion Mode" },
              ].map((option) => (
                <button
                  key={option.value}
                  className={`choice-chip${mode === option.value ? " active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={mode === option.value}
                  tabIndex={mode === option.value ? 0 : -1}
                  onClick={() => onSelectMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-session-title">
                セッションタイトル
              </label>
              <input
                id="launch-session-title"
                ref={titleInputRef}
                className="launch-field-input"
                type="text"
                value={title}
                onChange={(event) => onChangeTitle(event.target.value)}
              />
            </div>
          </section>

          <section className="launch-section workspace-picker minimal">
            <div className="section-head compact-actions">
              <button className="browse-button" type="button" onClick={onBrowseWorkspace}>
                Browse
              </button>
            </div>
            <p className={`launch-path${workspace ? " selected" : ""}`}>{launchWorkspacePathLabel}</p>
          </section>

          <section className="launch-section minimal">
            <div className="launch-field">
              <label className="launch-field-label" htmlFor="launch-provider-picker">
                Coding Provider
              </label>
              {enabledLaunchProviders.length > 0 ? (
                <div
                  id="launch-provider-picker"
                  className="choice-list launch-provider-list"
                  role="listbox"
                  aria-label="Coding Provider"
                  aria-orientation="horizontal"
                  onKeyDown={(event) => {
                    focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
                  }}
                >
                  {enabledLaunchProviders.map((provider) => (
                    <button
                      key={provider.id}
                      className={`choice-chip${provider.id === selectedLaunchProviderId ? " active" : ""}`}
                      type="button"
                      role="option"
                      aria-selected={provider.id === selectedLaunchProviderId}
                      tabIndex={provider.id === selectedLaunchProviderId ? 0 : -1}
                      onClick={() => onSelectProvider(provider.id)}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>
              ) : (
                <article className="empty-list-card compact">
                  <p>有効な Coding Provider がないよ。</p>
                </article>
              )}
            </div>
          </section>
        </div>

        <div className="launch-dialog-foot minimal">
          {launchFeedback ? <p className="launch-feedback">{launchFeedback}</p> : null}
          <button
            className="start-session-button"
            type="button"
            aria-disabled={!canStartSession || launchStarting}
            disabled={!canStartSession || launchStarting}
            onClick={() => onStartSession(mode)}
          >
            {launchStarting ? "Starting..." : mode === "companion" ? "Start Companion" : "Start New Session"}
          </button>
        </div>
      </section>
    </div>
  );
}

export type HomeRecentSessionsPanelProps = {
  filteredSessionEntries: Array<{ session: SessionSummary; state: HomeSessionState }>;
  companionSessions: CompanionSessionSummary[];
  normalizedSessionSearch: string;
  searchText: string;
  searchIcon: ReactNode;
  onChangeSearchText: (value: string) => void;
  onOpenLaunchDialog: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  canUsePrimaryFeatures?: boolean;
};

export type HomeMateSetupPanelProps = {
  mode?: "create" | "edit";
  displayName: string;
  creating: boolean;
  avatarUpdating?: boolean;
  feedback: string;
  mateDisplayName: string | null;
  mateAvatarFilePath?: string | null;
  onChangeDisplayName: (value: string) => void;
  onSubmit: () => void;
  onOpenSettings: () => void;
  onCancel?: () => void;
  onSelectAvatar?: () => void;
  onClearAvatar?: () => void;
};

export function HomeMateSetupPanel({
  mode = "create",
  displayName,
  creating,
  avatarUpdating = false,
  feedback,
  mateDisplayName,
  mateAvatarFilePath,
  onChangeDisplayName,
  onSubmit,
  onOpenSettings,
  onCancel,
  onSelectAvatar,
  onClearAvatar,
}: HomeMateSetupPanelProps) {
  const isEditMode = mode === "edit";
  const canEditAvatar = isEditMode && Boolean(onSelectAvatar);
  const canClearAvatar = canEditAvatar && Boolean(onClearAvatar) && Boolean(mateAvatarFilePath);
  const avatarBusy = creating || avatarUpdating;
  const avatarDisplayName = displayName.trim() || mateDisplayName || "Mate";

  return (
    <section className="home-mate-setup-panel">
      <h2 className="home-mate-setup-head">{isEditMode ? "Mate プロフィール" : "Mate 作成"}</h2>
      <p className="home-mate-setup-description">
        {isEditMode ? "Mate の表示名を編集できるよ。" : "Home を使う前に Mate を 1 つ作成してね。設定は利用できるよ。"}
      </p>
      <form
        className="home-mate-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="home-mate-avatar-field">
          <CharacterAvatar
            character={{ name: avatarDisplayName, iconPath: mateAvatarFilePath ?? "" }}
            size="large"
            className="home-mate-avatar-preview"
          />
          <div className="home-mate-avatar-copy">
            <span className="home-mate-avatar-label">アイコン</span>
            <p className="home-mate-avatar-help">
              {canEditAvatar ? "Mate の表示に使う画像を選べます。" : "Mate 作成後に設定できます。"}
            </p>
            {canEditAvatar ? (
              <div className="home-mate-avatar-actions">
                <button className="launch-toggle" type="button" onClick={onSelectAvatar} disabled={avatarBusy}>
                  {avatarUpdating ? "更新中..." : "画像を選択"}
                </button>
                {canClearAvatar ? (
                  <button className="launch-toggle" type="button" onClick={onClearAvatar} disabled={avatarBusy}>
                    解除
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <label className="settings-field" htmlFor="mate-display-name">
          <span>表示名</span>
          <input
            id="mate-display-name"
            type="text"
            value={displayName}
            onChange={(event) => onChangeDisplayName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="あなたの Mate"
            disabled={creating}
          />
        </label>
        {mateDisplayName ? <p className="home-mate-current-name">現在の Mate: {mateDisplayName}</p> : null}
        {feedback ? <p className="settings-feedback home-mate-feedback">{feedback}</p> : null}
        <div className="home-mate-setup-actions">
          <button className="start-session-button" type="submit" disabled={creating}>
            {creating ? (isEditMode ? "保存中..." : "作成中...") : isEditMode ? "Mate を保存" : "Mate を作成"}
          </button>
          {onCancel ? (
            <button className="launch-toggle" type="button" onClick={onCancel} disabled={creating}>
              戻る
            </button>
          ) : null}
          <button className="launch-toggle" type="button" onClick={onOpenSettings}>
            設定
          </button>
        </div>
      </form>
    </section>
  );
}

export function HomeRecentSessionsPanel({
  filteredSessionEntries,
  companionSessions,
  normalizedSessionSearch,
  searchText,
  searchIcon,
  onChangeSearchText,
  onOpenLaunchDialog,
  onOpenSession,
  onOpenCompanionReview,
  canUsePrimaryFeatures = true,
}: HomeRecentSessionsPanelProps) {
  const openLaunchDialog = () => {
    if (!canUsePrimaryFeatures) {
      return;
    }
    onOpenLaunchDialog();
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
  const visibleCompanionSessions = companionSessions.filter((session) => {
    if (!normalizedSessionSearch) {
      return true;
    }
    const haystack = [
      session.taskTitle,
      session.character,
      session.repoRoot,
      session.focusPath,
      session.targetBranch,
      session.status,
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedSessionSearch);
  });
  const visibleSessionEntries = [
    ...filteredSessionEntries.map((entry) => ({
      kind: "agent" as const,
      updatedAt: entry.session.updatedAt,
      entry,
    })),
    ...visibleCompanionSessions.map((session) => ({
      kind: "companion" as const,
      updatedAt: session.updatedAt,
      session,
    })),
  ].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
  const hasVisibleEntries = visibleSessionEntries.length > 0;

  return (
    <section className="panel session-list-panel home-session-list-panel rise-3">
      <div className="toolbar-search-row">
        <label className="toolbar-search-field" aria-label="セッション検索">
          <span className="toolbar-search-icon" aria-hidden="true">
            {searchIcon}
          </span>
          <input
            className="toolbar-search-input"
            type="text"
            aria-label="セッション検索"
            value={searchText}
            onChange={(event) => onChangeSearchText(event.target.value)}
          />
        </label>
        <button
          className="start-session-button"
          type="button"
          onClick={openLaunchDialog}
          aria-disabled={!canUsePrimaryFeatures}
          disabled={!canUsePrimaryFeatures}
        >
          New Session
        </button>
      </div>

      <div className="session-card-list home-session-card-list">
        {visibleSessionEntries.map((item) => {
          if (item.kind === "companion") {
            const { session } = item;
            const companionState = getHomeCompanionSessionState(session);
            return (
              <button
                key={`companion-${session.id}`}
                className="session-card home-session-card"
                type="button"
                style={buildCardThemeStyle(session.characterThemeColors)}
                onClick={() => openCompanionReview(session.id)}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
                <div className="session-card-copy">
                  <div className="session-card-topline home-session-card-topline">
                    <strong>{session.taskTitle}</strong>
                    <div className="home-session-card-badges">
                      <span className="session-mode-badge companion">Companion</span>
                      <span className={`session-status home-session-status ${companionState.kind}`.trim()}>{companionState.label}</span>
                    </div>
                  </div>
                  <div className="session-card-subline home-session-card-meta">
                    <span>{`Workspace : ${session.focusPath || session.repoRoot}`}</span>
                    <span>{`updatedAt: ${session.updatedAt}`}</span>
                  </div>
                </div>
              </button>
            );
          }

          const { session, state } = item.entry;
          return (
            <button
              key={`agent-${session.id}`}
              className="session-card home-session-card"
              type="button"
              style={buildCardThemeStyle(session.characterThemeColors)}
              onClick={() => openSession(session.id)}
              aria-disabled={!canUsePrimaryFeatures}
              disabled={!canUsePrimaryFeatures}
            >
              <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
              <div className="session-card-copy">
                <div className="session-card-topline home-session-card-topline">
                  <strong>{session.taskTitle}</strong>
                  <div className="home-session-card-badges">
                    <span className="session-mode-badge agent">Agent</span>
                    <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                  </div>
                </div>
                <div className="session-card-subline home-session-card-meta">
                  <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                  <span>{`updatedAt: ${session.updatedAt}`}</span>
                </div>
                {session.taskSummary.trim() ? <p className="session-card-summary home-session-card-summary">{session.taskSummary}</p> : null}
              </div>
            </button>
          );
        })}
        {!hasVisibleEntries ? (
          normalizedSessionSearch ? (
            <article className="empty-list-card">
              <p>一致するセッションはないよ。</p>
            </article>
          ) : (
            <article className="empty-list-card">
              <p>まだセッションはないよ。</p>
              <button
                className="start-session-button"
                type="button"
                onClick={openLaunchDialog}
                aria-disabled={!canUsePrimaryFeatures}
                disabled={!canUsePrimaryFeatures}
              >
                New Session
              </button>
            </article>
          )
        ) : null}
      </div>
    </section>
  );
}

export type HomeMonitorContentProps = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  runningEmptyMessage: string;
  completedEmptyMessage: string;
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export function HomeMonitorContent({
  runningEntries,
  nonRunningEntries,
  runningEmptyMessage,
  completedEmptyMessage,
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
            <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
            <div className="home-monitor-row-copy">
              <strong>{session.taskTitle}</strong>
              <span>{session.character}</span>
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
          <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
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
          ) : (
            <p className="home-monitor-empty">{runningEmptyMessage}</p>
          )}
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
          ) : (
            <p className="home-monitor-empty">{completedEmptyMessage}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type HomeRightPaneProps = {
  rightPaneView: "monitor" | "mate";
  runningMonitorEntries: HomeMonitorEntry[];
  nonRunningMonitorEntries: HomeMonitorEntry[];
  monitorRunningEmptyMessage: string;
  monitorCompletedEmptyMessage: string;
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
  monitorRunningEmptyMessage,
  monitorCompletedEmptyMessage,
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
            runningEmptyMessage={monitorRunningEmptyMessage}
            completedEmptyMessage={monitorCompletedEmptyMessage}
            onOpenSession={openSession}
            onOpenCompanionReview={openCompanionReview}
          />
        </section>
      ) : (
        <section className="home-monitor-panel" role="tabpanel" aria-label="Your Mate" style={mateThemeStyle}>
          <div className="home-monitor-section">
            <div className="home-monitor-section-head">
              <h3>Your Mate</h3>
              <span>{mateDisplayName}</span>
            </div>
            <div className="home-monitor-section">
              <CharacterAvatar
                character={{ name: mateDisplayName, iconPath: mateProfile?.avatarFilePath ?? "" }}
                size="large"
              />
              {mateDescription ? (
                <p>{mateDescription}</p>
              ) : (
                <p>Mate の説明は未設定だよ。</p>
              )}
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
