import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import {
  SessionTurnNotificationService,
  type SessionTurnNotificationHandle,
  type SessionTurnNotificationOptions,
  type SessionTurnNotificationServiceDeps,
} from "../../src-electron/session-turn-notification-service.js";

type FakeIcon = { path: string };

class FakeNotification implements SessionTurnNotificationHandle {
  shown = false;
  closed = false;
  private clickListener: (() => void) | null = null;
  private closeListener: (() => void) | null = null;
  private failedListener: ((error: unknown) => void) | null = null;

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.closed = true;
    this.closeListener?.();
  }

  onClick(listener: () => void): void {
    this.clickListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  onFailed(listener: (error: unknown) => void): void {
    this.failedListener = listener;
  }

  click(): void {
    this.clickListener?.();
  }

  fail(error: unknown): void {
    this.failedListener?.(error);
  }

  timeout(): void {
    this.closeListener?.();
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "通知テスト",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-a",
      character: "Character A",
      characterIconPath: "C:/characters/a.png",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createHarness(overrides?: Partial<SessionTurnNotificationServiceDeps<FakeIcon>>) {
  const session = createSession();
  const notifications: FakeNotification[] = [];
  const options: SessionTurnNotificationOptions<FakeIcon>[] = [];
  const openedSessions: string[] = [];
  let homeOpenCount = 0;
  const warnings: Array<{ event: string; sessionId: string; error?: unknown }> = [];
  const deps: SessionTurnNotificationServiceDeps<FakeIcon> = {
    platform: "win32",
    isNotificationSupported: () => true,
    isNotificationEnabled: () => true,
    isSessionWindowFocused: () => false,
    loadCharacterIcon: (iconPath) => ({ path: iconPath }),
    createNotification: (nextOptions) => {
      const notification = new FakeNotification();
      notifications.push(notification);
      options.push(nextOptions);
      return notification;
    },
    getSession: () => session,
    openSessionWindow: (sessionId) => {
      openedSessions.push(sessionId);
    },
    openHomeWindow: () => {
      homeOpenCount += 1;
    },
    logWarning: (event, sessionId, error) => {
      warnings.push({ event, sessionId, error });
    },
    ...overrides,
  };

  return {
    session,
    service: new SessionTurnNotificationService(deps),
    notifications,
    options,
    openedSessions,
    warnings,
    get homeOpenCount() {
      return homeOpenCount;
    },
  };
}

async function flushAsyncListeners(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SessionTurnNotificationService", () => {
  it("Windows で設定が有効かつ対象 Session Window が非 focus ならキャラアイコン付きで通知する", () => {
    const harness = createHarness();

    assert.equal(harness.service.notifyTurnCompleted(harness.session), true);

    assert.equal(harness.notifications[0]?.shown, true);
    assert.deepEqual(harness.options[0], {
      id: harness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "WithMate",
      body: "「通知テスト」のターンが完了しました",
      icon: { path: "C:/characters/a.png" },
    });
    assert.match(harness.options[0]?.id ?? "", /^[0-9a-f]{64}$/);
  });

  it("Windows 以外、非対応、設定無効、対象 Session Window focus 中は通知しない", () => {
    const cases: Array<Partial<SessionTurnNotificationServiceDeps<FakeIcon>>> = [
      { platform: "darwin" },
      { isNotificationSupported: () => false },
      { isNotificationEnabled: () => false },
      { isSessionWindowFocused: () => true },
    ];

    for (const overrides of cases) {
      const harness = createHarness(overrides);
      assert.equal(harness.service.notifyTurnCompleted(harness.session), false);
      assert.equal(harness.notifications.length, 0);
    }
  });

  it("同じ Session の新しい完了通知は前の通知を閉じて置き換える", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    harness.service.notifyTurnCompleted(harness.session);

    assert.equal(harness.notifications.length, 2);
    assert.equal(harness.notifications[0]?.closed, true);
    assert.equal(harness.notifications[1]?.shown, true);
    assert.equal(harness.options[0]?.id, harness.options[1]?.id);
    assert.equal(harness.options[0]?.groupId, harness.options[1]?.groupId);

    const otherSession = createSession({ id: "other-session" });
    harness.service.notifyTurnCompleted(otherSession);
    assert.notEqual(harness.options[1]?.id, harness.options[2]?.id);
  });

  it("system timeout 後も同じ Session は同じ Windows Tag と Group で置き換える", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    harness.notifications[0]?.timeout();
    harness.service.notifyTurnCompleted(harness.session);

    assert.equal(harness.notifications[0]?.closed, false);
    assert.equal(harness.options[0]?.id, harness.options[1]?.id);
    assert.equal(harness.options[0]?.groupId, harness.options[1]?.groupId);
  });

  it("キャラアイコンを読み込めなくても通知本体を表示し、show failure は呼び出し元へ投げない", () => {
    const iconFailureHarness = createHarness({
      loadCharacterIcon() {
        throw new Error("invalid icon");
      },
    });

    assert.equal(iconFailureHarness.service.notifyTurnCompleted(iconFailureHarness.session), true);
    assert.deepEqual(iconFailureHarness.options[0], {
      id: iconFailureHarness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "WithMate",
      body: "「通知テスト」のターンが完了しました",
    });
    assert.equal(iconFailureHarness.warnings[0]?.event, "icon-load-failed");

    const showFailureHarness = createHarness({
      createNotification() {
        return {
          show() {
            throw new Error("show failed");
          },
          close() {},
          onClick() {},
          onClose() {},
          onFailed() {},
        };
      },
    });

    assert.equal(showFailureHarness.service.notifyTurnCompleted(showFailureHarness.session), false);
    assert.equal(showFailureHarness.warnings[0]?.event, "show-failed");
  });

  it("通知 click で対象 Session を開き、削除済みなら Home を開く", async () => {
    const existingHarness = createHarness();
    existingHarness.service.notifyTurnCompleted(existingHarness.session);
    existingHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(existingHarness.openedSessions, [existingHarness.session.id]);
    assert.equal(existingHarness.homeOpenCount, 0);

    const deletedHarness = createHarness({
      getSession: () => null,
    });
    deletedHarness.service.notifyTurnCompleted(deletedHarness.session);
    deletedHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(deletedHarness.openedSessions, []);
    assert.equal(deletedHarness.homeOpenCount, 1);

    const readFailureHarness = createHarness({
      async getSession() {
        throw new Error("read failed");
      },
    });
    readFailureHarness.service.notifyTurnCompleted(readFailureHarness.session);
    readFailureHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.equal(readFailureHarness.homeOpenCount, 1);
    assert.equal(readFailureHarness.warnings[0]?.event, "target-open-failed");

    const openFailureHarness = createHarness({
      async openSessionWindow() {
        throw new Error("open failed");
      },
    });
    openFailureHarness.service.notifyTurnCompleted(openFailureHarness.session);
    openFailureHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.equal(openFailureHarness.homeOpenCount, 1);
    assert.equal(openFailureHarness.warnings[0]?.event, "target-open-failed");
  });

  it("delivery failure 後は active notification から外し、次の通知時に閉じ直さない", () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);
    harness.notifications[0]?.fail(new Error("delivery failed"));

    harness.service.notifyTurnCompleted(harness.session);

    assert.equal(harness.notifications[0]?.closed, false);
    assert.equal(harness.notifications[1]?.shown, true);
    assert.equal(harness.warnings[0]?.event, "delivery-failed");
  });
});
