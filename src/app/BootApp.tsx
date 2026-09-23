import { lazy, Suspense, useEffect, useState } from "react";

import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import { WindowErrorBoundary } from "../ui/error-boundary.js";
import { getWithMateApi } from "./renderer-withmate-api.js";

const HomeApp = lazy(() => import("../home/HomeApp.js"));

const BOOT_STAGE_LABELS: Record<AppBootStatus["stage"], string> = {
  starting: "PreparingStartup",
  database: "CheckingDatabase",
  diagnostics: "CheckingDiagnostics",
  "workspace-cleanup": "CleaningWorkspace",
  stores: "InitializingStorage",
  home: "PreparingHome",
  failed: "StartupFailed",
};

const INITIAL_STATUS: AppBootStatus = {
  kind: "running",
  stage: "starting",
  title: "PreparingStartup",
};

export default function BootApp() {
  const [status, setStatus] = useState<AppBootStatus>(INITIAL_STATUS);

  useEffect(() => {
    if (status.kind === "completed") document.title = "Home";
  }, [status.kind]);

  useEffect(() => {
    const api = getWithMateApi();
    if (!api) {
      return undefined;
    }

    let disposed = false;
    const updateStatus = (nextStatus: AppBootStatus) => {
      setStatus((currentStatus) => currentStatus.kind !== "running" && nextStatus.kind === "running"
        ? currentStatus
        : nextStatus);
    };
    const dispose = api.subscribeAppBootStatus(updateStatus);
    void api.getAppBootStatus().then((currentStatus) => {
      if (!disposed) {
        updateStatus(currentStatus);
      }
    }).catch((error) => {
      console.warn("Failed to get app boot status", error);
    });

    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  const statusLabel = BOOT_STAGE_LABELS[status.stage];

  const bootScreen = (
    <div className={`page-shell home-page boot-page${status.kind === "failed" ? " failed" : ""}`}>
      <main className="home-layout home-layout-minimal boot-page-shell">
        <section className="boot-status-panel rise-1" aria-busy={status.kind !== "failed"}>
          {status.kind === "failed" ? (
            <div role="alert">
              <h1 className="boot-error-title">{status.title}</h1>
              {status.detail ? <p className="boot-status-detail">{status.detail}</p> : null}
              {status.error ? <pre className="boot-error-message">{status.error.message}</pre> : null}
            </div>
          ) : (
            <div className="boot-progress" role="status" aria-atomic="true">
              <span className="home-session-list-load-spinner" aria-hidden="true" />
              <span>Starting WithMate</span>
              <span className="sr-only">{statusLabel}{status.detail ? `. ${status.detail}` : ""}</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );

  if (status.kind === "completed") {
    return (
      <Suspense fallback={bootScreen}>
        <WindowErrorBoundary pageClassName="home-page" windowLabel="Home">
          <HomeApp />
        </WindowErrorBoundary>
      </Suspense>
    );
  }

  return bootScreen;
}
