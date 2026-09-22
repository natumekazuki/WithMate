import { useEffect, useMemo, useState } from "react";

import type { AppBootStatus, AppBootStage } from "../../src-shared/window/app-boot-state.js";
import { getWithMateApi } from "./renderer-withmate-api.js";

const STAGES: AppBootStage[] = [
  "starting",
  "database",
  "diagnostics",
  "workspace-cleanup",
  "stores",
  "home",
];

const STAGE_LABELS: Record<AppBootStage, string> = {
  starting: "Preparing startup",
  database: "Checking database",
  diagnostics: "Checking diagnostics",
  "workspace-cleanup": "Cleaning workspace",
  stores: "Initializing storage",
  home: "Preparing Home",
  failed: "Startup failed",
};

const INITIAL_STATUS: AppBootStatus = {
  kind: "running",
  stage: "starting",
  title: "Starting WithMate",
};

export default function BootApp() {
  const [status, setStatus] = useState<AppBootStatus>(INITIAL_STATUS);
  const activeIndex = useMemo(() => {
    if (status.stage === "failed") {
      return -1;
    }
    return STAGES.indexOf(status.stage);
  }, [status.stage]);

  useEffect(() => {
    const api = getWithMateApi();
    if (!api) {
      return undefined;
    }

    let disposed = false;
    const dispose = api.subscribeAppBootStatus(setStatus);
    void api.getAppBootStatus().then((currentStatus) => {
      if (!disposed) {
        setStatus(currentStatus);
      }
    }).catch((error) => {
      console.warn("Failed to get app boot status", error);
    });

    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  return (
    <div className={`page-shell home-page boot-page${status.kind === "failed" ? " failed" : ""}`}>
      <main className="home-layout home-layout-minimal boot-page-shell">
        <section className="panel boot-status-panel rise-1">
          <div className="home-panel-head boot-status-head">
            <div className="home-panel-copy">
              <p className="kicker">WithMate</p>
              <h1><span role="status" aria-atomic="true">{status.title}</span></h1>
            </div>
          </div>
          {status.detail ? <p className="boot-status-detail">{status.detail}</p> : null}
          {status.kind === "failed" && status.error ? (
            <pre className="boot-error-message">{status.error.message}</pre>
          ) : null}
          {status.kind !== "failed" ? <ol className="boot-stage-list" aria-label="Startup progress">
            {STAGES.map((stage, index) => {
              const isDone = activeIndex > index || status.kind === "completed";
              const isActive = status.stage === stage && status.kind === "running";
              return (
                <li key={stage} className={isDone ? "done" : isActive ? "active" : ""} aria-current={isActive ? "step" : undefined}>
                  <span className="boot-stage-dot" aria-hidden="true">{isDone ? "✓" : null}</span>
                  <span>{STAGE_LABELS[stage]}</span>
                  <span className="visually-hidden">{isDone ? "Completed" : isActive ? "In progress" : "Not started"}</span>
                </li>
              );
            })}
          </ol> : null}
        </section>
      </main>
    </div>
  );
}
