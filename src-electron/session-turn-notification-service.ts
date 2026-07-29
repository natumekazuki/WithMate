import { createHash } from "node:crypto";

import type { Session } from "../src/session-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

export type SessionTurnNotificationOptions<TIcon> = {
  id: string;
  groupId: string;
  title: string;
  body: string;
  icon?: TIcon;
};

export type SessionTurnNotificationHandle = {
  show(): void;
  close(): void;
  onClick(listener: () => void): void;
  onClose(listener: () => void): void;
  onFailed(listener: (error: unknown) => void): void;
};

export type SessionTurnNotificationServiceDeps<TIcon> = {
  platform: NodeJS.Platform;
  isNotificationSupported(): boolean;
  isNotificationEnabled(): boolean;
  isSessionWindowFocused(sessionId: string): boolean;
  loadCharacterIcon(iconPath: string): TIcon | null;
  createNotification(options: SessionTurnNotificationOptions<TIcon>): SessionTurnNotificationHandle;
  getSession(sessionId: string): Awaitable<Session | null>;
  openSessionWindow(sessionId: string): Awaitable<void>;
  openHomeWindow(): Awaitable<void>;
  logWarning(event: string, sessionId: string, error?: unknown): void;
};

export class SessionTurnNotificationService<TIcon> {
  private static readonly notificationGroupId = "WithMateSessions";
  private readonly activeNotifications = new Map<string, SessionTurnNotificationHandle>();

  constructor(private readonly deps: SessionTurnNotificationServiceDeps<TIcon>) {}

  notifyTurnCompleted(session: Session): boolean {
    if (!this.isEligible(session.id)) {
      return false;
    }

    const options: SessionTurnNotificationOptions<TIcon> = {
      id: this.buildNotificationId(session.id),
      groupId: SessionTurnNotificationService.notificationGroupId,
      title: "WithMate",
      body: `「${session.taskTitle.trim() || "Session"}」のターンが完了しました`,
    };
    const icon = this.loadCharacterIcon(session);
    if (icon !== null) {
      options.icon = icon;
    }

    this.closePreviousNotification(session.id);

    let notification: SessionTurnNotificationHandle;
    try {
      notification = this.deps.createNotification(options);
    } catch (error) {
      this.deps.logWarning("create-failed", session.id, error);
      return false;
    }

    notification.onClick(() => {
      this.clearIfCurrent(session.id, notification);
      void this.openNotificationTarget(session.id);
    });
    notification.onClose(() => {
      this.clearIfCurrent(session.id, notification);
    });
    notification.onFailed((error) => {
      this.clearIfCurrent(session.id, notification);
      this.deps.logWarning("delivery-failed", session.id, error);
    });
    this.activeNotifications.set(session.id, notification);

    try {
      notification.show();
      return true;
    } catch (error) {
      this.clearIfCurrent(session.id, notification);
      this.deps.logWarning("show-failed", session.id, error);
      return false;
    }
  }

  private isEligible(sessionId: string): boolean {
    try {
      return this.deps.platform === "win32"
        && this.deps.isNotificationSupported()
        && this.deps.isNotificationEnabled()
        && !this.deps.isSessionWindowFocused(sessionId);
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", sessionId, error);
      return false;
    }
  }

  private loadCharacterIcon(session: Session): TIcon | null {
    const iconPath = session.characterIconPath.trim();
    if (!iconPath) {
      return null;
    }

    try {
      return this.deps.loadCharacterIcon(iconPath);
    } catch (error) {
      this.deps.logWarning("icon-load-failed", session.id, error);
      return null;
    }
  }

  private buildNotificationId(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("hex");
  }

  private closePreviousNotification(sessionId: string): void {
    const previousNotification = this.activeNotifications.get(sessionId);
    if (!previousNotification) {
      return;
    }

    this.activeNotifications.delete(sessionId);
    try {
      previousNotification.close();
    } catch (error) {
      this.deps.logWarning("replace-close-failed", sessionId, error);
    }
  }

  private clearIfCurrent(sessionId: string, notification: SessionTurnNotificationHandle): void {
    if (this.activeNotifications.get(sessionId) === notification) {
      this.activeNotifications.delete(sessionId);
    }
  }

  private async openNotificationTarget(sessionId: string): Promise<void> {
    try {
      const session = await this.deps.getSession(sessionId);
      if (session) {
        await this.deps.openSessionWindow(sessionId);
        return;
      }
    } catch (error) {
      this.deps.logWarning("target-open-failed", sessionId, error);
    }

    try {
      await this.deps.openHomeWindow();
    } catch (error) {
      this.deps.logWarning("home-open-failed", sessionId, error);
    }
  }
}
