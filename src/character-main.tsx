import React from "react";
import ReactDOM from "react-dom/client";

import CharacterEditorApp from "./CharacterEditorApp.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CharacterEditorApp />
  </React.StrictMode>,
);
