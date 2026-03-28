import React from "react";
import ReactDOM from "react-dom/client";

import CharacterEditorApp from "./CharacterEditorApp.js";
import CharacterUpdateApp from "./CharacterUpdateApp.js";
import { isCharacterUpdateMode } from "./character-state.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isCharacterUpdateMode() ? <CharacterUpdateApp /> : <CharacterEditorApp />}
  </React.StrictMode>,
);
