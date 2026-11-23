import { useId, useMemo, useRef, useState } from "react";

import type { HomeCrewMember } from "../../src-shared/window/home-crew-types.js";
import type { SessionMonitorContextMenuPoint } from "../../src-shared/window/withmate-window-types.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { LoadError } from "../ui/load-error.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { HomeSessionCard, MonitorStatusIcon } from "./HomeSessionCard.js";
import { buildHomeCrewTree, filterHomeCrewTree, getHomeCrewDisplayCounts, type HomeCrewBranch } from "./home-crew-projection.js";
import { openSessionWindow } from "./home-launch-commands.js";
import { useHomeCrew } from "./use-home-crew.js";

function toggleKey(keys: ReadonlySet<string>, key: string) {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

type CrewBranchProps = {
  branch: HomeCrewBranch;
  mainKeys: ReadonlySet<string>;
  auxiliaryKeys: ReadonlySet<string>;
  searching: boolean;
  onToggleMain: (key: string) => void;
  onToggleAuxiliary: (key: string) => void;
  onOpen: (member: HomeCrewMember, auxiliarySessionId?: string) => void;
  onMenu: (member: HomeCrewMember, point: SessionMonitorContextMenuPoint) => void;
  depth: number;
};

function CrewBranch({ branch, ...props }: CrewBranchProps) {
  const { node, children } = branch;
  const { member } = node;
  const childListId = useId();
  const title = member.taskTitle || member.id;
  const expanded = props.searching !== props.mainKeys.has(node.key);
  const hasChildren = children.length > 0;
  const openCount = node.openDescendants.toLocaleString("en-US");
  const action = `${expanded ? "Hide" : "Show"} Children of ${title}`;
  const details = [
    `${openCount} descendant ${node.openDescendants === 1 ? "window" : "windows"} open`,
    ...node.descendantStates.map(({ label, count }) => `${label}: ${count.toLocaleString("en-US")}`),
    ...(node.hasUnreadDescendant ? ["Unread Result"] : []),
  ].join("; ");
  const mainDisclosure = hasChildren ? (
    <button
      className={`home-monitor-disclosure home-crew-main-disclosure${node.hasUnreadDescendant ? " has-unread-result" : ""}`}
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? childListId : undefined}
      aria-label={`${action}; ${details}`}
      title={`${action} — ${details}`}
      onClick={() => props.onToggleMain(node.key)}
    >
      <ComposerIcon name="main" />
      <span className="home-monitor-status-cluster">
        {getHomeCrewDisplayCounts(node.descendantStates).map((state) => (
          <MonitorStatusIcon key={state.label} kind={state.kind} label={state.label} count={state.count} description={state.description} />
        ))}
      </span>
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
    </button>
  ) : null;

  return (
    <li className="home-crew-node">
      <HomeSessionCard
        session={member}
        mainState={node.state}
        auxiliarySessions={node.auxiliaries}
        auxiliaryExpanded={props.auxiliaryKeys.has(node.key)}
        isWindowOpen={member.isWindowOpen}
        mainDisclosure={mainDisclosure}
        onToggleAuxiliary={() => props.onToggleAuxiliary(node.key)}
        onOpenMain={() => props.onOpen(member)}
        onOpenAuxiliary={(id) => props.onOpen(member, id)}
        onShowContextMenu={(point) => props.onMenu(member, point)}
      />
      {hasChildren && expanded ? (
        <ul id={childListId} className={`home-crew-tree home-crew-children${props.depth >= 5 ? " home-crew-deep-children" : ""}`} aria-label={`Children of ${title}`}>
          {children.map((child) => <CrewBranch key={child.node.key} branch={child} {...props} depth={props.depth + 1} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function HomeCrewPanel({ active, searchText }: { active: boolean; searchText: string }) {
  const api = getWithMateApi();
  const { snapshot, pending, error, refresh } = useHomeCrew(api, active);
  const [manualMainKeys, setManualMainKeys] = useState<ReadonlySet<string>>(new Set());
  const [auxiliaryKeys, setAuxiliaryKeys] = useState<ReadonlySet<string>>(new Set());
  const [searchExpansion, setSearchExpansion] = useState<{ query: string; collapsed: ReadonlySet<string> }>({ query: "", collapsed: new Set() });
  const [actionError, setActionError] = useState("");
  const menuPending = useRef(false);
  const query = searchText.trim().toLocaleLowerCase();
  if (searchExpansion.query !== query) setSearchExpansion({ query, collapsed: new Set() });
  const tree = useMemo(() => snapshot ? buildHomeCrewTree(snapshot.entries, snapshot.auxiliarySessions) : [], [snapshot]);
  const filtered = useMemo(() => filterHomeCrewTree(tree, query), [tree, query]);

  if (!active) return null;

  const openMember = async (member: HomeCrewMember, auxiliarySessionId?: string) => {
    setActionError("");
    try {
      await openSessionWindow(member.id, auxiliarySessionId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not open session window.");
    }
  };
  const showMenu = async (member: HomeCrewMember, point: SessionMonitorContextMenuPoint) => {
    if (!api || menuPending.current) return;
    menuPending.current = true;
    setActionError("");
    try {
      const result = await api.showHomeCrewContextMenu({ sessionId: member.id, incarnationId: member.incarnationId, point });
      if (result.status === "failed") setActionError(result.message);
      if (result.status === "closed" || result.status === "failed") refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not complete Crew action.");
      refresh();
    } finally {
      menuPending.current = false;
    }
  };

  return (
    <section id="home-panel-crew" className="home-monitor-panel home-crew-panel" role="tabpanel" aria-label="Crew">
      <header className="home-monitor-section-head">
        <h3>Crews</h3>
        {snapshot ? <span>{filtered.length.toLocaleString("en-US")}</span> : null}
      </header>
      {error ? <LoadError message={error} onRetry={refresh} retryBusy={pending} /> : null}
      {actionError ? <LoadError message={actionError} /> : null}
      <div className="home-crew-body" aria-busy={pending}>
        {!snapshot && pending ? <LoadingIndicator label="Loading Crews" /> : null}
        {snapshot ? (
          <ul className="home-crew-tree" aria-label={filtered.length ? "Crews With Open Session Windows" : query ? "No Matching Crews" : "No Crews With Open Session Windows"}>
            {filtered.map((branch) => (
              <CrewBranch key={branch.node.key} branch={branch} depth={0}
                searching={Boolean(query)}
                mainKeys={query ? searchExpansion.collapsed : manualMainKeys}
                auxiliaryKeys={auxiliaryKeys}
                onToggleMain={(key) => {
                  if (query) setSearchExpansion((state) => ({ query, collapsed: toggleKey(state.collapsed, key) }));
                  else setManualMainKeys((keys) => toggleKey(keys, key));
                }}
                onToggleAuxiliary={(key) => setAuxiliaryKeys((keys) => toggleKey(keys, key))}
                onOpen={openMember}
                onMenu={showMenu}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
