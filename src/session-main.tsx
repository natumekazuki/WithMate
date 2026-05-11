import React from "react";
import ReactDOM from "react-dom/client";

import { WindowErrorBoundary } from "./error-boundary.js";
import SessionWindowApp from "./session-window-app.js";
import "./styles.css";

window.addEventListener("error", (event) => {
  console.error("[session-main] window error", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[session-main] unhandled rejection", event.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="session-page" windowLabel="Session">
      <SessionWindowApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
