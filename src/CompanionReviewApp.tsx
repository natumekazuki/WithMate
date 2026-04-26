import { useEffect, useMemo, useState } from "react";

import type { ChangedFile } from "./runtime-state.js";
import type { CompanionReviewSnapshot } from "./companion-review-state.js";
import { getCompanionSessionIdFromLocation } from "./companion-review-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import { fileKindLabel } from "./ui-utils.js";

function pickInitialFile(files: ChangedFile[]): ChangedFile | null {
  return files[0] ?? null;
}

export default function CompanionReviewApp() {
  const desktopRuntime = isDesktopRuntime();
  const [snapshot, setSnapshot] = useState<CompanionReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let active = true;
    const sessionId = getCompanionSessionIdFromLocation();
    const withmateApi = getWithMateApi();

    if (!withmateApi || !sessionId) {
      setSnapshot(null);
      setErrorMessage("表示できる Companion Review がないよ。");
      return () => {
        active = false;
      };
    }

    void withmateApi.getCompanionReviewSnapshot(sessionId)
      .then((payload) => {
        if (!active) {
          return;
        }
        setSnapshot(payload);
        setSelectedPath(pickInitialFile(payload?.changedFiles ?? [])?.path ?? "");
        setErrorMessage(payload ? "" : "対象 CompanionSession が見つからないよ。");
      })
      .catch((error) => {
        if (active) {
          setSnapshot(null);
          setErrorMessage(error instanceof Error ? error.message : "Companion Review の読み込みに失敗したよ。");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const themeStyle = useMemo(
    () => (snapshot ? buildCharacterThemeStyle(snapshot.session.characterThemeColors) : undefined),
    [snapshot],
  );
  const selectedFile = useMemo(
    () => snapshot?.changedFiles.find((file) => file.path === selectedPath) ?? pickInitialFile(snapshot?.changedFiles ?? []),
    [selectedPath, snapshot],
  );

  if (!desktopRuntime) {
    return (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <p>Companion Review は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <h2>Companion Review</h2>
          <p>{errorMessage || "読み込み中..."}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell companion-review-page theme-accent" style={themeStyle}>
      <section className="companion-review-shell panel rise-1">
        <header className="companion-review-header">
          <div>
            <p className="eyebrow">Companion Review</p>
            <h1>{snapshot.session.taskTitle}</h1>
            <div className="companion-review-meta">
              <span>{`target: ${snapshot.session.targetBranch}`}</span>
              <span>{`changed: ${snapshot.changedFiles.length}`}</span>
              <span>{snapshot.generatedAt}</span>
            </div>
          </div>
          <button className="diff-close" type="button" onClick={() => window.close()}>
            Close
          </button>
        </header>

        <div className="companion-review-layout">
          <aside className="companion-review-file-list" aria-label="Changed files">
            {snapshot.changedFiles.length > 0 ? (
              snapshot.changedFiles.map((file) => (
                <button
                  key={file.path}
                  className={`companion-review-file${selectedFile?.path === file.path ? " active" : ""}`}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className={`file-kind ${file.kind}`}>{fileKindLabel(file.kind)}</span>
                  <span className="companion-review-file-path">{file.path}</span>
                </button>
              ))
            ) : (
              <p className="companion-review-empty">変更ファイルはないよ。</p>
            )}
          </aside>

          <main className="companion-review-diff" aria-label="Selected file diff">
            {selectedFile ? (
              <>
                <div className="diff-titlebar companion-review-diff-title">
                  <h2>{selectedFile.path}</h2>
                </div>
                <DiffViewerSubbar file={selectedFile} />
                <DiffViewer file={selectedFile} />
              </>
            ) : (
              <div className="companion-review-empty-state">
                <p>表示する差分はないよ。</p>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
