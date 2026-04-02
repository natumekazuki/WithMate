import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App.js";
import { WindowErrorBoundary } from "./error-boundary.js";
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
      <App />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
