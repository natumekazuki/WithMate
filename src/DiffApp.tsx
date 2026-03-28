import { useEffect, useMemo, useState } from "react";

import { getDiffTokenFromLocation, type DiffPreviewPayload } from "./session-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";

export default function DiffApp() {
  const desktopRuntime = isDesktopRuntime();
  const [diffPreview, setDiffPreview] = useState<DiffPreviewPayload | null>(null);
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
      return () => {
        active = false;
      };
    }

    void withmateApi.getDiffPreview(token).then((payload) => {
      if (active) {
        setDiffPreview(payload);
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
          <p>Diff Viewer は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

  if (!diffPreview) {
    return (
      <div className="page-shell diff-page">
        <section className="panel empty-session-card rise-1">
          <h2>表示できる Diff がないよ</h2>
          <p>もう一度 `Open In Window` から開き直してね。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell diff-page">
      <section className="diff-editor diff-window-shell panel rise-1 theme-accent" style={diffThemeStyle}>
        <div className="diff-titlebar">
          <h2>{diffPreview.file.path}</h2>
          <button className="diff-close" type="button" onClick={() => window.close()}>
            Close
          </button>
        </div>
        <DiffViewerSubbar file={diffPreview.file} />
        <DiffViewer file={diffPreview.file} />
      </section>
    </div>
  );
}
