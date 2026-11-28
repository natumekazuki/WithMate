import { createContext, useState, type ReactNode } from "react";

/** 選択操作の表示先を渡す。オーバーレイがまだマウントされていなければ null。 */
export const SelectionActionOverlayContext =
  createContext<HTMLDivElement | null>(null);

/** 会話の子要素に、選択操作を配置できる専用のオーバーレイを供給する。 */
export function SelectionActionOverlayBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <SelectionActionOverlayContext.Provider value={overlayElement}>
      {children}
      <div
        ref={setOverlayElement}
        className="session-selection-action-overlay"
      />
    </SelectionActionOverlayContext.Provider>
  );
}
