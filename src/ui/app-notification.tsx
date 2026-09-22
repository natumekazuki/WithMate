export type AppNotificationTone = "success" | "error";

export type AppNotificationState = {
  message: string;
  tone: AppNotificationTone;
};

type AppNotificationProps = {
  notification: AppNotificationState | null;
  className?: string;
};

export function AppNotification({ notification, className }: AppNotificationProps) {
  if (!notification) {
    return null;
  }

  return (
    <span
      className={[
        "app-notification",
        notification.tone,
        className,
      ].filter(Boolean).join(" ")}
      role={notification.tone === "success" ? "status" : "alert"}
      aria-live={notification.tone === "success" ? "polite" : "assertive"}
      aria-atomic="true"
    >
      {notification.message}
    </span>
  );
}
