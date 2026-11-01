import React from "react";
import ReactDOM from "react-dom/client";
import SessionGraphWindowApp from "../../session-graph/SessionGraphWindowApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";
import "../../session-graph/session-graph.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="session-graph-window" windowLabel="Session Graph">
      <SessionGraphWindowApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
