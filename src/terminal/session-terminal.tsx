import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type { WithMateWindowTerminalApi } from "../../src-shared/ipc/withmate-window-api.js";
import { TERMINAL_MAX_DIMENSION } from "../../src-shared/terminal/terminal-contract.js";
import { detectShortcutPlatform, getShortcutDispatcher } from "../settings/shortcut-registry.js";

type TerminalTab = {
  id: string;
  number: number;
  shellName: string;
  status: "Starting" | "Running" | "Exited" | "Failed";
  detail?: string;
};

type TerminalPaneHandle = { focus(): void };
export type SessionTerminalHandle = { focus(): void };

/** Each mounted pane owns its xterm, subscriptions and PTY, including while hidden. */
function TerminalPane({ api, tab, active, onStatus, onFocusTabs, ref }: {
  api: WithMateWindowTerminalApi;
  tab: TerminalTab;
  active: boolean;
  onStatus(id: string, patch: Partial<TerminalTab>): void;
  onFocusTabs(): void;
  ref: Ref<TerminalPaneHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const statusCallback = useRef(onStatus);
  const focusTabsCallback = useRef(onFocusTabs);
  const [operationError, setOperationError] = useState("");
  activeRef.current = active;
  statusCallback.current = onStatus;
  focusTabsCallback.current = onFocusTabs;

  useImperativeHandle(ref, () => ({ focus: () => terminalRef.current?.focus() }), []);

  useEffect(() => {
    let disposed = false;
    let createRequested = false;
    let ended = false;
    let animationFrame = 0;
    let unsubscribe: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let terminal: Terminal | undefined;
    const fail = (error: unknown) => {
      if (disposed) return;
      ended = true;
      if (terminal) terminal.options.disableStdin = true;
      statusCallback.current(tab.id, {
        status: "Failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    };

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;
      const host = containerRef.current;
      const style = getComputedStyle(host);
      terminal = new Xterm({
        fontFamily: 'Consolas, "Cascadia Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        screenReaderMode: true,
        disableStdin: true,
        theme: {
          background: style.backgroundColor,
          foreground: style.color,
          cursor: style.color,
          selectionBackground: style.getPropertyValue("--character-main-soft").trim(),
        },
      });
      const instance = terminal;
      terminalRef.current = instance;
      const fit = new FitAddon();
      instance.loadAddon(fit);
      instance.open(host);
      const resize = () => {
        if (disposed || !activeRef.current || host.clientWidth <= 0 || host.clientHeight <= 0) return;
        const dimensions = fit.proposeDimensions();
        if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
        instance.resize(
          Math.min(dimensions.cols, TERMINAL_MAX_DIMENSION),
          Math.min(dimensions.rows, TERMINAL_MAX_DIMENSION),
        );
      };
      const scheduleFit = () => {
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(resize);
      };
      fitRef.current = scheduleFit;
      observer = new ResizeObserver(scheduleFit);
      observer.observe(host);
      resize();
      instance.onResize(({ cols, rows }) => {
        if (createRequested && !ended && cols > 0 && rows > 0) api.resizeTerminal(tab.id, cols, rows);
      });
      instance.onData((data) => {
        if (createRequested && !ended) api.writeTerminalInput(tab.id, data);
      });
      instance.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && getShortcutDispatcher()?.dispatch(event)) return false;
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
          if (event.shiftKey && event.key === "Tab") {
            if (event.type === "keydown") {
              event.preventDefault();
              focusTabsCallback.current();
            }
            return false;
          }
          if (event.key.toLowerCase() === "c" && instance.hasSelection()) {
            if (event.type === "keydown") {
              event.preventDefault();
              void navigator.clipboard.writeText(instance.getSelection()).catch((error: unknown) => {
                if (!disposed) setOperationError(`Copy failed: ${String(error)}`);
              });
            }
            return false;
          }
          if (event.key.toLowerCase() === "v" && (event.shiftKey || detectShortcutPlatform() === "windows")) {
            if (event.type === "keydown") {
              event.preventDefault();
              void navigator.clipboard.readText().then((text) => {
                if (!disposed && !ended && activeRef.current) instance.paste(text);
              }).catch((error: unknown) => {
                if (!disposed) setOperationError(`Paste failed: ${String(error)}`);
              });
            }
            return false;
          }
        }
        return true;
      });
      unsubscribe = api.subscribeTerminalEvents((event) => {
        if (event.terminalId !== tab.id || disposed) return;
        if (event.type === "data") {
          instance.write(event.data, () => {
            if (!disposed) api.acknowledgeTerminalOutput(tab.id, event.data.length);
          });
        } else if (event.type === "exit") {
          ended = true;
          instance.options.disableStdin = true;
          statusCallback.current(tab.id, {
            status: "Exited",
            detail: `Exit code ${event.exitCode}${event.signal === undefined ? "" : `, signal ${event.signal}`}`,
          });
        } else if (event.type === "operation-error") {
          setOperationError(`Terminal operation failed: ${event.message}`);
        } else {
          fail(new Error(event.message));
        }
      });
      createRequested = true;
      const result = await api.createTerminal({ terminalId: tab.id, cols: instance.cols, rows: instance.rows });
      if (disposed) return;
      if (result.windowsPty) instance.options.windowsPty = result.windowsPty;
      statusCallback.current(tab.id, { shellName: result.shellName, ...(!ended ? { status: "Running" } : {}) });
      if (!ended) instance.options.disableStdin = false;
      resize();
      if (activeRef.current && host.contains(document.activeElement)) instance.focus();
    })().catch(fail);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      unsubscribe?.();
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (createRequested) void api.releaseTerminal(tab.id).catch(() => {
        // Window destruction independently releases all owned PTYs in Main.
      });
    };
  }, [api, tab.id]);

  useLayoutEffect(() => {
    if (active) {
      fitRef.current?.();
      terminalRef.current?.focus();
      if (!terminalRef.current) containerRef.current?.focus();
    } else {
      terminalRef.current?.blur();
    }
  }, [active]);

  return (
    <div
      id={`terminal-panel-${tab.id}`}
      className="terminal-pane"
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      hidden={!active}
    >
      {tab.status === "Failed" || tab.status === "Exited" ? (
        <div className="terminal-result" role={tab.status === "Failed" ? "alert" : "status"}>
          {tab.status}: {tab.detail}
        </div>
      ) : null}
      {operationError ? <div className="terminal-result" role="alert">{operationError}</div> : null}
      <div
        ref={containerRef}
        className="terminal-viewport"
        tabIndex={active ? 0 : -1}
        aria-label={`${tab.shellName} ${tab.number}. Press Control Shift Tab to focus terminal tabs.`}
      />
    </div>
  );
}

