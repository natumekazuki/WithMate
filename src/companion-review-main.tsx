import React from "react";
import ReactDOM from "react-dom/client";

import CompanionReviewApp from "./CompanionReviewApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="companion-review-page" windowLabel="Companion">
      <CompanionReviewApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
