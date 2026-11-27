import React from "react";
import ReactDOM from "react-dom/client";
import type { LocalPrWindowApi } from "../../../src-shared/local-pr/local-pr-contract.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import LocalPrWindowApp from "../../local-pr/LocalPrWindowApp.js";
import "../../styles.css";

declare global {
  interface Window { withmateLocalPr?: LocalPrWindowApi; }
}

const api = window.withmateLocalPr;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary pageClassName="local-pr-window" windowLabel="Pull Requests">
      {api ? <LocalPrWindowApp api={api} /> : <p role="alert">The Pull Requests Window Is Unavailable</p>}
    </WindowErrorBoundary>
  </React.StrictMode>,
);
