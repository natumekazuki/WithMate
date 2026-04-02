import React from "react";
import ReactDOM from "react-dom/client";

import CharacterEditorApp from "./CharacterEditorApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="character-editor-page" windowLabel="Character Editor">
      <CharacterEditorApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
