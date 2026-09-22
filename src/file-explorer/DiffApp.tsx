import { useEffect, useMemo, useState } from "react";

import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { getDiffTokenFromLocation } from "../app/session-location.js";
import { DiffViewer } from "../ui/DiffViewer.js";
import { getWithMateApi, isDesktopRuntime } from "../app/renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";

type DiffPreviewLoadState = "loading" | "ready" | "unavailable" | "error";

export default function DiffApp() {
  const desktopRuntime = isDesktopRuntime();
  const [diffPreview, setDiffPreview] = useState<DiffPreviewPayload | null>(null);
  const [loadState, setLoadState] = useState<DiffPreviewLoadState>(() => {
    const api = getWithMateApi();
    return api && getDiffTokenFromLocation() ? "loading" : "unavailable";
  });
  const [loadMessage, setLoadMessage] = useState("");
  const diffThemeStyle = useMemo(
    () => (diffPreview ? buildCharacterThemeStyle(diffPreview.themeColors) : undefined),
    [diffPreview],
  );

  useEffect(() => {
    let active = true;
    const token = getDiffTokenFromLocation();
    const withmateApi = getWithMateApi();

    if (!withmateApi || !token) {
      setDiffPreview(null);
      setLoadState("unavailable");
      return () => {
        active = false;
      };
    }
    setLoadState("loading");
    setLoadMessage("");

    void withmateApi.getDiffPreview(token).then((payload) => {
      if (active) {
        setDiffPreview(payload);
        setLoadState("ready");
      }
    }).catch((error) => {
      if (active) {
        setDiffPreview(null);
        setLoadState("error");
        setLoadMessage(error instanceof Error ? error.message : "Diff could not be loaded.");
      }
    });

    return () => {
      active = false;
    };
  }, []);

  if (!desktopRuntime) {
    return (
      <div className="page-shell diff-page">
        <section className="panel empty-session-card rise-1">
          <p>Diff viewer must be opened from the desktop app.</p>
        </section>
      </div>
    );
  }

  if (loadState === "loading") {
    return (
      <div className="page-shell diff-page">
        <section className="panel empty-session-card rise-1" role="status" aria-live="polite">
          <span className="workspace-changes-spinner" aria-hidden="true" />
          <span className="visually-hidden">Loading diff</span>
        </section>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="page-shell diff-page">
        <section className="panel empty-session-card rise-1" role="alert">
          <h2>Diff could not be loaded</h2>
          <p>{loadMessage || "Open the diff again from the originating Session."}</p>
        </section>
      </div>
    );
  }

  if (loadState === "unavailable" || !diffPreview) {
    return (
      <div className="page-shell diff-page">
        <section className="panel empty-session-card rise-1">
          <h2>No diff is available</h2>
          <p>Open the diff again from the originating Session.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell diff-page">
      <section className="diff-editor diff-window-shell panel rise-1 theme-accent" style={diffThemeStyle}>
        <div className="diff-titlebar">
          <h2>{diffPreview.file.path}</h2>
        </div>
        <DiffViewer file={diffPreview.file} />
      </section>
    </div>
  );
}
