import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { searchModelPickerOptions } from "./model-picker-options.js";
import type { ModelSelectOption } from "../../settings/model-select-options.js";
import type { ModelCatalogItem } from "../../../src-shared/settings/model-catalog.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

const ROW_HEIGHT = 56;
type PickerOption = ModelSelectOption & { disabled?: boolean };

export function ModelPicker({ options, value, fallbackLabel, onChange, onOpen, disabled, invalid, discoveryStatus, discoveryError, discoveryHasCache }: {
  options: readonly ModelSelectOption[];
  value: string;
  fallbackLabel?: string;
  onChange: (model: ModelCatalogItem) => void;
  onOpen?: () => void;
  disabled?: boolean;
  invalid?: boolean;
  discoveryStatus?: "idle" | "loading" | "ready" | "error";
  discoveryError?: string;
  discoveryHasCache?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const awaitingFirstResult = useRef(false);
  const [snapshot, setSnapshot] = useState<PickerOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, listHeight: 280 });
  const [theme, setTheme] = useState<Record<string, string>>({});
  const open = snapshot !== null && !disabled;
  const visible = useMemo(() => searchModelPickerOptions(snapshot ?? [], query), [snapshot, query]);
  const current = (snapshot ?? options).find((option) => option.value === value);
  const selectedLabel = current?.label ?? fallbackLabel ?? value;
  const loading = discoveryStatus === "idle" || discoveryStatus === "loading";
  const error = discoveryStatus === "error" ? discoveryError || "Models could not be loaded." : null;
  const emptyStatus = loading ? "Loading models…" : error ? "Could not load models."
    : query.trim() ? "No matching models." : "No models available.";

  function close(returnFocus = false) {
    awaitingFirstResult.current = false;
    setSnapshot(null);
    if (returnFocus) triggerRef.current?.focus();
  }

  function show() {
    if (disabled) return;
    awaitingFirstResult.current = !(discoveryHasCache ?? options.length > 0) && discoveryStatus !== "ready";
    const next: PickerOption[] = options.map((option) => ({ ...structuredClone(option), disabled: !option.model }));
    if (!next.some((option) => option.value === value) && value) {
      next.push({ value, label: fallbackLabel ?? value, model: null, disabled: true });
    }
    const sorted = searchModelPickerOptions(next, "");
    const style = window.getComputedStyle(triggerRef.current!);
    setTheme(Object.fromEntries(["--ink", "--muted", "--surface-strong", "--surface-deep", "--line", "--character-main", "--shadow",
      "--scrollbar-track", "--scrollbar-thumb", "--scrollbar-thumb-hover"]
      .map((property) => [property, style.getPropertyValue(property)])));
    setSnapshot(sorted);
    setQuery("");
    const selectedIndex = sorted.findIndex((option) => option.value === value);
    setActive(selectedIndex >= 0 ? selectedIndex : sorted.findIndex((option) => !option.disabled));
    setScrollTop(0);
    onOpen?.();
  }

  useEffect(() => {
    if (!open || !awaitingFirstResult.current || discoveryStatus !== "ready") return;
    awaitingFirstResult.current = false;
    const next: PickerOption[] = options.map((option) => ({ ...structuredClone(option), disabled: !option.model }));
    if (value && !next.some((option) => option.value === value)) next.push({ value, label: fallbackLabel ?? value, model: null, disabled: true });
    const nextVisible = searchModelPickerOptions(next, query);
    const previousActive = visible[active]?.value;
    const nextActive = nextVisible.findIndex((option) => option.value === (previousActive ?? value));
    setSnapshot(next);
    setActive(nextActive >= 0 ? nextActive : nextVisible.findIndex((option) => !option.disabled));
  }, [open, discoveryStatus, options, value, fallbackLabel, query, visible, active]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
      const above = rect.top - topEdge - 6;
      const below = bottomEdge - rect.bottom - 6;
      const placeAbove = above >= 200 || above >= below;
      const height = Math.min(360, 56 + Math.max(1, visible.length) * ROW_HEIGHT, Math.max(0, placeAbove ? above : below));
      const width = Math.min(400, viewportWidth - 16);
      setPosition({
        left: Math.max(leftEdge, Math.min(rect.left, leftEdge + viewportWidth - 16 - width)),
        top: placeAbove ? Math.max(topEdge, rect.top - height - 6) : rect.bottom + 6,
        width,
        listHeight: Math.max(0, height - 56),
      });
    };
    update();
    searchRef.current?.focus();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, visible.length]);

  useEffect(() => {
    if (disabled) { awaitingFirstResult.current = false; setSnapshot(null); }
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!popupRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!popupRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const list = listRef.current;
    const top = active * ROW_HEIGHT;
    const next = top < list.scrollTop ? top : top + ROW_HEIGHT > list.scrollTop + position.listHeight
      ? top + ROW_HEIGHT - position.listHeight : list.scrollTop;
    list.scrollTop = Math.max(0, next);
    setScrollTop(list.scrollTop);
  }, [active, open, position.listHeight]);

  function choose(index: number) {
    const option = visible[index];
    if (!option?.model || option.disabled) return;
    onChange(option.model);
    close(true);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
    } else if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key.endsWith("Down") ? 1 : -1;
      const step = event.key.startsWith("Page") ? Math.max(1, Math.floor(position.listHeight / ROW_HEIGHT)) : 1;
      let index = active < 0 ? (direction > 0 ? -1 : visible.length) : active;
      index = Math.max(0, Math.min(visible.length - 1, index + direction * step));
      while (visible[index]?.disabled) index += direction;
      if (index >= 0 && index < visible.length) setActive(index);
    } else if (event.key === "Tab") {
      // The portal is outside the composer tab order; resume from its trigger.
      triggerRef.current?.focus();
      close();
    }
  }

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const end = Math.min(visible.length, Math.ceil((scrollTop + position.listHeight) / ROW_HEIGHT) + 3);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  if (active >= 0 && active < visible.length && !indices.includes(active)) indices.push(active);

  return <div className="composer-setting-field composer-setting-model" aria-busy={loading || undefined}>
    <button ref={triggerRef} type="button" className="composer-model-trigger" aria-label="Model"
      title={`Model: ${selectedLabel}${error ? `\n${error}` : ""}`} aria-haspopup="listbox" aria-expanded={open}
      aria-describedby={error ? `${id}-error` : undefined}
      aria-controls={open ? `${id}-list` : undefined} aria-invalid={invalid || undefined} disabled={disabled}
      onClick={() => open ? close() : show()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); }
      }}>
      <span>{selectedLabel}</span><span className="composer-model-indicator">
        {loading ? <LoadingIndicator label="Loading Models" inline /> : <span aria-hidden="true">{error ? "!" : "⌄"}</span>}
      </span>
    </button>
    {error ? <span id={`${id}-error`} role="status" className="visually-hidden">{error}</span> : null}
    {open && createPortal(<div ref={popupRef} className="composer-model-popover" style={{
      ...theme, left: position.left, top: position.top, width: position.width,
    } as CSSProperties}>
      <div className="composer-model-search-row">
        <input ref={searchRef} type="search" role="combobox" aria-label="Search Models" aria-expanded="true"
          aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={query} onChange={(event) => {
            setQuery(event.target.value);
            setActive(searchModelPickerOptions(snapshot, event.target.value).findIndex((option) => !option.disabled));
            setScrollTop(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }} onKeyDown={onSearchKeyDown} onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }} />
        <button type="button" aria-label="Close Model Picker" onClick={() => close(true)}>×</button>
      </div>
      <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Models" className="composer-model-list"
        style={{ height: Math.min(position.listHeight, visible.length * ROW_HEIGHT) }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: visible.length * ROW_HEIGHT, position: "relative" }}>
          {indices.map((index) => {
            const option = visible[index]!;
            return <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined} aria-posinset={index + 1} aria-setsize={visible.length}
              className={`composer-model-option${active === index ? " is-active" : ""}`}
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              title={[option.label, option.sourceLabel, option.value !== option.label ? option.value : null].filter(Boolean).join("\n")}
              onPointerDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
              <span className="composer-model-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
              <span className="composer-model-option-copy"><span>{option.label}</span>{option.sourceLabel ? <small>{option.sourceLabel}</small> : null}</span>
            </div>;
          })}
        </div>
      </div>
      {visible.length === 0 ? <div className="composer-model-empty" role="status" style={{ maxHeight: position.listHeight }} title={error ?? undefined}>{emptyStatus}</div>
        : <span className="visually-hidden" role="status">{visible.length} Models</span>}
    </div>, document.body)}
  </div>;
}
