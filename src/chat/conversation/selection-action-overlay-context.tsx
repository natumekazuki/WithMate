import { createContext, useState, type ReactNode } from "react";

export const SelectionActionOverlayContext = createContext<HTMLDivElement | null>(null);

export function SelectionActionOverlayBoundary({ children }: { children: ReactNode }) {
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
  return <SelectionActionOverlayContext.Provider value={overlayElement}>
    {children}
    <div ref={setOverlayElement} className="session-selection-action-overlay" />
  </SelectionActionOverlayContext.Provider>;
}