export function SessionTerminal({ api, expanded, onCollapse, ref }: {
  api: WithMateWindowTerminalApi;
  expanded: boolean;
  onCollapse(): void;
  ref?: Ref<SessionTerminalHandle>;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(() => new Set());
  const [closeError, setCloseError] = useState("");
  const counter = useRef(0);
  const closePending = useRef(false);
  const panes = useRef(new Map<string, TerminalPaneHandle>());
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const stateRef = useRef({ tabs, selectedId });
  stateRef.current = { tabs, selectedId };
  const focusSelected = () => {
    if (expanded && selectedId) panes.current.get(selectedId)?.focus();
  };
  useImperativeHandle(ref, () => ({ focus: focusSelected }), [expanded, selectedId]);

  const addTerminal = useCallback(() => {
    const id = crypto.randomUUID();
    counter.current += 1;
    const number = counter.current;
    setTabs((current) => [...current, { id, number, shellName: "Terminal", status: "Starting" }]);
    setSelectedId(id);
  }, []);

  useEffect(() => {
    if (expanded && stateRef.current.tabs.length === 0) addTerminal();
  }, [expanded, addTerminal]);

  useEffect(() => {
    if (!expanded || !selectedId) return;
    tabButtons.current.get(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [expanded, selectedId]);

  const updateStatus = useCallback((id: string, patch: Partial<TerminalTab>) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab));
  }, []);

  const closeTerminal = async (id: string) => {
    if (closePending.current) return;
    closePending.current = true;
    setClosingIds((current) => new Set(current).add(id));
    setCloseError("");
    try {
      if (!await api.closeTerminal(id)) return;
      const current = stateRef.current;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      const remaining = current.tabs.filter((tab) => tab.id !== id);
      setTabs(remaining);
      if (current.selectedId === id) {
        setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
      }
      if (remaining.length === 0) onCollapse();
    } catch (error) {
      setCloseError(`Terminal could not be closed: ${String(error)}`);
    } finally {
      closePending.current = false;
      setClosingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <section className="session-terminal" aria-label="Terminal" data-shortcut-scope="terminal">
      <div className="terminal-toolbar" title="Local shell uses your OS permissions, independently of agent approval and sandbox settings.">
        <div className="terminal-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((tab, index) => (
            <div className="terminal-tab-item" key={tab.id}>
              <button
                type="button"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                aria-controls={`terminal-panel-${tab.id}`}
                aria-selected={selectedId === tab.id}
                tabIndex={selectedId === tab.id ? 0 : -1}
                ref={(element) => { if (element) tabButtons.current.set(tab.id, element); else tabButtons.current.delete(tab.id); }}
                onClick={() => { setSelectedId(tab.id); panes.current.get(tab.id)?.focus(); }}
                onKeyDown={(event) => {
                  let next: TerminalTab | undefined;
                  if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
                  if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
                  if (event.key === "Home") next = tabs[0];
                  if (event.key === "End") next = tabs[tabs.length - 1];
                  if (next) { event.preventDefault(); setSelectedId(next.id); }
                }}
              >
                {tab.shellName} {tab.number}
                {tab.status !== "Running" ? <span className="terminal-tab-status">{tab.status}</span> : null}
              </button>
              <button
                type="button"
                className="terminal-close"
                aria-label={`Close Terminal ${tab.number}`}
                title="Close Terminal"
                disabled={closingIds.size > 0}
                onClick={() => void closeTerminal(tab.id)}
              >×</button>
            </div>
          ))}
        </div>
        <button className="terminal-new" type="button" aria-label="New Terminal" title="New Terminal" onClick={addTerminal}>＋</button>
      </div>
      {closeError ? <div className="terminal-result" role="alert">{closeError}</div> : null}
      <div className="terminal-panes">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            ref={(handle) => { if (handle) panes.current.set(tab.id, handle); else panes.current.delete(tab.id); }}
            api={api}
            tab={tab}
            active={expanded && selectedId === tab.id}
            onStatus={updateStatus}
            onFocusTabs={() => tabButtons.current.get(tab.id)?.focus()}
          />
        ))}
      </div>
    </section>
  );
}
