import React from "react";
import ReactDOM from "react-dom/client";

import { CompanionMergeReviewApp } from "./companion-review/CompanionMergeReviewApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="companion-review-page" windowLabel="Companion">
      <CompanionMergeReviewApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
