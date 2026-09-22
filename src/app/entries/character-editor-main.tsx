import React from "react";
import ReactDOM from "react-dom/client";

import CharacterEditorApp from "../../character-editor/CharacterEditorApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="character-editor-page" windowLabel="Character Editor">
      <CharacterEditorApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
