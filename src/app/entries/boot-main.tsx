import React from "react";
import ReactDOM from "react-dom/client";

import BootApp from "../BootApp.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import "../../styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="boot-page" windowLabel="Boot">
      <BootApp />
    </WindowErrorBoundary>
  </React.StrictMode>,
);
