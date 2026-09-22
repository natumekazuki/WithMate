import React from "react";
import ReactDOM from "react-dom/client";

import DiffApp from "../../file-explorer/DiffApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="diff-page" windowLabel="Diff Viewer">
      <DiffApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
