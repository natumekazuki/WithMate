import React from "react";
import ReactDOM from "react-dom/client";

import DiffApp from "./DiffApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="diff-page" windowLabel="Diff Viewer">
      <DiffApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
