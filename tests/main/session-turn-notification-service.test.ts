import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  buildNewSession,
  type Session,
} from "../../src-shared/session/session-state.js";
import {
  SessionTurnNotificationService,
  type SessionTurnNotificationCloseReason,
  type SessionTurnNotificationHandle,
  type SessionTurnNotificationOptions,
  type SessionTurnNotificationServiceDeps,
} from "../../src-electron/session/session-turn-notification-service.js";

/** ネイティブ画像を作らず、通知に選ばれたアイコンのパスを検査する型。 */
type FakeIcon = { path: string };

/** OS 通知を表示せず、登録されたイベントとその呼び出しを観測可能にする。 */
class FakeNotification implements SessionTurnNotificationHandle {
  shown = false;
  closed = false;
  closeError: unknown = null;
  private clickListener: (() => void) | null = null;
  private closeListener:
    ((reason?: SessionTurnNotificationCloseReason) => void) | null = null;
  private failedListener: ((error: unknown) => void) | null = null;

  /** 本物の OS 通知を表示せず、表示要求だけを記録する。 */
  show(): void {
    this.shown = true;
  }

  /** 設定した例外がなければアプリによる非表示として閉じ、購読者へ理由を届ける。 */
  close(): void {
    if (this.closeError) {
      throw this.closeError;
    }
    this.closed = true;
    this.closeListener?.("applicationHidden");
  }

  /** 後から擬似クリックを届ける宛先を登録する。 */
  onClick(listener: () => void): void {
    this.clickListener = listener;
  }

  /** 明示撤去やタイムアウトを通知するリスナーを保持する。 */
  onClose(
    listener: (reason?: SessionTurnNotificationCloseReason) => void,
  ): void {
    this.closeListener = listener;
  }

  /** 配信に失敗したときに呼ぶリスナーを保持する。 */
  onFailed(listener: (error: unknown) => void): void {
    this.failedListener = listener;
  }

  /** 通常クリックや遅れて届いたクリックを、登録済みのリスナーに送る。 */
  click(): void {
    this.clickListener?.();
  }

  /** 通知ドライバーの配送失敗をリスナーに伝える。 */
  fail(error: unknown): void {
    this.failedListener?.(error);
  }

  /** アプリからの撤去とは区別して OS による表示期限切れを伝える。 */
  timeout(): void {
    this.closeListener?.("timedOut");
  }

  /** 理由情報が付かない場合の close を通知する。 */
  closeWithoutReason(): void {
    this.closeListener?.();
  }
}

/** 共通の表示名とアイコンを持ち、対象 identity や応答を各ケースで差し替えられるセッションを作る。 */
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

/** 通知生成、ウィンドウ遷移、警告を記録し、通知の成立条件だけを個別に上書きできるようにする。 */
function createHarness(
  overrides?: Partial<SessionTurnNotificationServiceDeps<FakeIcon>>,
) {
  const session = createSession();
  const notifications: FakeNotification[] = [];
  const options: SessionTurnNotificationOptions<FakeIcon>[] = [];
  const openedSessions: string[] = [];
  const openedAuxiliarySessions: Array<{
    parentSessionId: string;
    auxiliarySessionId: string;
  }> = [];
  let homeOpenCount = 0;
  const warnings: Array<{ event: string; sessionId: string; error?: unknown }> =
    [];
  const deps: SessionTurnNotificationServiceDeps<FakeIcon> = {
    platform: "win32",
    /** 既定では OS が通知に対応しているものとする。 */
    isNotificationSupported: () => true,
    /** 完了・質問の通知が成立するよう、既定設定では通知を有効にする。 */
    isNotificationEnabled: () => true,
    /** 完了用設定とは別に、承認通知を既定で許可する。 */
    isApprovalNotificationEnabled: () => true,
    /** 本文のプレビューは必要なケースだけで有効にする。 */
    isResponsePreviewEnabled: () => false,
    /** 通知対象のウィンドウは既定では開いているものとする。 */
    isSessionWindowOpen: () => true,
    /** 既定では対象を非フォーカスにし、通知を抑止しない。 */
    isSessionWindowFocused: () => false,
    /** 画像の代わりにパスを保持し、表示用オプションの比較に使う。 */
    loadCharacterIcon: (iconPath) => ({ path: iconPath }),
    /** 通知のインスタンスと生成時のオプションを同じ順に保存する。 */
    createNotification: (nextOptions) => {
      const notification = new FakeNotification();
      notifications.push(notification);
      options.push(nextOptions);
      return notification;
    },
    /** クリック時も対象セッションを開ける既定の検索結果を返す。 */
    getSession: () => session,
    /** Main のウィンドウを開く要求を識別子で記録する。 */
    openSessionWindow: (sessionId) => {
      openedSessions.push(sessionId);
    },
    /** Auxiliary を開く要求を親と子の組み合わせで記録する。 */
    openAuxiliarySessionWindow: (parentSessionId, auxiliarySessionId) => {
      openedAuxiliarySessions.push({ parentSessionId, auxiliarySessionId });
    },
    /** クリックが Home にフォールバックした回数を数える。 */
    openHomeWindow: () => {
      homeOpenCount += 1;
    },
    /** 通知処理が隔離した失敗をイベント・対象・原因とともに保存する。 */
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
      /** 正常終了した Turn の通知を、最後の応答本文を指定して実サービスに渡す。 */
      notifyTurnCompleted(
        completedSession: Session,
        lastNonEmptyAssistantMessageText = "",
      ) {
        return terminalService.notifyTurnTerminal({
          outcome: "completed",
          session: completedSession,
          lastNonEmptyAssistantMessageText,
        });
      },
      /** 指定セッションの現在の通知をサービス経由で撤去する。 */
      dismissSessionNotification(sessionId: string) {
        terminalService.dismissSessionNotification(sessionId);
      },
    },
    notifications,
    options,
    openedSessions,
    openedAuxiliarySessions,
    warnings,
    /** Home 遷移が発生した累計を参照する。 */
    get homeOpenCount() {
      return homeOpenCount;
    },
  };
}

