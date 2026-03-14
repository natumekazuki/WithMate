import { useEffect, useState } from "react";

import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import { getDiffTokenFromLocation, loadBrowserDiffPreview, type DiffPreviewPayload } from "./mock-data.js";

export default function DiffApp() {
  const [diffPreview, setDiffPreview] = useState<DiffPreviewPayload | null>(null);

  useEffect(() => {
    let active = true;
    const token = getDiffTokenFromLocation();

    if (!token) {
      setDiffPreview(null);
      return;
    }

    if (window.withmate) {
      void window.withmate.getDiffPreview(token).then((payload) => {
        if (active) {
          setDiffPreview(payload);
        }
      });

      return () => {
        active = false;
      };
    }

    setDiffPreview(loadBrowserDiffPreview(token));
    return () => {
      active = false;
    };
  }, []);

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
      <section className="diff-editor diff-window-shell panel rise-1">
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
