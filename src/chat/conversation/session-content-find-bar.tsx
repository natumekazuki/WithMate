import { useEffect, useRef } from "react";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

export type SessionContentFindBarProps = {
  open: boolean;
  query: string;
  currentMatch: number;
  matchCount: number;
  loading?: boolean;
  unavailable?: boolean;
  matchDescription?: string;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
};

export function SessionContentFindBar({
  open,
  query,
  currentMatch,
  matchCount,
  loading = false,
  unavailable = false,
  matchDescription,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: SessionContentFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (!open && wasOpenRef.current) {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => () => {
    restoreFocusRef.current?.focus();
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div className="session-content-find" role="search" aria-busy={loading || undefined}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        aria-label="Find in current content"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
        }}
      />
      <span className="session-content-find-count" role="status">
        {loading ? <LoadingIndicator inline label="Finding Messages" /> : unavailable ? "—" : matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : "0/0"}
        {!loading && !unavailable && matchDescription ? <span className="session-content-find-description">{matchDescription}</span> : null}
      </span>
      <button type="button" onClick={onPrevious} disabled={matchCount === 0 || unavailable} aria-label="Previous match">↑</button>
      <button type="button" onClick={onNext} disabled={matchCount === 0 || unavailable} aria-label="Next match">↓</button>
      <button type="button" onClick={onClose} aria-label="Close find">×</button>
    </div>
  );
}
