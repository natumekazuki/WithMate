/** 読み上げの優先度と見た目を切り替える、成功または失敗の通知種別。 */
export type AppNotificationTone = "success" | "error";

/** 通知で提示する本文と、その本文の成功・失敗の区別。 */
export type AppNotificationState = {
  message: string;
  tone: AppNotificationTone;
};

/** 表示する通知と任意の追加クラス。通知がなければ null を渡す。 */
type AppNotificationProps = {
  notification: AppNotificationState | null;
  className?: string;
};

/** 成功は穏やかに読み上げる状態、失敗は即時に読み上げる警告として描画する。 */
export function AppNotification({
  notification,
  className,
}: AppNotificationProps) {
  if (!notification) {
    return null;
  }

  return (
    <span
      className={["app-notification", notification.tone, className]
        .filter(Boolean)
        .join(" ")}
      role={notification.tone === "success" ? "status" : "alert"}
      aria-live={notification.tone === "success" ? "polite" : "assertive"}
      aria-atomic="true"
    >
      {notification.message}
    </span>
  );
}
