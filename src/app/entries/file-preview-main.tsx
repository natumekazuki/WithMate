import React from "react";
import ReactDOM from "react-dom/client";

import FilePreviewApp from "../../file-explorer/FilePreviewApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="file-preview-window-page" windowLabel="FilePreview">
      <FilePreviewApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
