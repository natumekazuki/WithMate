import React from "react";
import ReactDOM from "react-dom/client";

import { WindowErrorBoundary } from "./error-boundary.js";
import HomeApp from "./HomeApp.js";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="home-page" windowLabel="Home">
      <HomeApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
