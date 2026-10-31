import React from "react";
import ReactDOM from "react-dom/client";

import CharacterEditorApp from "../../character-editor/CharacterEditorApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";

const windowTitle = new URLSearchParams(window.location.search).get("characterId")?.trim()
  ? "Character Editor"
  : "New Character";
document.title = windowTitle;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="character-editor-page" windowLabel={windowTitle}>
      <CharacterEditorApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
