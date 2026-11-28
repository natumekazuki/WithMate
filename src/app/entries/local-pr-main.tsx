import React from "react";
import ReactDOM from "react-dom/client";
import type { LocalPrWindowApi } from "../../../src-shared/local-pr/local-pr-contract.js";
import { WindowErrorBoundary } from "../../ui/error-boundary.js";
import LocalPrWindowApp from "../../local-pr/LocalPrWindowApp.js";
import "../../styles.css";

declare global {
  /** Pull Requests 専用の preload が提供する、対象リポジトリに紐付いた API。 */
  interface Window {
    withmateLocalPr?: LocalPrWindowApi;
  }
}

const api = window.withmateLocalPr;
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WindowErrorBoundary
      pageClassName="session-page"
      windowLabel="Pull Requests"
    >
      {api ? (
        <LocalPrWindowApp api={api} />
      ) : (
        <div className="page-shell session-page">
          <section className="panel empty-session-card" role="alert">
            <p>The Pull Requests Window Is Unavailable</p>
          </section>
        </div>
      )}
    </WindowErrorBoundary>
  </React.StrictMode>,
);
