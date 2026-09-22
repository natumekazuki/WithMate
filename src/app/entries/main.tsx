import React from "react";
import ReactDOM from "react-dom/client";

import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import HomeApp from "../../home/HomeApp.js";
import { getHomeWindowMode, resolveHomeWindowTitle } from "../../home/home-window-mode.js";
import "../../styles.css";

const windowTitle = resolveHomeWindowTitle(getHomeWindowMode());
document.title = windowTitle;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="home-page" windowLabel={windowTitle}>
      <HomeApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
