import { useId, useState } from "react";

import { ButtonContent } from "../ui/button-content.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { useHomePreviews } from "./use-home-previews.js";

export function HomePreviewsPanel() {
  return <HomePreviewsContent {...useHomePreviews(window.withmate!)} />;
}

export function HomePreviewsContent({ groups, status, readError, actionError, pending, retry, focus, close, closeGroup }: ReturnType<typeof useHomePreviews>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const id = useId();
  return (
    <div className="home-previews-body" aria-busy={status === "loading"}>
      {status === "loading" ? <LoadingIndicator label="Loading previews" /> : null}
      {readError ? <LoadError message={readError} onRetry={retry} /> : null}
      {actionError ? <LoadError message={actionError} /> : null}
      <div className="home-previews-list" aria-label="Open file previews">
        {groups.map((group, index) => {
          const title = group.session ? group.session.taskTitle || group.session.id : "Session unavailable";
          const isExpanded = expanded.has(group.ownerSessionId);
          const groupPending = pending.has(`group:${group.ownerSessionId}`);
          const childrenId = `${id}-${index}`;
          return <div className="home-monitor-card" key={group.ownerSessionId}>
            <div className="home-monitor-parent-row home-previews-parent-row">
              <div className="home-monitor-parent-identity">
                {group.session ? <CharacterAvatar character={{ name: group.session.character, iconPath: group.session.characterIconPath }} size="tiny" className="home-monitor-avatar" /> : null}
                <strong className="home-monitor-parent-title" title={title}>{title}</strong>
              </div>
              <button className="home-monitor-disclosure home-previews-disclosure" type="button"
                aria-label={`${isExpanded ? "Hide" : "Show"} previews for ${title}`} aria-expanded={isExpanded} aria-controls={childrenId}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.ownerSessionId)) next.delete(group.ownerSessionId); else next.add(group.ownerSessionId);
                  return next;
                })}>
                <span>Previews: {group.previews.length.toLocaleString("en-US")}</span><span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
              </button>
              <button className="home-previews-close" type="button" aria-label={`Close all previews for ${title}`} disabled={groupPending} aria-busy={groupPending} onClick={() => closeGroup(group.ownerSessionId)}>
                <ButtonContent busy={groupPending}>Close All</ButtonContent>
              </button>
            </div>
            <div id={childrenId} className="home-previews-children" hidden={!isExpanded}>
              {group.previews.map((preview) => {
                const focusPending = pending.has(`focus:${preview.token}`);
                const closePending = pending.has(`close:${preview.token}`);
                return <div className="home-previews-file-row" key={preview.token}>
                  <button className="home-previews-file" type="button" title={preview.path} aria-label={`Focus preview: ${preview.title}, ${preview.path}`} disabled={focusPending || closePending || groupPending} aria-busy={focusPending} onClick={() => focus(preview.token)}>
                    <ButtonContent busy={focusPending}><span className="home-previews-file-copy"><strong>{preview.title}</strong><span>{preview.path}</span></span></ButtonContent>
                  </button>
                  <button className="home-previews-close" type="button" aria-label={`Close preview: ${preview.title}, ${preview.path}`} disabled={closePending || groupPending} aria-busy={closePending} onClick={() => close(preview.token)}>
                    <ButtonContent busy={closePending}>Close</ButtonContent>
                  </button>
                </div>;
              })}
            </div>
          </div>;
        })}
      </div>
    </div>
  );
}
