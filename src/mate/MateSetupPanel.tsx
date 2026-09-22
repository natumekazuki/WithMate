import { CharacterAvatar } from "../ui/ui-utils.js";

export type HomeMateSetupPanelProps = {
  mode?: "create" | "edit" | "unavailable";
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
  const isUnavailableMode = mode === "unavailable";
  const canEditAvatar = isEditMode && Boolean(onSelectAvatar);
  const canClearAvatar = canEditAvatar && Boolean(onClearAvatar) && Boolean(mateAvatarFilePath);
  const avatarBusy = creating || avatarUpdating;
  const avatarDisplayName = displayName.trim() || mateDisplayName || "Mate";

  return (
    <section className="home-mate-setup-panel">
      <h2 className="home-mate-setup-head">
        {isUnavailableMode ? "MateProfile" : isEditMode ? "MateProfile" : "CreateMate"}
      </h2>
      <form
        className="home-mate-setup-form"
        aria-busy={creating || avatarUpdating}
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
            <span className="home-mate-avatar-label">Avatar</span>
            {canEditAvatar ? (
              <div className="home-mate-avatar-actions">
                <button
                  className="launch-toggle"
                  type="button"
                  onClick={onSelectAvatar}
                  disabled={avatarBusy}
                  aria-busy={avatarUpdating}
                  aria-label={avatarUpdating ? "UpdatingAvatar" : "SelectImage"}
                >
                  {avatarUpdating ? <span className="home-mate-spinner" aria-hidden="true" /> : "SelectImage"}
                </button>
                {canClearAvatar ? (
                  <button className="launch-toggle" type="button" onClick={onClearAvatar} disabled={avatarBusy} aria-label="ClearAvatar">
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <label className="settings-field" htmlFor="mate-display-name">
          <span>DisplayName</span>
          <input
            id="mate-display-name"
            type="text"
            value={displayName}
            onChange={(event) => onChangeDisplayName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={creating || isUnavailableMode}
          />
        </label>
        {isUnavailableMode ? (
          <p className="settings-feedback home-mate-feedback">
            MateProfile is unavailable.
          </p>
        ) : feedback ? <p className="settings-feedback home-mate-feedback">{feedback}</p> : null}
        <div className="home-mate-setup-actions">
          {isUnavailableMode ? null : (
            <button
              className="start-session-button"
              type="submit"
              disabled={creating}
              aria-busy={creating}
              aria-label={creating ? (isEditMode ? "Saving" : "CreatingMate") : isEditMode ? "Save" : "CreateMate"}
            >
              {creating ? <span className="home-mate-spinner" aria-hidden="true" /> : isEditMode ? "Save" : "CreateMate"}
            </button>
          )}
          {onCancel ? (
            <button className="launch-toggle" type="button" onClick={onCancel} disabled={creating}>
              Cancel
            </button>
          ) : null}
          <button className="launch-toggle" type="button" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </form>
    </section>
  );
}
