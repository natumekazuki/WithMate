import { useMemo } from "react";

import { isDesktopRuntime } from "./renderer-withmate-api.js";

function getCharacterEditorCharacterIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const characterId = new URLSearchParams(window.location.search).get("characterId")?.trim() ?? "";
  return characterId || null;
}

export default function CharacterEditorApp() {
  const desktopRuntime = isDesktopRuntime();
  const characterId = useMemo(() => getCharacterEditorCharacterIdFromLocation(), []);
  const modeLabel = characterId ? "Edit Character" : "Create Character";

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-editor-page">
        <section className="panel empty-session-card rise-1">
          <p>Character Editor は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell character-editor-page">
      <section className="panel settings-panel-window character-editor-shell rise-2">
        <header className="character-editor-header">
          <div>
            <p className="settings-note">V5 Character</p>
            <h1>{modeLabel}</h1>
          </div>
          <button className="launch-toggle" type="button" onClick={() => window.close()}>
            Close
          </button>
        </header>
        <div className="settings-panel-window-scroll character-editor-placeholder">
          <section className="settings-section-card">
            <strong>{characterId ? "既存 Character を編集中" : "新しい Character を作成"}</strong>
            <p className="settings-help">
              Character Editor Window の entry と IPC shell です。Profile / character.md / character-notes.md /
              Preview の編集 UI は後続 PR で接続します。
            </p>
            {characterId ? (
              <p className="settings-note">characterId: {characterId}</p>
            ) : (
              <p className="settings-note">create mode</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
