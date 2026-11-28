import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  SessionMessageColumn,
  type SessionMessageColumnProps,
} from "../../src/chat/conversation/session-message-column.js";
import type { Message } from "../../src-shared/session/session-state.js";
import type { SessionSteerOrigin } from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "直接Steerは保存された入力自身の親発言者・avatar・色・From導線を再表示後も保ち、送信元変更を色へ反映し、開始Turnの別actorを通常ユーザーや旧入力へ帰属させない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/942; https://github.com/natumekazuki/WithMate/issues/958; docs/design/desktop-ui.md#turn-input-details" }
// fault = "queueのないSteerをユーザー表示する、開始actorで置換する、個別messageと異なる色を使う、または全追加入力を親発言へ変える"
// observable = "実SessionMessageColumnのrow種別・保存名・avatar・色・@宛先・FromのopenSession対象、remount後の一致、送信元更新・削除後の色と配送不明の理由"
// observation_boundary = "consumer"
// scope = "保存message→実chat column→turn-input readerとheader、IPC execution読取をfixture化"
// lifecycle = "permanent"
// impact = "利用者が親の追加指示を自分の発言と誤認し送信元へ辿れなくなる"
// distinction = "queue rowや保存testではqueueのない追加入力と開始Turnのorigin競合を検出できない。少数messageのDOMで継続確認する"
// @end-test-value
/** 再マウント後も直接Steer固有の発言者を表示し、開始Turnの発言者や通常の追加入力と混同しないことを確認する。 */
test("direct Steer attribution survives remount and stays separate from the Turn starter", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      /** 可視領域を持たないJSDOMで一覧の高さを固定する。 */
      get: () => 720,
    },
    clientWidth: {
      /** JSDOMでも一覧が横幅を持つようにする。 */
      get: () => 960,
    },
    offsetHeight: {
      /** 一覧とメッセージ行に異なる高さを与え、行の描画に必要な寸法を再現する。 */
      get() {
        return this.classList.contains("session-message-list") ? 720 : 160;
      },
    },
    offsetWidth: {
      /** 一覧・行の横幅をレイアウト計算で参照できるようにする。 */
      get: () => 960,
    },
  });
  dom.window.HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
  };
  dom.window.ResizeObserver = class {
    /** 実際のサイズ変化通知なしで監視登録を受け付ける。 */
    observe() {}
    /** 個別の監視終了には後処理が不要なテスト用実装。 */
    unobserve() {}
    /** 固定寸法のため監視の一括解除時に残る通知はない。 */
    disconnect() {}
  };
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : key === "window"
            ? dom.window
            : (dom.window as any)[key],
    });
  const opened: string[][] = [];
  const invalidationListeners = new Set<
    (event: { scope: "all" } | { scope: "ids"; sessionIds: string[] }) => void
  >();
  let senderTheme: { main: string; sub: string } | null = {
    main: "#ff8c3c",
    sub: "#f6ebef",
  };
  let reads = 0;
  const origin: SessionSteerOrigin = {
    kind: "session",
    operation: "steer",
    actorKind: "main",
    actorSessionId: "parent",
    actorIncarnationId: "p-inc",
    actorTurnId: "7",
    targetSessionId: "child",
    targetIncarnationId: "c-inc",
    actorSnapshot: {
      sessionTitle: "Parent Work",
      character: {
        id: "parent-character",
        name: "Saved Parent",
        iconPath: "C:/fixture/parent.png",
      },
    },
    targetSnapshot: {
      sessionTitle: "Child Work",
      character: { id: "child-character", name: "Saved Child", iconPath: "" },
    },
  };
  const starter = {
    ...origin,
    operation: "send",
    actorSessionId: "starter",
    actorSnapshot: {
      sessionTitle: "Starter Work",
      character: {
        id: "starter-character",
        name: "Turn Starter",
        iconPath: "",
      },
    },
  };
  Object.defineProperty(dom.window, "withmate", {
    value: {
      /** From操作で指定された送信元セッションを記録する。 */
      openSession: async (...ids: string[]) => {
        opened.push(ids);
      },
      /** 送信元更新の影響をテストから通知できるよう購読先を集め、解除時に除く。 */
      subscribeSessionInvalidation: (
        listener: (
          event: { scope: "all" } | { scope: "ids"; sessionIds: string[] },
        ) => void,
      ) => {
        invalidationListeners.add(listener);
        return () => invalidationListeners.delete(listener);
      },
      /** 開始Turnの発言者は固定し、直接Steerのメッセージにだけ現在の送信元配色を返す。 */
      readSessionExecution: async (
        _owner: string,
        _op: string,
        request: { messageSeq?: number },
      ) => {
        reads++;
        return {
          ok: true,
          origin: starter,
          senderTheme: request.messageSeq === 4 ? senderTheme : null,
          receiptId: null,
          turnId: "42",
          turnState: "running",
          userMessageSeq: 0,
          executionSettings: null,
        };
      },
    },
  });
  const direct: Message = {
    role: "user",
    text: "Parent additional instruction",
    historyIndex: 4,
    turnInput: {
      turnId: "42",
      nativeTurnId: "native",
      state: "confirmed",
      attachments: [],
      origin,
    },
  };
  const messages: Message[] = [
    direct,
    {
      role: "user",
      text: "User additional instruction",
      historyIndex: 5,
      turnInput: { ...direct.turnInput!, origin: undefined },
    },
    {
      role: "user",
      text: "Old additional instruction",
      historyIndex: 6,
      turnInput: { ...direct.turnInput!, state: "unknown", origin: undefined },
    },
    {
      role: "user",
      text: "Queued instruction",
      historyIndex: 7,
      turnInput: {
        ...direct.turnInput!,
        origin: undefined,
        queueId: "receipt",
      },
    },
  ];
  /** メッセージの帰属と無関係な操作は副作用を起こさない。 */
  const noop = () => {};
  const props: SessionMessageColumnProps = {
    sessionId: "child",
    inputReadContext: {
      ownerSessionId: "child",
      target: { kind: "main", sessionId: "child", incarnationId: "c-inc" },
    },
    character: {
      id: "current-child",
      name: "Current Child",
      iconPath: "",
      description: "",
      roleMarkdown: "",
      notesMarkdown: "",
      updatedAt: "",
      themeColors: { main: "#445566", sub: "#667788" },
    },
    messages,
    expandedArtifacts: {},
    messageListRef: createRef(),
    isRunning: false,
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    hasLiveRunAssistantText: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    onMessageListScroll: noop,
    onToggleArtifact: noop,
    onOpenDiff: noop,
    onResolveLiveApproval: noop,
    onResolveLiveElicitation: noop,
  };
  let root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (let reload = 0; reload < 2; reload++) {
      await act(async () =>
        root.render(
          <SessionMessageColumn
            {...props}
            messages={JSON.parse(JSON.stringify(messages))}
          />,
        ),
      );
      const rows = [
        ...dom.window.document.querySelectorAll("article.message-row"),
      ];
      assert.equal(rows.length, 4);
      const parent = rows[0];
      assert.ok(parent.classList.contains("session-origin"));
      assert.equal(
        parent.querySelector(".message-character-name")?.textContent,
        "Saved Parent",
      );
      assert.equal(
        (
          parent.querySelector(".message-card") as HTMLElement
        ).style.getPropertyValue("--sender-main"),
        "#ff8c3c",
      );
      assert.match(
        parent.querySelector("img")?.getAttribute("src") ?? "",
        /parent\.png/,
      );
      assert.equal(
        parent.querySelector(".session-message-mention")?.textContent,
        "@Saved Child",
      );
      assert.equal(
        parent.querySelector(".related-session-direction")?.textContent,
        "From",
      );
      await act(async () =>
        (
          parent.querySelector(
            '[aria-label="Open Sender: Parent Work"]',
          ) as HTMLButtonElement
        ).click(),
      );
      assert.deepEqual(opened.at(-1), ["parent", undefined]);
      for (const row of rows.slice(1, 3)) {
        assert.ok(row.classList.contains("user"));
        assert.equal(row.querySelector(".session-message-address"), null);
      }
      assert.match(
        rows[2].querySelector('[role="alert"]')?.textContent ?? "",
        /could not be confirmed/,
      );
      assert.equal(
        rows[3].querySelector(".message-character-name")?.textContent,
        "Turn Starter",
      );
      if (reload === 0) {
        await act(async () => root.unmount());
        root = createRoot(dom.window.document.getElementById("root")!);
      }
    }
    const parentCard = dom.window.document.querySelector(
      "article.session-origin .message-card",
    ) as HTMLElement;
    const readsBeforeUnrelated = reads;
    await act(async () => {
      for (const listener of invalidationListeners)
        listener({ scope: "ids", sessionIds: ["unrelated"] });
    });
    assert.equal(reads, readsBeforeUnrelated);
    senderTheme = { main: "#123456", sub: "#abcdef" };
    await act(async () => {
      for (const listener of invalidationListeners)
        listener({ scope: "ids", sessionIds: ["parent"] });
    });
    assert.equal(parentCard.style.getPropertyValue("--sender-main"), "#123456");
    senderTheme = null;
    await act(async () => {
      for (const listener of invalidationListeners) listener({ scope: "all" });
    });
    assert.equal(parentCard.style.getPropertyValue("--sender-main"), "");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