/** OS 通知側から始まった非同期処理を次のイベントループまで進める。 */
async function flushAsyncListeners(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Windows の通知可否・文面・ライフサイクル・クリック先を実サービスの公開操作で確認する。 */
describe("SessionTurnNotificationService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "承認通知は独立設定と開いた親Windowの非focus条件を使い、Session名と承認待ちだけを通知する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "完了通知の設定へ依存するか閉じたWindowへ通知するか会話の秘密を通知する"
  // observable = "notifyApprovalの戻り値、通知数とtitle/body/icon"
  // observation_boundary = "public-boundary"
  // scope = "approval-notification-eligibility-and-privacy"
  // lifecycle = "permanent"
  // impact = "承認待ちを見落とすかOS通知に会話本文が漏れる"
  // distinction = "完了と質問の通知では独立設定とopen Window要件を検証できない"
  // @end-test-value
  /** 承認専用の設定と親ウィンドウの状態で対象を絞り、会話本文を含まない通知にする。 */
  it("承認通知は独立設定とopen Window条件で固定文を表示する", async () => {
    for (const condition of [
      "enabled",
      "disabled",
      "closed",
      "focused",
      "unsupported",
      "macOS",
    ] as const) {
      const harness = createHarness({
        platform: condition === "macOS" ? "darwin" : "win32",
        /** 完了通知は常に無効にし、承認通知が独自の設定を使うことを確かめる。 */
        isNotificationEnabled: () => false,
        /** 承認通知の設定を非同期で返し、無効の場合も扱う。 */
        isApprovalNotificationEnabled: async () => condition !== "disabled",
        /** 閉じたウィンドウに通知するかを観測できるようにする。 */
        isSessionWindowOpen: () => condition !== "closed",
        /** 対象にフォーカスがある場合だけ抑止条件を成立させる。 */
        isSessionWindowFocused: () => condition === "focused",
        /** 通知 API が使えないケースを設定から独立に指定する。 */
        isNotificationSupported: () => condition !== "unsupported",
        /** 承認通知が応答プレビュー設定を参照したらテストを失敗させる。 */
        isResponsePreviewEnabled: () => {
          throw new Error("Approval must not read preview setting");
        },
      });
      const session = createSession({
        messages: [{ role: "assistant", text: "secret command and path" }],
      });
      assert.equal(
        await harness.terminalService.notifyApproval(
          session,
          "approval-1",
          new AbortController().signal,
        ),
        condition === "enabled",
      );
      assert.equal(
        harness.notifications.length,
        condition === "enabled" ? 1 : 0,
      );
      if (condition === "enabled") {
        assert.equal(harness.notifications[0]?.shown, true);
        assert.deepEqual(harness.options[0], {
          id: harness.options[0]?.id,
          groupId: "WithMateSessions",
          title: "WithMate",
          body: "通知テスト: approval required.",
          icon: { path: "C:/characters/a.png" },
        });
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同一承認要求は一度だけ通知し、重複呼出しを含むいずれかの解決は通知と遅延表示を撤去するが後続通知へ干渉しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "並行する同一requestで二重通知するか解決済み通知を表示するか古いsignalで後続通知を閉じる"
  // observable = "notifyApprovalの戻り値と通知instanceの数、shown、closed"
  // observation_boundary = "public-boundary"
  // scope = "approval-notification-request-lifetime"
  // lifecycle = "permanent"
  // impact = "承認済みの通知が残るか後続の承認待ち通知を失う"
  // distinction = "非同期設定読込みとrequestの生存期間の競合は型検査では観測できない"
  // @end-test-value
  /** 同じ承認の二重表示を防ぎ、解決済みの通知が後続の承認に影響しないことを確認する。 */
  it("承認要求を重複通知せず、解決後の表示と後続通知への干渉を防ぐ", async () => {
    let resolveEnabled!: (enabled: boolean) => void;
    const delayed = createHarness({
      /** 設定取得を保留し、結果が返る前に同じ承認を解決できるようにする。 */
      isApprovalNotificationEnabled: () =>
        new Promise((resolve) => {
          resolveEnabled = resolve;
        }),
    });
    const controller = new AbortController();
    const duplicate = new AbortController();
    const pending = delayed.terminalService.notifyApproval(
      delayed.session,
      "request-1",
      controller.signal,
    );
    assert.equal(
      await delayed.terminalService.notifyApproval(
        delayed.session,
        "request-1",
        duplicate.signal,
      ),
      false,
    );
    duplicate.abort();
    resolveEnabled(true);
    assert.equal(await pending, false);
    assert.equal(delayed.notifications.length, 0);

    const harness = createHarness();
    const first = new AbortController();
    assert.equal(
      await harness.terminalService.notifyApproval(
        harness.session,
        "request-1",
        first.signal,
      ),
      true,
    );
    harness.notifications[0]?.closeWithoutReason();
    assert.equal(
      await harness.terminalService.notifyApproval(
        harness.session,
        "request-1",
        first.signal,
      ),
      false,
    );
    first.abort();
    const second = new AbortController();
    assert.equal(
      await harness.terminalService.notifyApproval(
        harness.session,
        "request-1",
        second.signal,
      ),
      true,
    );
    const secondDuplicate = new AbortController();
    assert.equal(
      await harness.terminalService.notifyApproval(
        harness.session,
        "request-1",
        secondDuplicate.signal,
      ),
      false,
    );
    harness.notifications[1]?.timeout();
    secondDuplicate.abort();
    assert.equal(harness.notifications[1]?.closed, true);
    harness.notifications[1]?.click();
    await flushAsyncListeners();
    assert.deepEqual(harness.openedSessions, []);

    const third = new AbortController();
    await harness.terminalService.notifyApproval(
      harness.session,
      "request-2",
      third.signal,
    );
    assert.equal(harness.service.notifyTurnCompleted(harness.session), true);
    assert.equal(harness.notifications[2]?.closed, true);
    third.abort();
    assert.equal(harness.notifications[3]?.closed, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary承認通知は親Windowを判定しclickで対象Auxiliaryへ戻り、通知の作成・配送失敗は呼出元へ伝播しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "親ではなくAuxiliary IDでWindowを判定するか別会話を開くか通知失敗をthrowする"
  // observable = "Window判定ID、openAuxiliarySessionWindow引数と失敗時戻り値"
  // observation_boundary = "consumer"
  // scope = "approval-notification-target-and-failure-isolation"
  // lifecycle = "permanent"
  // impact = "承認対象の会話へ戻れないか通知不能で承認処理が失敗する"
  // distinction = "質問のtarget転送と共通通知testでは承認入口のtargetと失敗処理を通らない"
  // @end-test-value
  /** Auxiliary の承認で親を確認して子へ戻り、設定・生成・表示の失敗を呼び出し元へ投げない。 */
  it("Auxiliaryの承認対象へ戻り通知失敗を隔離する", async () => {
    const openIds: string[] = [];
    const focusIds: string[] = [];
    const harness = createHarness({
      /** 通知対象の開閉判定に使ったセッション ID を記録する。 */
      isSessionWindowOpen: (id) => {
        openIds.push(id);
        return true;
      },
      /** フォーカスを調べた対象を記録し、通知自体は抑止しない。 */
      isSessionWindowFocused: (id) => {
        focusIds.push(id);
        return false;
      },
    });
    const auxiliary = createSession({ id: "auxiliary-1" });
    assert.equal(
      await harness.terminalService.notifyApproval(
        auxiliary,
        "request-1",
        new AbortController().signal,
        {
          kind: "auxiliary",
          parentSessionId: harness.session.id,
          auxiliarySessionId: auxiliary.id,
        },
      ),
      true,
    );
    harness.notifications[0]?.click();
    await flushAsyncListeners();
    assert.deepEqual(openIds, [harness.session.id]);
    assert.deepEqual(focusIds, [harness.session.id]);
    assert.deepEqual(harness.openedAuxiliarySessions, [
      { parentSessionId: harness.session.id, auxiliarySessionId: auxiliary.id },
    ]);

    for (const overrides of [
      {
        /** 通知を作る前に承認向け設定の取得を失敗させる。 */
        isApprovalNotificationEnabled: async () => {
          throw new Error("settings failed");
        },
      },
      {
        /** 設定取得後、通知インスタンスを生成できない場合を模擬する。 */
        createNotification: () => {
          throw new Error("create failed");
        },
      },
      {
        /** インスタンス生成までは成功し、OS への表示要求だけで失敗する。 */
        createNotification: () =>
          Object.assign(new FakeNotification(), {
            /** 表示ドライバーの例外を発生させる。 */
            show() {
              throw new Error("show failed");
            },
          }),
      },
    ]) {
      const failed = createHarness(overrides);
      assert.equal(
        await failed.terminalService.notifyApproval(
          failed.session,
          "request-1",
          new AbortController().signal,
        ),
        false,
      );
      assert.equal(failed.warnings.length, 1);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codex質問通知は既存のWindows・設定・対象Window非focus条件を使い、本文previewを読まず固定文とCharacter iconで通知する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "対象Windowのfocusや設定を無視するか質問通知に会話本文を露出する"
  // observable = "通知表示の有無、title/body/iconとpreview設定読込み回数"
  // observation_boundary = "public-boundary"
  // scope = "Codex question notification eligibility and content"
  // lifecycle = "permanent"
  // impact = "入力待ちを見落とすか秘密を含む会話内容がOS通知に表示される"
  // distinction = "完了previewのtestでは質問通知のeligibilityと固定文を確認できず、軽量なfake通知で継続確認する"
  // @end-test-value
  /** 質問では既存の通知設定とフォーカス条件を使い、本文の代わりに固定の案内を出す。 */
  it("質問を固定文で通知し、既存の通知条件を維持する", async () => {
    for (const condition of [
      "enabled",
      "disabled",
      "focused",
      "unsupported",
      "macOS",
    ] as const) {
      let previewReads = 0;
      const harness = createHarness({
        platform: condition === "macOS" ? "darwin" : "win32",
        /** 質問に使う通知設定をケースに応じて非同期で返す。 */
        isNotificationEnabled: async () => condition !== "disabled",
        /** ネイティブ通知のサポート外を独立に切り替える。 */
        isNotificationSupported: () => condition !== "unsupported",
        /** フォーカス中の質問通知が抑止される状態を指定する。 */
        isSessionWindowFocused: () => condition === "focused",
        /** プレビューが有効でも質問通知が設定を参照しないことを、呼び出し回数で判定する。 */
        isResponsePreviewEnabled: () => {
          previewReads++;
          return true;
        },
      });
      const session = createSession({
        messages: [{ role: "assistant", text: "secret conversation" }],
      });
      assert.equal(
        await harness.terminalService.notifyQuestion(
          session,
          new AbortController().signal,
        ),
        condition === "enabled",
      );
      assert.equal(previewReads, 0);
      assert.equal(
        harness.notifications.length,
        condition === "enabled" ? 1 : 0,
      );
      if (condition === "enabled") {
        assert.equal(harness.notifications[0]?.shown, true);
        assert.deepEqual(harness.options[0], {
          id: harness.options[0]?.id,
          groupId: "WithMateSessions",
          title: "WithMate",
          body: "通知テスト: Codex has a question.",
          icon: { path: "C:/characters/a.png" },
        });
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "質問の解決は表示済み通知を閉じ、設定読込み中の遅延通知を抑止し、後続の同会話通知は閉じない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "解決後に古い質問通知を表示するか、古いsignalで次の通知を撤去する"
  // observable = "notifyQuestion結果、通知instanceのshown/closedと遅延clickによるWindow open件数"
  // observation_boundary = "public-boundary"
  // scope = "question notification resolution and replacement"
  // lifecycle = "permanent"
  // impact = "回答済み質問の通知が残るか、次の入力待ち通知を利用者が受け取れない"
  // distinction = "設定Promiseと質問解決のraceは型検査やterminal通知testでは捕捉できない"
  // @end-test-value
  /** 質問の解決時に既存通知を閉じ、設定の遅延完了や古いシグナルの影響を抑える。 */
  it("解決済みの質問通知を撤去し、遅延表示と後続通知への干渉を防ぐ", async () => {
    let resolveEnabled!: (enabled: boolean) => void;
    const delayed = createHarness({
      /** 質問の解決を、通知設定が非同期で返る前に割り込ませる。 */
      isNotificationEnabled: () =>
        new Promise((resolve) => {
          resolveEnabled = resolve;
        }),
    });
    const canceled = new AbortController();
    const pending = delayed.terminalService.notifyQuestion(
      delayed.session,
      canceled.signal,
    );
    canceled.abort();
    resolveEnabled(true);
    assert.equal(await pending, false);
    assert.equal(delayed.notifications.length, 0);

    const harness = createHarness();
    const first = new AbortController();
    assert.equal(
      await harness.terminalService.notifyQuestion(
        harness.session,
        first.signal,
      ),
      true,
    );
    harness.notifications[0]?.timeout();
    first.abort();
    assert.equal(harness.notifications[0]?.closed, true);
    harness.notifications[0]?.click();
    await flushAsyncListeners();
    assert.deepEqual(harness.openedSessions, []);

    const second = new AbortController();
    assert.equal(
      await harness.terminalService.notifyQuestion(
        harness.session,
        second.signal,
      ),
      true,
    );
    assert.equal(harness.service.notifyTurnCompleted(harness.session), true);
    assert.equal(harness.notifications[1]?.closed, true);
    second.abort();
    assert.equal(harness.notifications[2]?.closed, false);
    harness.notifications[2]?.click();
    await flushAsyncListeners();
    assert.deepEqual(harness.openedSessions, [harness.session.id]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary質問通知は親Windowのfocusを判定し、クリックでその親の対象Auxiliaryへ戻る"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
  // fault = "Auxiliary IDでWindowを探索するか通知clickでMain会話を開く"
  // observable = "focus判定対象IDとopenAuxiliarySessionWindow引数"
  // observation_boundary = "consumer"
  // scope = "Auxiliary Codex question notification target"
  // lifecycle = "permanent"
  // impact = "質問への回答先を取り違えるか親Window非focus時の質問を通知しない"
  // distinction = "質問notifyQuestion入口のtarget転送はterminal通知の既存testだけでは保証されない"
  // @end-test-value
  /** Auxiliary の質問を表示するときに親のフォーカスを照会し、クリックは子を開く。 */
  it("Auxiliaryの質問通知から対象会話へ戻る", async () => {
    const focusIds: string[] = [];
    const harness = createHarness({
      /** フォーカス照会の対象を保存し、親が非フォーカスの状態を作る。 */
      isSessionWindowFocused: (id) => {
        focusIds.push(id);
        return false;
      },
    });
    const auxiliary = createSession({ id: "auxiliary-1" });
    assert.equal(
      await harness.terminalService.notifyQuestion(
        auxiliary,
        new AbortController().signal,
        {
          kind: "auxiliary",
          parentSessionId: harness.session.id,
          auxiliarySessionId: auxiliary.id,
        },
      ),
      true,
    );
    harness.notifications[0]?.click();
    await flushAsyncListeners();
    assert.deepEqual(focusIds, [harness.session.id]);
    assert.deepEqual(harness.openedAuxiliarySessions, [
      { parentSessionId: harness.session.id, auxiliarySessionId: auxiliary.id },
    ]);
    assert.deepEqual(harness.openedSessions, []);
  });

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
  /** 二種類の非同期設定の失敗を順序によらず隔離し、プレビューだけの失敗では固定文を使う。 */
  it("通知設定の並行失敗をどちらの順序でも処理する", async () => {
    for (const order of [
      "enabled-first",
      "preview-first",
      "preview-only",
    ] as const) {
      let resolveEnabled!: (enabled: boolean) => void;
      let rejectEnabled!: (error: Error) => void;
      let rejectPreview!: (error: Error) => void;
      const enabled = new Promise<boolean>((resolve, reject) => {
        resolveEnabled = resolve;
        rejectEnabled = reject;
      });
      const preview = new Promise<boolean>((_resolve, reject) => {
        rejectPreview = reject;
      });
      const enabledError = new Error("settings unavailable");
      const previewError = new Error("preview settings unavailable");
      const harness = createHarness({
        /** 通知自体の設定取得を、任意の順序で失敗させられるようにする。 */
        isNotificationEnabled: () => enabled,
        /** 別の Promise を返し、応答プレビュー設定だけでも失敗を再現できるようにする。 */
        isResponsePreviewEnabled: () => preview,
      });
      const pending = harness.service.notifyTurnCompleted(
        harness.session,
        "private preview",
      );
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
      assert.deepEqual(
        harness.warnings.map(({ event }) => event).sort(),
        order === "preview-only"
          ? ["preview-setting-check-failed"]
          : ["eligibility-check-failed", "preview-setting-check-failed"],
      );
      assert.equal(
        harness.warnings.find(
          ({ event }) => event === "preview-setting-check-failed",
        )?.error,
        previewError,
      );
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
  /** 本文・エラー詳細を失敗通知へ渡さず、既存の成功通知を同じセッションで置き換える。 */
  it("failed 通知は安全な固定文を使い、同じ Session の成功通知を置き換える", () => {
    const harness = createHarness({
      /** プレビュー許可済みでも失敗通知には本文が含まれない状態を作る。 */
      isResponsePreviewEnabled: () => true,
    });
    const failedSession = createSession({
      messages: [
        { role: "assistant", text: "secret-token raw provider error" },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(failedSession, "成功preview"),
      true,
    );
    assert.equal(
      harness.terminalService.notifyTurnTerminal({
        outcome: "failed",
        session: failedSession,
      }),
      true,
    );

    assert.equal(harness.notifications[0]?.closed, true);
    assert.deepEqual(harness.options[1], {
      id: harness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "WithMate",
      body: "通知テスト: turn failed.",
      icon: { path: "C:/characters/a.png" },
    });
    assert.doesNotMatch(
      harness.options[1]?.body ?? "",
      /secret-token|provider error|成功preview/,
    );
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
  /** 有効な Windows 環境で非フォーカスのセッションの完了を、アイコン付きで知らせる。 */
  it("Windows で設定が有効かつ対象 Session Window が非 focus ならキャラアイコン付きで通知する", () => {
    const harness = createHarness();
    const session = createSession({
      messages: [
        { role: "assistant", text: "opt-in していないので通知へ出さない返答" },
      ],
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

  /** 会話全体ではなく当該 Turn の最後の親応答だけを、通知用の平文にする。 */
  it("返答 preview が有効なら turn 最後の top-level assistant message を平文化して表示する", () => {
    const harness = createHarness({
      /** 応答の投影元を確認するため、既定では無効なプレビューを有効にする。 */
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

  /** プレビュー向けの平文化でも、GFM として画面に表示される範囲を守る。 */
  it("返答 preview は Renderer の GFM 表示境界を保つ", () => {
    const harness = createHarness({
      /** GFM から得られる表示本文を比較できるようにする。 */
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [
        {
          role: "assistant",
          text: [
            "| A**B**C | pre[link](https://example.com)post |",
            "| - | - |",
            "| A`~~literal~~`B | pre![ALT](https://example.com/image.png)post |",
          ].join("\n"),
        },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(
        session,
        session.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(
      harness.options[0]?.body,
      "ABC prelinkpost A~~literal~~B prepost",
    );
  });

  /** 通知の文字数内で最後の文末までを表示し、残った内容を省略記号で示す。 */
  it("返答 preview は40文字以内の最後の文末を優先し、後続があれば省略記号を付ける", () => {
    const harness = createHarness({
      /** 固定の完了文でなく、文末での省略経路を選ぶ。 */
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [
        {
          role: "assistant",
          text: "うん、まだ多い。通知なら40文字上限にする。これは通知に出さないほどとても長く続く説明文なので省略します。さらに続きます。",
        },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(
        session,
        session.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(
      harness.options[0]?.body,
      "うん、まだ多い。通知なら40文字上限にする。…",
    );
  });

  /** 長文に文末がないときも、複数コードポイントの絵文字を途中で切らない。 */
  it("返答 preview は文末がなくても絵文字を分断せず40文字で切る", () => {
    const harness = createHarness({
      /** 絵文字の切り詰めを観測できるようにプレビューを使う。 */
      isResponsePreviewEnabled: () => true,
    });
    const familyEmoji = "👨‍👩‍👧‍👦";
    const session = createSession({
      messages: [
        {
          role: "assistant",
          text: `${"あ".repeat(39)}${familyEmoji}後続`,
        },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(
        session,
        session.messages[0]?.text ?? "",
      ),
      true,
    );
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
  /** 本文の欠落、平文化後の空文字、設定取得失敗を固定の完了文へ落とす。 */
  it("返答 preview が空、または設定確認に失敗した場合は完了文へ安全に戻す", () => {
    const missingSourceHarness = createHarness({
      /** 元のトップレベル応答が欠けるケースでも、設定上はプレビューを許可する。 */
      isResponsePreviewEnabled: () => true,
    });
    const aggregatedSession = createSession({
      messages: [{ role: "assistant", text: "途中の案内\n\n最後の案内" }],
    });

    assert.equal(
      missingSourceHarness.service.notifyTurnCompleted(aggregatedSession),
      true,
    );
    assert.equal(missingSourceHarness.options[0]?.title, "WithMate");
    assert.equal(
      missingSourceHarness.options[0]?.body,
      "通知テスト: turn completed.",
    );

    const emptyHarness = createHarness({
      /** 平文化で何も残らないケースをプレビューの有効状態で確認する。 */
      isResponsePreviewEnabled: () => true,
    });
    const emptySession = createSession({
      messages: [{ role: "assistant", text: " ** ** " }],
    });

    assert.equal(
      emptyHarness.service.notifyTurnCompleted(emptySession, " ** ** "),
      true,
    );
    assert.equal(emptyHarness.options[0]?.title, "WithMate");
    assert.equal(emptyHarness.options[0]?.body, "通知テスト: turn completed.");

    const settingFailureHarness = createHarness({
      /** 応答プレビュー設定を読み出せない場合の例外を再現する。 */
      isResponsePreviewEnabled() {
        throw new Error("preview setting read failed");
      },
    });
    const responseSession = createSession({
      messages: [{ role: "assistant", text: "通知へ出せる本文" }],
    });

    assert.equal(
      settingFailureHarness.service.notifyTurnCompleted(
        responseSession,
        "通知へ出せる本文",
      ),
      true,
    );
    assert.equal(settingFailureHarness.options[0]?.title, "WithMate");
    assert.equal(
      settingFailureHarness.options[0]?.body,
      "通知テスト: turn completed.",
    );
    assert.equal(
      settingFailureHarness.warnings[0]?.event,
      "preview-setting-check-failed",
    );
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
  /** 表示されない Markdown の定義や注記の秘匿を確かめ、表示本文がなければ固定文に戻す。 */
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
        /** プレビューを有効にして、非表示のメタデータしかない場合でも固定文へ戻ることを確認する。 */
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
      /** 脚注を含む本文のうち、可視部分だけを通知の候補にする経路を使う。 */
      isResponsePreviewEnabled: () => true,
    });
    const footnoteSession = createSession({
      messages: [
        {
          role: "assistant",
          text: `表示本文[^1]\n\n[^1]: ${secret} footnote`,
        },
      ],
    });

    assert.equal(
      footnoteHarness.service.notifyTurnCompleted(
        footnoteSession,
        footnoteSession.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(footnoteHarness.options[0]?.title, "通知テスト");
    assert.equal(footnoteHarness.options[0]?.body, "表示本文");
    assert.equal(footnoteHarness.options[0]?.body.includes(secret), false);

    const mixedHarness = createHarness({
      /** 可視の本文と非表示の定義が混在する応答に対してプレビューを有効にする。 */
      isResponsePreviewEnabled: () => true,
    });
    const mixedSession = createSession({
      messages: [
        {
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
        },
      ],
    });

    assert.equal(
      mixedHarness.service.notifyTurnCompleted(
        mixedSession,
        mixedSession.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(mixedHarness.options[0]?.title, "通知テスト");
    assert.equal(mixedHarness.options[0]?.body, "表示本文");
    assert.equal(mixedHarness.options[0]?.body.includes(secret), false);
  });

  /** 表示される一般のコードブロックを、表示外のメタデータと区別して残す。 */
  it("返答 preview は通常の code block だけを表示対象として保持する", () => {
    const harness = createHarness({
      /** フェンス内の可視テキストを確認できるようにプレビューを有効にする。 */
      isResponsePreviewEnabled: () => true,
    });
    const session = createSession({
      messages: [
        {
          role: "assistant",
          text: [
            "before $x$ after",
            "",
            "```ts",
            "const value = 1;",
            "```",
          ].join("\n"),
        },
      ],
    });

    assert.equal(
      harness.service.notifyTurnCompleted(
        session,
        session.messages[0]?.text ?? "",
      ),
      true,
    );
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
  /** UTF-16 コード単位の上限値ではプレビューを許し、一単位でも超えれば固定文へ戻す。 */
  it("返答 preview は65536 code unitsを超える本文を解析せず完了文へ戻す", () => {
    const withinLimitHarness = createHarness({
      /** 上限以下の応答は通常どおりプレビューできる設定にする。 */
      isResponsePreviewEnabled: () => true,
    });
    const prefix = "表示できる。";
    const withinLimitSession = createSession({
      messages: [
        {
          role: "assistant",
          text: `${prefix}${"[".repeat(65_536 - prefix.length)}`,
        },
      ],
    });

    assert.equal(
      withinLimitHarness.service.notifyTurnCompleted(
        withinLimitSession,
        withinLimitSession.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(withinLimitHarness.options[0]?.title, "通知テスト");
    assert.equal(withinLimitHarness.options[0]?.body, `${prefix}…`);

    const overLimitHarness = createHarness({
      /** 上限超過による固定文への切替を、プレビュー無効時の結果と区別する。 */
      isResponsePreviewEnabled: () => true,
    });
    const overLimitSession = createSession({
      messages: [
        {
          role: "assistant",
          text: "[".repeat(65_537),
        },
      ],
    });

    assert.equal(
      overLimitHarness.service.notifyTurnCompleted(
        overLimitSession,
        overLimitSession.messages[0]?.text ?? "",
      ),
      true,
    );
    assert.equal(overLimitHarness.options[0]?.title, "WithMate");
    assert.equal(
      overLimitHarness.options[0]?.body,
      "通知テスト: turn completed.",
    );
  });

  /** プラットフォーム、OS 対応、設定、フォーカスのいずれかが条件外なら完了通知を出さない。 */
  it("Windows 以外、非対応、設定無効、対象 Session Window focus 中は通知しない", () => {
    const cases: Array<Partial<SessionTurnNotificationServiceDeps<FakeIcon>>> =
      [
        { platform: "darwin" },
        {
          /** 対応 OS でも通知 API を利用できないケース。 */
          isNotificationSupported: () => false,
        },
        {
          /** 完了通知の設定がオフのケース。 */
          isNotificationEnabled: () => false,
        },
        {
          /** プレビューを許可しても基本の通知設定を上書きしない。 */
          isNotificationEnabled: () => false,
          /** 基本の通知設定と独立にプレビューを有効にする。 */
          isResponsePreviewEnabled: () => true,
        },
        {
          /** 対象ウィンドウで作業中の場合は通知を抑える。 */
          isSessionWindowFocused: () => true,
        },
      ];

    for (const overrides of cases) {
      const harness = createHarness(overrides);
      assert.equal(harness.service.notifyTurnCompleted(harness.session), false);
      assert.equal(harness.notifications.length, 0);
    }
  });

  /** 同じセッションの次の完了で、以前の表示を閉じて現在の通知へ入れ替える。 */
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

  /** OS が一度表示を閉じても、同じセッションの次の通知に同じ置換用識別子を使う。 */
  it("system timeout 後も同じ Session は同じ Windows Tag と Group で置き換える", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    harness.notifications[0]?.timeout();
    harness.service.notifyTurnCompleted(harness.session);

    assert.equal(harness.notifications[0]?.closed, true);
    assert.equal(harness.options[0]?.id, harness.options[1]?.id);
    assert.equal(harness.options[0]?.groupId, harness.options[1]?.groupId);
  });

  /** 表示期限を過ぎても通知履歴が残るため、削除時の撤去対象から外さない。 */
  it("system timeout 後に Session を削除すると Action Center の通知を閉じる", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    harness.notifications[0]?.timeout();
    harness.service.dismissSessionNotification(harness.session.id);

    assert.equal(harness.notifications[0]?.closed, true);
  });

  /** セッション削除時に通知の撤去が失敗しても、警告だけを記録して削除の処理を妨げない。 */
  it("Session 削除時の通知撤去失敗は記録し、削除処理の呼び出し元へ投げない", () => {
    const harness = createHarness();

    harness.service.notifyTurnCompleted(harness.session);
    const notification = harness.notifications[0];
    assert.ok(notification);
    notification.closeError = new Error("close failed");

    assert.doesNotThrow(() =>
      harness.service.dismissSessionNotification(harness.session.id),
    );
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
  /** アイコンを取得できなくても通知を作り、OS の表示失敗とは別に扱う。 */
  it("キャラアイコンを読み込めなくても通知本体を表示し、show failure は呼び出し元へ投げない", () => {
    const iconFailureHarness = createHarness({
      /** 無効なアイコンを読み込んだ場合の例外を再現する。 */
      loadCharacterIcon() {
        throw new Error("invalid icon");
      },
    });

    assert.equal(
      iconFailureHarness.service.notifyTurnCompleted(
        iconFailureHarness.session,
      ),
      true,
    );
    assert.deepEqual(iconFailureHarness.options[0], {
      id: iconFailureHarness.options[0]?.id,
      groupId: "WithMateSessions",
      title: "WithMate",
      body: "通知テスト: turn completed.",
    });
    assert.equal(iconFailureHarness.warnings[0]?.event, "icon-load-failed");

    const showFailureHarness = createHarness({
      /** ネイティブ通知の作成には成功しても、表示に失敗するハンドルを返す。 */
      createNotification() {
        return {
          /** OS による表示時の失敗を例外で伝える。 */
          show() {
            throw new Error("show failed");
          },
          /** このスタブの片付けでは別の失敗を発生させない。 */
          close() {},
          /** 表示失敗のケースではクリックを発生させない。 */
          onClick() {},
          /** 表示失敗のケースでは閉じる通知も送らない。 */
          onClose() {},
          /** 同期の表示例外と区別するため、非同期の配送失敗は発火させない。 */
          onFailed() {},
        };
      },
    });

    assert.equal(
      showFailureHarness.service.notifyTurnCompleted(
        showFailureHarness.session,
      ),
      false,
    );
    assert.equal(showFailureHarness.warnings[0]?.event, "show-failed");
  });

  /** クリック時に存在する対象は直接開き、削除済みの場合だけ Home を使う。 */
  it("通知 click で対象 Session を開き、削除済みなら Home を開く", async () => {
    const existingHarness = createHarness();
    existingHarness.service.notifyTurnCompleted(existingHarness.session);
    existingHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(existingHarness.openedSessions, [
      existingHarness.session.id,
    ]);
    assert.equal(existingHarness.homeOpenCount, 0);

    const deletedHarness = createHarness({
      /** クリックが届く前に対象セッションが削除された状態を返す。 */
      getSession: () => null,
    });
    deletedHarness.service.notifyTurnCompleted(deletedHarness.session);
    deletedHarness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(deletedHarness.openedSessions, []);
    assert.equal(deletedHarness.homeOpenCount, 1);

    const readFailureHarness = createHarness({
      /** 対象の有無を確認できない失敗を、削除済みとは区別する。 */
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
      /** 対象が見つかった後の画面遷移だけを失敗させる。 */
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
  /** Auxiliary 通知は親のフォーカス状態で表示を制御し、クリックでは指定の子だけを開く。 */
  it("Auxiliary通知は親Windowを基準に指定されたAuxiliaryを開く", async () => {
    const focusedSessionIds: string[] = [];
    const auxiliary = createSession({ id: "runtime-auxiliary-1" });
    const firstTarget = {
      kind: "auxiliary" as const,
      parentSessionId: "parent-session-1",
      auxiliarySessionId: "stored-auxiliary-1",
    };
    const focusedHarness = createHarness({
      /** 通知を見送る対象が子ではなく指定された親であることを確認する。 */
      isSessionWindowFocused: (sessionId) => {
        focusedSessionIds.push(sessionId);
        return sessionId === firstTarget.parentSessionId;
      },
    });

    assert.equal(
      focusedHarness.terminalService.notifyTurnTerminal(
        {
          outcome: "completed",
          session: auxiliary,
          lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
        },
        firstTarget,
      ),
      false,
    );
    assert.deepEqual(focusedSessionIds, [firstTarget.parentSessionId]);
    assert.equal(focusedHarness.notifications.length, 0);

    const harness = createHarness({
      /** 通知を表示する経路でも、フォーカス判定に渡された親の ID を記録する。 */
      isSessionWindowFocused: (sessionId) => {
        focusedSessionIds.push(sessionId);
        return false;
      },
    });
    assert.equal(
      harness.terminalService.notifyTurnTerminal(
        {
          outcome: "completed",
          session: auxiliary,
          lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
        },
        firstTarget,
      ),
      true,
    );
    harness.notifications[0]?.click();
    await flushAsyncListeners();
    assert.deepEqual(harness.openedAuxiliarySessions, [
      {
        parentSessionId: firstTarget.parentSessionId,
        auxiliarySessionId: firstTarget.auxiliarySessionId,
      },
    ]);

    const secondTarget = {
      ...firstTarget,
      auxiliarySessionId: "stored-auxiliary-2",
    };
    assert.equal(
      harness.terminalService.notifyTurnTerminal(
        {
          outcome: "completed",
          session: auxiliary,
          lastNonEmptyAssistantMessageText: "Auxiliaryの完了",
        },
        secondTarget,
      ),
      true,
    );
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

  /** 同一通知から複数回クリックが届いても、最初の一回だけ遷移を要求する。 */
  it("同じ通知の click が多重発火しても対象 Session は一度だけ開く", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.click();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, [harness.session.id]);
    assert.equal(harness.homeOpenCount, 0);
  });

  /** 旧通知に遅延したクリックは破棄し、現在表示中の通知のクリックだけを扱う。 */
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

  /** OS の表示期限を過ぎても現在の通知であれば、履歴のクリックを処理する。 */
  it("system timeout 後も現在の通知なら Action Center から対象 Session を開く", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.timeout();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, [harness.session.id]);
    assert.equal(harness.homeOpenCount, 0);
  });

  /** 理由のない終了通知を受けた場合は、遅れてクリックされても開かない。 */
  it("reason 不明の close 後に遅延 click が届いても対象を開かない", async () => {
    const harness = createHarness();
    harness.service.notifyTurnCompleted(harness.session);

    harness.notifications[0]?.closeWithoutReason();
    harness.notifications[0]?.click();
    await flushAsyncListeners();

    assert.deepEqual(harness.openedSessions, []);
    assert.equal(harness.homeOpenCount, 0);
  });

  /** OS が配送失敗を返した通知を追跡対象から外し、次の通知で再撤去しない。 */
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
