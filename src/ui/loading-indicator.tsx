/** 読み取り中・表示可能・取得失敗を区別する共通の表示状態。 */
export type ReadStatus = "loading" | "ready" | "error";

/** 視覚的なスピナーに、取得対象のラベルを持つ読み上げ可能な処理中状態を添える。 */
export function LoadingIndicator({
  label,
  inline = false,
  className = "",
}: {
  label: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`loading-indicator${inline ? " loading-indicator-inline" : ""}${className ? ` ${className}` : ""}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <span className="loading-indicator-spinner" aria-hidden="true" />
    </span>
  );
}
