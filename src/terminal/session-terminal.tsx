import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type {
  WithMateWindowNavigationApi,
  WithMateWindowTerminalApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import { TERMINAL_MAX_DIMENSION } from "../../src-shared/terminal/terminal-contract.js";
import { resolveOpenPathFeedback } from "../file-explorer/open-path-result.js";
import {
  detectShortcutPlatform,
  getShortcutDispatcher,
} from "../settings/shortcut-registry.js";
import { ButtonContent } from "../ui/button-content.js";
import { CloseButton } from "../ui/close-button.js";

/** Window 所有の PTY の管理と、端末に表示されたリンクを開くための API。 */
type TerminalApi = WithMateWindowTerminalApi &
  Pick<WithMateWindowNavigationApi, "openPath">;

/** 端末を識別する ID と表示番号、シェル名、およびタブに表示する起動・終了の状態。 */
type TerminalTab = {
  id: string;
  number: number;
  shellName: string;
  status: "Starting" | "Running" | "Exited" | "Failed";
  detail?: string;
};

/** タブから対応する端末ペインへフォーカスを渡す公開口。 */
type TerminalPaneHandle = {
  /** xterm が準備済みなら端末を、未準備なら入れ物をフォーカスする。 */
  focus(): void;
};
/** Session の他の領域から端末へフォーカスを渡す公開口。 */
export type SessionTerminalHandle = {
  /** 端末領域が開いているときに、選択中のペインへフォーカスを移す。 */
  focus(): void;
};

/** 終了に失敗した端末の識別子・表示番号と、再試行前に確認できる診断。 */
type TerminalCloseFailure = {
  terminalId: string;
  number: number;
  message: string;
};

/** 終了できなかった端末を明示し、その端末の終了の再試行と診断詳細を提示する。 */
function TerminalCloseError({
  error,
  onRetry,
}: {
  error: TerminalCloseFailure;
  /** 同じ端末を閉じる操作を再試行する。 */
  onRetry(): void;
}) {
  const popoverId = useId();
  const actionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const placePopover = useCallback(() => {
    if (!actionsRef.current || !triggerRef.current) return;
    const actions = actionsRef.current.getBoundingClientRect();
    const trigger = triggerRef.current.getBoundingClientRect();
    const margin = 16;
    const gap = 8;
    const width = Math.min(360, window.innerWidth - margin * 2);
    const above = actions.top - margin - gap;
    const below = window.innerHeight - actions.bottom - margin - gap;
    const showAbove = above > below;
    setPosition({
      width,
      left: Math.max(
        margin,
        Math.min(trigger.left, window.innerWidth - width - margin),
      ),
      maxHeight: Math.max(0, Math.min(320, showAbove ? above : below)),
      ...(showAbove
        ? { top: "auto", bottom: window.innerHeight - actions.top + gap }
        : { top: actions.bottom + gap, bottom: "auto" }),
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open, placePopover]);

  return (
    <div className="terminal-close-error" ref={actionsRef}>
      <span role="alert">
        <span aria-hidden="true">⚠</span> Terminal {error.number} could not be
        closed.
      </span>
      <div className="terminal-close-error-actions">
        <button
          className="drawer-toggle compact secondary"
          type="button"
          aria-label={`Retry Close Terminal ${error.number}`}
          onClick={onRetry}
        >
          Retry
        </button>
        <button
          type="button"
          className="drawer-toggle compact secondary"
          ref={triggerRef}
          popoverTarget={popoverId}
          aria-label={`Terminal ${error.number} Close Error Details`}
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={placePopover}
        >
          Details
        </button>
      </div>
      <div
        id={popoverId}
        ref={popoverRef}
        popover="auto"
        role="dialog"
        aria-label={`Terminal ${error.number} Close Error Details`}
        tabIndex={-1}
        className="terminal-close-error-popover"
        style={position}
        onToggle={(event) => {
          const isOpen = event.newState === "open";
          setOpen(isOpen);
          if (isOpen) event.currentTarget.focus();
        }}
      >
        <CloseButton
          ariaLabel="Close Error Details"
          onClose={() => {
            popoverRef.current?.hidePopover();
            triggerRef.current?.focus();
          }}
        />
        <div className="terminal-close-error-message">{error.message}</div>
      </div>
    </div>
  );
}

/** マウント済みの各ペインは、非表示の間も自身の xterm、購読、PTY を所有する。 */
function TerminalPane({
  api,
  tab,
  active,
  onStatus,
  onFocusTabs,
  ref,
}: {
  api: TerminalApi;
  tab: TerminalTab;
  active: boolean;
  /** このペインの ID と状態の差分をタブの所有元に伝える。 */
  onStatus(id: string, patch: Partial<TerminalTab>): void;
  /** 端末内のキー操作で、対応するタブにフォーカスを返す。 */
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

  useImperativeHandle(
    ref,
    () => ({
      /** 端末が初期化される前でも、スクロール領域へフォーカスを移せるようにする。 */
      focus: () => {
        if (terminalRef.current) terminalRef.current.focus();
        else containerRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let createRequested = false;
    let ended = false;
    let animationFrame = 0;
    let unsubscribe: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let terminal: Terminal | undefined;
    /** 生存中のペインに失敗を記録し、以後その端末へ入力を送らない状態にする。 */
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
      const [{ Terminal: Xterm }, { FitAddon }, { WebLinksAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);
      if (disposed || !containerRef.current) return;
      const host = containerRef.current;
      const style = getComputedStyle(host);
      /** アクティブなペインへの Ctrl＋主ボタンの操作でだけ HTTP(S) リンクを開き、失敗を通知する。 */
      const activateWebLink = (event: MouseEvent, uri: string) => {
        if (
          disposed ||
          !activeRef.current ||
          !event.ctrlKey ||
          event.button !== 0 ||
          !/^https?:\/\//i.test(uri)
        )
          return;
        setOperationError("");
        void resolveOpenPathFeedback(
          () => api.openPath(uri),
          "The link could not be opened.",
        ).then((message) => {
          if (!disposed && message)
            setOperationError(`Link could not be opened: ${message}`);
        });
      };
      terminal = new Xterm({
        fontFamily: 'Consolas, "Cascadia Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        screenReaderMode: true,
        disableStdin: true,
        linkHandler: { activate: activateWebLink },
        theme: {
          background: style.backgroundColor,
          foreground: style.color,
          cursor: style.color,
          selectionBackground: style
            .getPropertyValue("--character-main-soft")
            .trim(),
        },
      });
      const instance = terminal;
      terminalRef.current = instance;
      const fit = new FitAddon();
      instance.loadAddon(fit);
      instance.loadAddon(new WebLinksAddon(activateWebLink));
      instance.open(host);
      /** 表示中に計測できる場合だけ端末をリサイズし、行列数を PTY の上限内に収める。 */
      const resize = () => {
        if (
          disposed ||
          !activeRef.current ||
          host.clientWidth <= 0 ||
          host.clientHeight <= 0
        )
          return;
        const dimensions = fit.proposeDimensions();
        if (
          !dimensions ||
          !Number.isFinite(dimensions.cols) ||
          !Number.isFinite(dimensions.rows)
        )
          return;
        instance.resize(
          Math.min(dimensions.cols, TERMINAL_MAX_DIMENSION),
          Math.min(dimensions.rows, TERMINAL_MAX_DIMENSION),
        );
      };
      /** 未実行の測定を取り消し、次の描画タイミングに最新の測定だけを行う。 */
      const scheduleFit = () => {
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(resize);
      };
      fitRef.current = scheduleFit;
      observer = new ResizeObserver(scheduleFit);
      observer.observe(host);
      resize();
      instance.onResize(({ cols, rows }) => {
        if (createRequested && !ended && cols > 0 && rows > 0)
          api.resizeTerminal(tab.id, cols, rows);
      });
      instance.onData((data) => {
        if (createRequested && !ended) api.writeTerminalInput(tab.id, data);
      });
      instance.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          getShortcutDispatcher()?.dispatch(event)
        )
          return false;
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
              void navigator.clipboard
                .writeText(instance.getSelection())
                .catch((error: unknown) => {
                  if (!disposed)
                    setOperationError(`Copy failed: ${String(error)}`);
                });
            }
            return false;
          }
          if (
            event.key.toLowerCase() === "v" &&
            (event.shiftKey || detectShortcutPlatform() === "windows")
          ) {
            if (event.type === "keydown") {
              event.preventDefault();
              void navigator.clipboard
                .readText()
                .then((text) => {
                  if (!disposed && !ended && activeRef.current)
                    instance.paste(text);
                })
                .catch((error: unknown) => {
                  if (!disposed)
                    setOperationError(`Paste failed: ${String(error)}`);
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
            if (!disposed)
              api.acknowledgeTerminalOutput(tab.id, event.data.length);
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
      const result = await api.createTerminal({
        terminalId: tab.id,
        cols: instance.cols,
        rows: instance.rows,
      });
      if (disposed) return;
      if (result.windowsPty) instance.options.windowsPty = result.windowsPty;
      statusCallback.current(tab.id, {
        shellName: result.shellName,
        ...(!ended ? { status: "Running" } : {}),
      });
      if (!ended) instance.options.disableStdin = false;
      resize();
      if (activeRef.current && host.contains(document.activeElement))
        instance.focus();
    })().catch(fail);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      unsubscribe?.();
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (createRequested)
        void api.releaseTerminal(tab.id).catch(() => {
          // Window の破棄時には、Main 側でも独立して所有するすべての PTY を解放する。
        });
    };
  }, [api, tab.id]);

  useLayoutEffect(() => {
    if (active) {
      fitRef.current?.();
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
        <div
          className="terminal-result"
          role={tab.status === "Failed" ? "alert" : "status"}
        >
          {tab.status}: {tab.detail}
        </div>
      ) : null}
      {operationError ? (
        <div className="terminal-result" role="alert">
          {operationError}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="terminal-viewport"
        tabIndex={active ? 0 : -1}
        aria-label={`${tab.shellName} ${tab.number}. Press Control Shift Tab to focus terminal tabs.`}
      />
    </div>
  );
}

/** 端末ごとのタブとペインを管理し、折りたたみでは端末を維持しつつ最後の終了を通知する。 */
export function SessionTerminal({
  api,
  expanded,
  onEmpty,
  ref,
}: {
  api: TerminalApi;
  expanded: boolean;
  /** 最後のタブを閉じる操作が成功した後に呼ぶ。 */
  onEmpty(): void;
  ref?: Ref<SessionTerminalHandle>;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(() => new Set());
  const [closeError, setCloseError] = useState<TerminalCloseFailure | null>(
    null,
  );
  const counter = useRef(0);
  const closePending = useRef(false);
  const panes = useRef(new Map<string, TerminalPaneHandle>());
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusTabsOnSelection = useRef(false);
  const stateRef = useRef({ tabs, selectedId });
  stateRef.current = { tabs, selectedId };
  /** 領域が開いていて選択中のタブがある場合に、そのペインをフォーカスする。 */
  const focusSelected = () => {
    if (expanded && selectedId) panes.current.get(selectedId)?.focus();
  };
  useImperativeHandle(ref, () => ({ focus: focusSelected }), [
    expanded,
    selectedId,
  ]);

  useLayoutEffect(() => {
    const focusTabs = focusTabsOnSelection.current;
    focusTabsOnSelection.current = false;
    if (!expanded || !selectedId) return;
    if (focusTabs) tabButtons.current.get(selectedId)?.focus();
    else panes.current.get(selectedId)?.focus();
  }, [expanded, selectedId]);

  const addTerminal = useCallback(() => {
    const id = crypto.randomUUID();
    counter.current += 1;
    const number = counter.current;
    setTabs((current) => [
      ...current,
      { id, number, shellName: "Terminal", status: "Starting" },
    ]);
    setSelectedId(id);
  }, []);

  useEffect(() => {
    if (expanded && stateRef.current.tabs.length === 0) addTerminal();
  }, [expanded, addTerminal]);

  useEffect(() => {
    if (!expanded || !selectedId) return;
    tabButtons.current
      .get(selectedId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [expanded, selectedId]);

  const updateStatus = useCallback(
    (id: string, patch: Partial<TerminalTab>) => {
      setTabs((current) =>
        current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
      );
    },
    [],
  );

  /** 終了を一度に一件だけ要求し、成功時だけタブを外す。失敗時は同じ端末の再試行情報を残す。 */
  const closeTerminal = async (id: string) => {
    if (closePending.current) return;
    const target = stateRef.current.tabs.find((tab) => tab.id === id);
    if (!target) return;
    closePending.current = true;
    setClosingIds((current) => new Set(current).add(id));
    setCloseError(null);
    try {
      if (!(await api.closeTerminal(id))) return;
      const current = stateRef.current;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      const remaining = current.tabs.filter((tab) => tab.id !== id);
      setTabs(remaining);
      if (current.selectedId === id) {
        setSelectedId(
          remaining[Math.min(index, remaining.length - 1)]?.id ?? null,
        );
      }
      if (remaining.length === 0) onEmpty();
    } catch (error) {
      setCloseError({
        terminalId: id,
        number: target.number,
        message: `Terminal could not be closed: ${String(error)}`,
      });
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
    <section
      className="session-terminal"
      aria-label="Terminal"
      data-shortcut-scope="terminal"
    >
      <div
        className="terminal-toolbar"
        title="Local shell uses your OS permissions, independently of agent approval and sandbox settings."
      >
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
                ref={(element) => {
                  if (element) tabButtons.current.set(tab.id, element);
                  else tabButtons.current.delete(tab.id);
                }}
                onClick={() => {
                  setSelectedId(tab.id);
                  panes.current.get(tab.id)?.focus();
                }}
                onKeyDown={(event) => {
                  let next: TerminalTab | undefined;
                  if (event.key === "ArrowRight")
                    next = tabs[(index + 1) % tabs.length];
                  if (event.key === "ArrowLeft")
                    next = tabs[(index + tabs.length - 1) % tabs.length];
                  if (event.key === "Home") next = tabs[0];
                  if (event.key === "End") next = tabs[tabs.length - 1];
                  if (next) {
                    event.preventDefault();
                    focusTabsOnSelection.current = next.id !== selectedId;
                    tabButtons.current.get(next.id)?.focus();
                    setSelectedId(next.id);
                  }
                }}
              >
                {tab.shellName} {tab.number}
                {tab.status !== "Running" ? (
                  <span className="terminal-tab-status">{tab.status}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="terminal-close"
                aria-label={`Close Terminal ${tab.number}`}
                title="Close Terminal"
                aria-busy={closingIds.has(tab.id)}
                disabled={closingIds.size > 0}
                onClick={() => void closeTerminal(tab.id)}
              >
                <ButtonContent busy={closingIds.has(tab.id)}>×</ButtonContent>
              </button>
            </div>
          ))}
        </div>
        <button
          className="terminal-new"
          type="button"
          aria-label="New Terminal"
          title="New Terminal"
          onClick={addTerminal}
        >
          ＋
        </button>
      </div>
      {expanded && closeError ? (
        <TerminalCloseError
          error={closeError}
          onRetry={() => {
            focusSelected();
            void closeTerminal(closeError.terminalId);
          }}
        />
      ) : null}
      <div className="terminal-panes">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            ref={(handle) => {
              if (handle) panes.current.set(tab.id, handle);
              else panes.current.delete(tab.id);
            }}
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
