import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import {
  SessionTurnNotificationService,
  type SessionTurnNotificationCloseReason,
  type SessionTurnNotificationHandle,
  type SessionTurnNotificationOptions,
  type SessionTurnNotificationServiceDeps,
} from "../../src-electron/session-turn-notification-service.js";

type FakeIcon = { path: string };

class FakeNotification implements SessionTurnNotificationHandle {
  shown = false;
  closed = false;
  closeError: unknown = null;
  private clickListener: (() => void) | null = null;
  private closeListener: ((reason?: SessionTurnNotificationCloseReason) => void) | null = null;
  private failedListener: ((error: unknown) => void) | null = null;

  show(): void {
    this.shown = true;
  }

  close(): void {
    if (this.closeError) {
      throw this.closeError;
    }
    this.closed = true;
    this.closeListener?.("applicationHidden");
  }

  onClick(listener: () => void): void {
    this.clickListener = listener;
  }

  onClose(listener: (reason?: SessionTurnNotificationCloseReason) => void): void {
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
    this.closeListener?.("timedOut");
  }

  closeWithoutReason(): void {
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
    isResponsePreviewEnabled: () => false,
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
    const session = createSession({
      messages: [{ role: "assistant", text: "opt-in していないので通知へ出さない返答" }],
    });

    assert.equal(harness.service.notifyTurnCompleted(session), true);

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

  it("返答 preview が有効なら turn 最後の top-level assistant message を平文化して表示する", () => {
    const harness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [
        { role: "assistant", text: "以前の返答" },
        { role: "user", text: "続けて" },
        {
          role: "assistant",
          text: "途中の案内\n\n  うん、**40文字**でいける。\n[Session](https://example.com) を開いてね。  ",
        },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(
        session,
        "  うん、**40文字**でいける。\n[Session](https://example.com) を開いてね。  ",
      ),
      true,
    );
    assert.deepEqual(harness.options[0], {
      id: harness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "通知テスト",
      body: "うん、40文字でいける。 Session を開いてね。",
      icon: { path: "C:/characters/a.png" },
    });
  });

  it("返答 preview は Renderer の GFM 表示境界を保つ", () => {
    const harness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [{
        role: "assistant",
        text: [
          "| A**B**C | pre[link](https://example.com)post |",
          "| - | - |",
          "| A`~~literal~~`B | pre![ALT](https://example.com/image.png)post |",
        ].join("\n"),
      }],
    });

    assert.equal(harness.service.notifyTurnCompleted(session, session.messages[0]?.text ?? ""), true);
    assert.equal(
      harness.options[0]?.body,
      "ABC prelinkpost A~~literal~~B prepost",
    );
  });

  it("返答 preview は40文字以内の最後の文末を優先し、後続があれば省略記号を付ける", () => {
    const harness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [{
        role: "assistant",
        text: "うん、まだ多い。通知なら40文字上限にする。これは通知に出さないほどとても長く続く説明文なので省略します。さらに続きます。",
      }],
    });

    assert.equal(harness.service.notifyTurnCompleted(session, session.messages[0]?.text ?? ""), true);
    assert.equal(harness.options[0]?.body, "うん、まだ多い。通知なら40文字上限にする。…");
  });

  it("返答 preview は文末がなくても絵文字を分断せず40文字で切る", () => {
    const harness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const familyEmoji = "👨‍👩‍👧‍👦";
    const session = createSession({
      messages: [{
        role: "assistant",
        text: `${"あ".repeat(39)}${familyEmoji}後続`,
      }],
    });

    assert.equal(harness.service.notifyTurnCompleted(session, session.messages[0]?.text ?? ""), true);
    assert.equal(harness.options[0]?.body, `${"あ".repeat(39)}${familyEmoji}…`);
  });

  it("返答 preview が空、または設定確認に失敗した場合は完了文へ安全に戻す", () => {
    const missingSourceHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const aggregatedSession = createSession({
      messages: [{ role: "assistant", text: "途中の案内\n\n最後の案内" }],
    });

    assert.equal(missingSourceHarness.service.notifyTurnCompleted(aggregatedSession), true);
    assert.equal(missingSourceHarness.options[0]?.title, "WithMate");
    assert.equal(missingSourceHarness.options[0]?.body, "「通知テスト」のターンが完了しました");

    const emptyHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const emptySession = createSession({
      messages: [{ role: "assistant", text: " ** ** " }],
    });

    assert.equal(emptyHarness.service.notifyTurnCompleted(emptySession, " ** ** "), true);
    assert.equal(emptyHarness.options[0]?.title, "WithMate");
    assert.equal(emptyHarness.options[0]?.body, "「通知テスト」のターンが完了しました");

    const settingFailureHarness = createHarness({
      isResponsePreviewEnabled() {
        throw new Error("preview setting read failed");
      },
    });
    const responseSession = createSession({
      messages: [{ role: "assistant", text: "通知へ出せる本文" }],
    });

    assert.equal(
      settingFailureHarness.service.notifyTurnCompleted(responseSession, "通知へ出せる本文"),
      true,
    );
    assert.equal(settingFailureHarness.options[0]?.title, "WithMate");
    assert.equal(settingFailureHarness.options[0]?.body, "「通知テスト」のターンが完了しました");
    assert.equal(settingFailureHarness.warnings[0]?.event, "preview-setting-check-failed");
  });

  it("返答 preview は表示されない Markdown metadata を通知せず完了文へ戻す", () => {
    const secret = "SECRET-TOKEN";
    const cases = [
      `[](https://private.example/reset?token=${secret})`,
      `[ref]: https://private.example/reset?token=${secret}`,
      `[^1]: ${secret} footnote`,
      `$$ x % ${secret} $$`,
      ["$$", `x % ${secret}`, "$$"].join("\n"),
      ["```mermaid", "graph LR", `A[${secret}]`, "```"].join("\n"),
      ["```Mermaid", "graph LR", `A[${secret}]`, "```"].join("\n"),
      "#",
      `<!-- ${secret} -->`,
      `<div data-token="${secret}"></div>`,
    ];

    for (const text of cases) {
      const harness = createHarness({
        isResponsePreviewEnabled: () => true,
      });
      const session = createSession({
        messages: [{ role: "assistant", text }],
      });

      assert.equal(harness.service.notifyTurnCompleted(session, text), true);
      assert.equal(harness.options[0]?.title, "WithMate");
      assert.equal(harness.options[0]?.body, "「通知テスト」のターンが完了しました");
      assert.equal(harness.options[0]?.body.includes(secret), false);
    }

    const footnoteHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const footnoteSession = createSession({
      messages: [{
        role: "assistant",
        text: `表示本文[^1]\n\n[^1]: ${secret} footnote`,
      }],
    });

    assert.equal(
      footnoteHarness.service.notifyTurnCompleted(footnoteSession, footnoteSession.messages[0]?.text ?? ""),
      true,
    );
    assert.equal(footnoteHarness.options[0]?.title, "通知テスト");
    assert.equal(footnoteHarness.options[0]?.body, "表示本文");
    assert.equal(footnoteHarness.options[0]?.body.includes(secret), false);

    const mixedHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const mixedSession = createSession({
      messages: [{
        role: "assistant",
        text: [
          "表示本文",
          "",
          `$$ x % ${secret} $$`,
          "",
          "```mermaid",
          "graph LR",
          `A[${secret}]`,
          "```",
        ].join("\n"),
      }],
    });

    assert.equal(
      mixedHarness.service.notifyTurnCompleted(mixedSession, mixedSession.messages[0]?.text ?? ""),
      true,
    );
    assert.equal(mixedHarness.options[0]?.title, "通知テスト");
    assert.equal(mixedHarness.options[0]?.body, "表示本文");
    assert.equal(mixedHarness.options[0]?.body.includes(secret), false);
  });

  it("返答 preview は通常の code block だけを表示対象として保持する", () => {
    const harness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [{
        role: "assistant",
        text: ["before $x$ after", "", "```ts", "const value = 1;", "```"].join("\n"),
      }],
    });

    assert.equal(harness.service.notifyTurnCompleted(session, session.messages[0]?.text ?? ""), true);
    assert.equal(harness.options[0]?.body, "before $x$ after const value = 1;");
  });

  it("返答 preview は65536 code unitsを超える本文を解析せず完了文へ戻す", () => {
    const withinLimitHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const prefix = "表示できる。";
    const withinLimitSession = createSession({
      messages: [{
        role: "assistant",
        text: `${prefix}${"[".repeat(65_536 - prefix.length)}`,
      }],
    });

    assert.equal(
      withinLimitHarness.service.notifyTurnCompleted(withinLimitSession, withinLimitSession.messages[0]?.text ?? ""),
      true,
    );
    assert.equal(withinLimitHarness.options[0]?.title, "通知テスト");
    assert.equal(withinLimitHarness.options[0]?.body, `${prefix}…`);

    const overLimitHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const overLimitSession = createSession({
      messages: [{
        role: "assistant",
        text: "[".repeat(65_537),
      }],
    });

    assert.equal(
      overLimitHarness.service.notifyTurnCompleted(overLimitSession, overLimitSession.messages[0]?.text ?? ""),
      true,
    );
    assert.equal(overLimitHarness.options[0]?.title, "WithMate");
    assert.equal(overLimitHarness.options[0]?.body, "「通知テスト」のターンが完了しました");
  });

  it("Windows 以外、非対応、設定無効、対象 Session Window focus 中は通知しない", () => {
    const cases: Array<Partial<SessionTurnNotificationServiceDeps<FakeIcon>>> = [
      { platform: "darwin" },
      { isNotificationSupported: () => false },
      { isNotificationEnabled: () => false },
      { isNotificationEnabled: () => false, isResponsePreviewEnabled: () => true },
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

    assert.equal(harness.notifications[0]?.closed, true);
    assert.equal(harness.options[0]?.id, harness.options[1]?.id);
    assert.equal(harness.options[0]?.groupId, harness.options[1]?.groupId);
  });

  it("system timeout 後に Session を削除すると Action Center の通知を閉じる", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    harness.notifications[0]?.timeout();
    harness.service.dismissSessionNotification(harness.session.id);

    assert.equal(harness.notifications[0]?.closed, true);
  });

  it("Session 削除時の通知撤去失敗は記録し、削除処理の呼び出し元へ投げない", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    const notification = harness.notifications[0];
    assert.ok(notification);
    notification.closeError = new Error("close failed");

    assert.doesNotThrow(() => harness.service.dismissSessionNotification(harness.session.id));
    assert.equal(harness.warnings[0]?.event, "dismiss-close-failed");
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

  it("同じ通知の click が多重発火しても対象 Session は一度だけ開く", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.click();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, [harness.session.id]);
    assert.equal(harness.homeOpenCount, 0);
  });

  it("置き換え済み通知の遅延 click は無視し、現在の通知だけが対象 Session を開く", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.click();
    harness.notifications[1]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, [harness.session.id]);
    assert.equal(harness.homeOpenCount, 0);
  });

  it("system timeout 後も現在の通知なら Action Center から対象 Session を開く", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.timeout();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, [harness.session.id]);
    assert.equal(harness.homeOpenCount, 0);
  });

  it("reason 不明の close 後に遅延 click が届いても対象を開かない", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.closeWithoutReason();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, []);
    assert.equal(harness.homeOpenCount, 0);
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
