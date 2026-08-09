import React from "react";
import ReactDOM from "react-dom/client";

import FilePreviewApp from "./FilePreviewApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="file-preview-window-page" windowLabel="File Preview">
      <FilePreviewApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
