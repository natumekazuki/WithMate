import { CharacterAvatar } from "../ui-utils.js";

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
            {canEditAvatar ? <p className="home-mate-avatar-help">画像を選択できます。</p> : null}
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
