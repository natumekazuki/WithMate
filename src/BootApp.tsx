import { useEffect, useMemo, useState } from "react";

import type { AppBootStatus, AppBootStage } from "./app-boot-state.js";
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
  starting: "起動準備",
  database: "データベース確認",
  diagnostics: "診断情報",
  "workspace-cleanup": "作業領域の整理",
  stores: "保存領域の初期化",
  home: "Home 準備",
  failed: "起動失敗",
};

const INITIAL_STATUS: AppBootStatus = {
  kind: "running",
  stage: "starting",
  title: "WithMate を起動しています",
  detail: "起動状態を確認しています。",
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
    <main className={`boot-page-shell ${status.kind === "failed" ? "failed" : ""}`}>
      <section className="boot-status-panel">
        <div className="boot-status-head">
          <span className="boot-brand-mark">WM</span>
          <div>
            <p className="kicker">WithMate</p>
            <h1>{status.title}</h1>
          </div>
        </div>
        {status.detail ? <p className="boot-status-detail">{status.detail}</p> : null}
        {status.kind === "failed" && status.error ? (
          <pre className="boot-error-message">{status.error.message}</pre>
        ) : null}
        <ol className="boot-stage-list" aria-label="起動処理の進捗">
          {STAGES.map((stage, index) => {
            const isDone = activeIndex > index || status.kind === "completed";
            const isActive = status.stage === stage && status.kind === "running";
            return (
              <li key={stage} className={isDone ? "done" : isActive ? "active" : ""}>
                <span className="boot-stage-dot" />
                <span>{STAGE_LABELS[stage]}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}
