import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import {
  SessionTurnNotificationService,
  type SessionTurnNotificationCloseReason,
  type SessionTurnNotificationHandle,
  type SessionTurnNotificationOptions,
  type SessionTurnNotificationServiceDeps,
} from "../../src-electron/session/session-turn-notification-service.js";

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
  const openedAuxiliarySessions: Array<{ parentSessionId: string; auxiliarySessionId: string }> = [];
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
    openAuxiliarySessionWindow: (parentSessionId, auxiliarySessionId) => {
      openedAuxiliarySessions.push({ parentSessionId, auxiliarySessionId });
    },
    openHomeWindow: () => {
      homeOpenCount += 1;
    },
    logWarning: (event, sessionId, error) => {
      warnings.push({ event, sessionId, error });
    },
    ...overrides,
  };

  const terminalService = new SessionTurnNotificationService(deps);

  return {
    session,
    terminalService,
    service: {
      notifyTurnCompleted(completedSession: Session, lastNonEmptyAssistantMessageText = "") {
        return terminalService.notifyTurnTerminal({
          outcome: "completed",
          session: completedSession,
          lastNonEmptyAssistantMessageText,
        });
      },
      dismissSessionNotification(sessionId: string) {
        terminalService.dismissSessionNotification(sessionId);
      },
    },
    notifications,
    options,
    openedSessions,
    openedAuxiliarySessions,
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
  // @test-value v2
  // kind = "contract"
  // claim = "並行する通知設定読込みの失敗は順序によらず通知service内で処理し、previewだけの失敗は固定文へ戻す"
  // oracle = { type = "contract", ref = "docs/adr/006-windows-session-turn-notifications.md#decision" }
  // fault = "先行するeligibility失敗の早期returnかpreview先行失敗で未処理rejectionを残す"
  // observable = "設定失敗のwarning、通知の有無と本文、および未処理rejectionによるrunner failure"
  // observation_boundary = "public-boundary"
  // scope = "notification-async-settings-failure"
  // lifecycle = "permanent"
  // impact = "任意の通知の失敗をprocessのfatal診断へ漏らさず、preview取得失敗で本文を露出しない"
  // distinction = "同期throwの既存testでは扱えないPromise拒否の先後をevent loop単位で確認する"
  // @end-test-value
  it("通知設定の並行失敗をどちらの順序でも処理する", async () => {
    for (const order of ["enabled-first", "preview-first", "preview-only"] as const) {
      let resolveEnabled!: (enabled: boolean) => void;
      let rejectEnabled!: (error: Error) => void;
      let rejectPreview!: (error: Error) => void;
      const enabled = new Promise<boolean>((resolve, reject) => { resolveEnabled = resolve; rejectEnabled = reject; });
      const preview = new Promise<boolean>((_resolve, reject) => { rejectPreview = reject; });
      const enabledError = new Error("settings unavailable");
      const previewError = new Error("preview settings unavailable");
      const harness = createHarness({ isNotificationEnabled: () => enabled, isResponsePreviewEnabled: () => preview });
      const pending = harness.service.notifyTurnCompleted(harness.session, "private preview");
      if (order === "enabled-first") {
        rejectEnabled(enabledError);
        assert.equal(await pending, false);
        rejectPreview(previewError);
      } else {
        rejectPreview(previewError);
        await flushAsyncListeners();
        if (order === "preview-only") resolveEnabled(true);
        else rejectEnabled(enabledError);
      }
      assert.equal(await pending, order === "preview-only");
      await flushAsyncListeners();
      assert.deepEqual(harness.warnings.map(({ event }) => event).sort(), order === "preview-only"
        ? ["preview-setting-check-failed"]
        : ["eligibility-check-failed", "preview-setting-check-failed"]);
      assert.equal(harness.warnings.find(({ event }) => event === "preview-setting-check-failed")?.error, previewError);
      if (order === "preview-only") {
        assert.equal(harness.options[0]?.body, "通知テスト: turn completed.");
        assert.equal(harness.notifications[0]?.shown, true);
      } else {
        assert.equal(harness.notifications.length, 0);
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "failed通知は保存済みSessionの識別情報だけから成功通知と区別できる固定文を作り、同一Sessionの通知置換とCharacter iconを共有する"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "failed通知へassistant本文またはraw provider errorが露出するか、成功通知と別の置換・icon経路を通って重複通知になる"
  // observable = "terminal notification options, closed notification, and icon path"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-terminal-notification-content"
  // lifecycle = "permanent"
  // distinction = "既存の成功preview testではなく、failed outcomeの固定contentと成功通知からの置換を検証する"
  // @end-test-value
  it("failed 通知は安全な固定文を使い、同じ Session の成功通知を置き換える", () => {
    const harness = createHarness({ isResponsePreviewEnabled: () => true });
    const failedSession = createSession({
      messages: [{ role: "assistant", text: "secret-token raw provider error" }],
    });

    assert.equal(harness.service.notifyTurnCompleted(failedSession, "成功preview"), true);
    assert.equal(harness.terminalService.notifyTurnTerminal({
      outcome: "failed",
      session: failedSession,
    }), true);

    assert.equal(harness.notifications[0]?.closed, true);
    assert.deepEqual(harness.options[1], {
      id: harness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "WithMate",
      body: "通知テスト: turn failed.",
      icon: { path: "C:/characters/a.png" },
    });
    assert.doesNotMatch(harness.options[1]?.body ?? "", /secret-token|provider error|成功preview/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Windowsで通知設定が有効かつSession Windowが非focusなら、Character icon付きの完了通知を表示する"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "非focus条件を誤判定して通知を抑止するか、通知本文またはCharacter iconを欠落させる"
  // observable = "notification options, shown state, and icon path"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-completed-notification-eligibility"
  // lifecycle = "permanent"
  // impact = "バックグラウンドで完了したSessionを通知から把握できない"
  // distinction = "Windows・非focus・opt-inの条件と通知表示結果を同時に確認する"
  // @end-test-value
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
      body: "通知テスト: turn completed.",
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

  // @test-value v2
  // kind = "contract"
  // claim = "返答previewが空またはpreview設定確認に失敗した場合は、固定の完了文へ安全に戻す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "空previewや設定例外を通知本文へ露出するか、通知を失敗扱いにして完了を知らせない"
  // observable = "notification title/body, shown state, and warning event"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-preview-fallback"
  // lifecycle = "permanent"
  // impact = "内部本文が通知へ露出するか、完了通知が欠落する"
  // distinction = "空入力と設定read failureを個別に通し、同じ固定fallbackとwarningを確認する"
  // @end-test-value
  it("返答 preview が空、または設定確認に失敗した場合は完了文へ安全に戻す", () => {
    const missingSourceHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const aggregatedSession = createSession({
      messages: [{ role: "assistant", text: "途中の案内\n\n最後の案内" }],
    });

    assert.equal(missingSourceHarness.service.notifyTurnCompleted(aggregatedSession), true);
    assert.equal(missingSourceHarness.options[0]?.title, "WithMate");
    assert.equal(missingSourceHarness.options[0]?.body, "通知テスト: turn completed.");

    const emptyHarness = createHarness({
      isResponsePreviewEnabled: () => true,
    });
    const emptySession = createSession({
      messages: [{ role: "assistant", text: " ** ** " }],
    });

    assert.equal(emptyHarness.service.notifyTurnCompleted(emptySession, " ** ** "), true);
    assert.equal(emptyHarness.options[0]?.title, "WithMate");
    assert.equal(emptyHarness.options[0]?.body, "通知テスト: turn completed.");

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
    assert.equal(settingFailureHarness.options[0]?.body, "通知テスト: turn completed.");
    assert.equal(settingFailureHarness.warnings[0]?.event, "preview-setting-check-failed");
  });

  // @test-value v2
  // kind = "security"
  // claim = "表示されないMarkdown metadataだけのpreviewは通知せず、固定の完了文へ戻す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "link reference、footnote、math、diagram、HTML commentなどのmetadataやtokenを通知本文へ露出する"
  // observable = "notification body and shown state for each metadata-only input"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-markdown-preview-filter"
  // lifecycle = "permanent"
  // impact = "非表示metadataに含まれるtokenや内部情報がOS通知へ露出する"
  // distinction = "複数のMarkdown metadata形状を通し、各通知が固定fallbackになることを直接確認する"
  // risk_tags = ["privacy"]
  // @end-test-value
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
      assert.equal(harness.options[0]?.body, "通知テスト: turn completed.");
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

  // @test-value v2
  // kind = "contract"
  // claim = "65536 code unitsを超える返答previewは解析せず固定の完了文へ戻し、上限内の本文は通常previewを保つ"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "preview上限を超える本文を解析して通知へ露出するか、上限内の本文まで固定文へ置換する"
  // observable = "within-limit and over-limit notification bodies"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-preview-size-limit"
  // lifecycle = "permanent"
  // impact = "大きな本文が通知処理を過剰に実行するか、利用者が完了内容を確認できない"
  // distinction = "上限境界の直前と超過を同じ通知serviceへ入力して結果を比較する"
  // @end-test-value
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
    assert.equal(overLimitHarness.options[0]?.body, "通知テスト: turn completed.");
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

  // @test-value v2
  // kind = "contract"
  // claim = "Character iconのload failureでも通知本体を表示し、OS notificationのshow failureを呼び出し元へ投げない"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "icon loadまたはnotification showの例外で通知処理がthrowするか、通知本文まで失われる"
  // observable = "notify result, notification options, and warning events"
  // observation_boundary = "public-boundary"
  // scope = "session-turn-notification-error-isolation"
  // lifecycle = "permanent"
  // impact = "通知機能の補助失敗がSession完了処理や呼び出し元へ波及する"
  // distinction = "icon failureとshow failureを別harnessで確認し、本文表示とwarningだけを観測する"
  // @end-test-value
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
      body: "通知テスト: turn completed.",
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

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliaryのterminal通知は親Session Windowのfocusを判定し、clickで指定されたAuxiliaryだけを開く"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "Auxiliary完了時に通知されない、親Windowではなく子IDをfocus判定へ渡す、clickでMain Windowを開く、または指定IDを失う"
  // observable = "通知生成、focus判定へ渡したSession ID、通知ID、click後のAuxiliary navigation payload"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-session-turn-notification"
  // lifecycle = "permanent"
  // distinction = "通常Sessionのclick testでは観測できない親Windowと子会話のID分離、通知IDの分離、およびAuxiliary navigationを専用に検証する"
  // @end-test-value
  it("Auxiliary通知は親Windowを基準に指定されたAuxiliaryを開く", async () => {
    const focusedSessionIds: string[] = [];
    const auxiliary = createSession({ id: "runtime-auxiliary-1" });
    const firstTarget = {
      kind: "auxiliary" as const,
      parentSessionId: "parent-session-1",
      auxiliarySessionId: "stored-auxiliary-1",
    };
    const focusedHarness = createHarness({
      isSessionWindowFocused: (sessionId) => {
        focusedSessionIds.push(sessionId);
        return sessionId === firstTarget.parentSessionId;
      },
    });

    assert.equal(focusedHarness.terminalService.notifyTurnTerminal({
      outcome: "completed",
      session: auxiliary,
      lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
    }, firstTarget), false);
    assert.deepEqual(focusedSessionIds, [firstTarget.parentSessionId]);
    assert.equal(focusedHarness.notifications.length, 0);

    const harness = createHarness({
      isSessionWindowFocused: (sessionId) => {
        focusedSessionIds.push(sessionId);
        return false;
      },
    });
    assert.equal(harness.terminalService.notifyTurnTerminal({
      outcome: "completed",
      session: auxiliary,
      lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
    }, firstTarget), true);
    harness.notifications[0]?.click();
    await flushAsyncListeners();
    assert.deepEqual(harness.openedAuxiliarySessions, [{
      parentSessionId: firstTarget.parentSessionId,
      auxiliarySessionId: firstTarget.auxiliarySessionId,
    }]);

    const secondTarget = {
      ...firstTarget,
      auxiliarySessionId: "stored-auxiliary-2",
    };
    assert.equal(harness.terminalService.notifyTurnTerminal({
      outcome: "completed",
      session: auxiliary,
      lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
    }, secondTarget), true);
    assert.notEqual(harness.options[0]?.id, harness.options[1]?.id);
    assert.equal(harness.notifications[0]?.closed, false);

    harness.notifications[1]?.click();
    await flushAsyncListeners();

    assert.deepEqual(focusedSessionIds, [
      firstTarget.parentSessionId,
      firstTarget.parentSessionId,
      firstTarget.parentSessionId,
    ]);
    assert.deepEqual(harness.openedAuxiliarySessions, [
      {
        parentSessionId: firstTarget.parentSessionId,
        auxiliarySessionId: firstTarget.auxiliarySessionId,
      },
      {
        parentSessionId: secondTarget.parentSessionId,
        auxiliarySessionId: secondTarget.auxiliarySessionId,
      },
    ]);
    assert.deepEqual(harness.openedSessions, []);
    assert.equal(harness.homeOpenCount, 0);
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
