import type { ReactNode } from "react";

/** ボタンのラベルを残したまま処理中の表示を加え、必要に応じて読み上げ用の状態も提示する。 */
export function ButtonContent({
  busy,
  busyLabel,
  children,
}: {
  busy: boolean;
  busyLabel?: string;
  children: ReactNode;
}) {
  return (
    <span className="button-content" data-busy={busy || undefined}>
      <span className="button-content-label">{children}</span>
      {busy ? (
        <span
          className="loading-indicator-spinner button-content-spinner"
          aria-hidden="true"
        />
      ) : null}
      {busy && busyLabel ? (
        <span className="visually-hidden">{busyLabel}</span>
      ) : null}
    </span>
  );
}
