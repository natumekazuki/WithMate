import { useId, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { SessionFilePreviewContextMenuRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { ButtonContent } from "../ui/button-content.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { useHomePreviews } from "./use-home-previews.js";

export function HomePreviewsPanel() {
  return <HomePreviewsContent {...useHomePreviews(window.withmate!)} />;
}

function showContextMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  open: (point: SessionFilePreviewContextMenuRequest["point"]) => void,
) {
  if ("key" in event && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  open({
    x: Math.max(0, Math.round("clientX" in event ? event.clientX : rect.left)),
    y: Math.max(0, Math.round("clientY" in event ? event.clientY : rect.bottom)),
  });
}

export function HomePreviewsContent({ groups, status, readError, actionError, pending, retry, openSession, focus, showPreviewMenu, showGroupMenu }: ReturnType<typeof useHomePreviews>) {
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
          const hasPreviews = group.previews.length > 0;
          const isExpanded = hasPreviews && expanded.has(group.ownerSessionId);
          const groupPending = pending.has(`group:${group.ownerSessionId}`);
          const sessionPending = pending.has(`session:${group.ownerSessionId}`);
          const openGroupMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
            if (hasPreviews && !groupPending) showContextMenu(event, (point) => showGroupMenu(group.ownerSessionId, point));
          };
          const childrenId = `${id}-${index}`;
          return <div className="home-monitor-card" key={group.ownerSessionId}>
            <div className="home-monitor-parent-row home-previews-parent-row" onContextMenu={openGroupMenu} onKeyDown={openGroupMenu}>
              <div className="home-monitor-parent-identity">
                <button className="home-monitor-parent-button home-previews-session" type="button"
                  title={title} aria-label={`Open session: ${title}`} aria-haspopup={hasPreviews ? "menu" : undefined}
                  disabled={!group.session || sessionPending} aria-busy={sessionPending}
                  onClick={() => openSession(group.ownerSessionId)}>
                  <ButtonContent busy={sessionPending}>
                    <CharacterAvatar character={{ name: group.session?.character ?? "", iconPath: group.session?.characterIconPath ?? "" }} size="tiny" className="home-monitor-avatar" />
                    <strong className="home-monitor-parent-title">{title}</strong>
                  </ButtonContent>
                </button>
              </div>
              <button className="home-monitor-disclosure home-previews-disclosure" type="button"
                aria-label={hasPreviews ? `${isExpanded ? "Hide" : "Show"} previews for ${title}` : `Previews for ${title}: 0`} title={`Previews: ${group.previews.length.toLocaleString("en-US")}`} aria-expanded={isExpanded} aria-controls={childrenId} aria-haspopup={hasPreviews ? "menu" : undefined} aria-busy={groupPending} disabled={!hasPreviews}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.ownerSessionId)) next.delete(group.ownerSessionId); else next.add(group.ownerSessionId);
                  return next;
                })}>
                <ButtonContent busy={groupPending}><ComposerIcon name="preview" /></ButtonContent>
                <span className="home-monitor-status-icon-count">{group.previews.length.toLocaleString("en-US")}</span>
                <span aria-hidden="true">{hasPreviews ? isExpanded ? "▾" : "▸" : null}</span>
              </button>
            </div>
            <div id={childrenId} className="home-monitor-auxiliary-list home-previews-children" aria-label={`Previews for ${title}`} hidden={!isExpanded}>
              {group.previews.map((preview) => {
                const focusPending = pending.has(`focus:${preview.token}`);
                const closePending = pending.has(`close:${preview.token}`);
                const openPreviewMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
                  if (!closePending && !groupPending) showContextMenu(event, (point) => showPreviewMenu(preview.token, point));
                };
                return <button key={preview.token} className="home-monitor-auxiliary-row home-previews-file" type="button"
                  title={preview.path} aria-label={`Focus preview: ${preview.title}, ${preview.path}`} aria-haspopup="menu"
                  disabled={focusPending || closePending || groupPending} aria-busy={focusPending || closePending}
                  onClick={() => focus(preview.token)} onContextMenu={openPreviewMenu} onKeyDown={openPreviewMenu}>
                  <ButtonContent busy={focusPending || closePending}><span className="home-monitor-auxiliary-preview">{preview.title}</span></ButtonContent>
                </button>;
              })}
            </div>
          </div>;
        })}
      </div>
    </div>
  );
}
