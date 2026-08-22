import React from "react";
import ReactDOM from "react-dom/client";

import CoordinationApp from "./CoordinationApp.js";
import { WindowErrorBoundary } from "./error-boundary.js";
import "./styles.css";
import "./coordination.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="coordination-page" windowLabel="Coordination">
      <CoordinationApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
