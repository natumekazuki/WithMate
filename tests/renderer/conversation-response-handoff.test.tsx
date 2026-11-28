import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConversationMessageColumn,
  type ConversationMessageColumnApi,
} from "../../src/chat/conversation-message-column.js";
import type { SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import { SessionTurnSubmissions } from "../../src/chat/runtime/session-turn-submissions.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Message } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";
import { sentInstructionReaderFixture } from "./sent-instruction-reader-fixture.js";
import type { SentDelivery } from "../../src/chat/conversation/use-sent-deliveries.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの終了をまたいで同一Turnの本文、送信カード、開いたDetailsを保ち、追加入力で保存seqがずれても同じ行を一度だけ確定する。確定した目録の変更は反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 実run終了後の確定応答の取得待ち; docs/design/desktop-ui.md: Turn Input Details; docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "live終了・後続開始でDetailsや送信カードが消える、別Turnへ移る、現在の目録範囲に含まれない既読のカードで本文エラーを出す、保存応答と二重表示する、または開閉・focusを失う"
// observable = "同じ応答行のDOM・本文・送信カード順と件数、DetailsのDOM・focus・aria-expanded・内容、保存行のReply対象seq、目録から削除されたカードの不在"
// observation_boundary = "component-behavior"
// scope = "Main/Auxの通常Send受付以降、成功/失敗・後続live先着・追加保存入力と応答・送信目録の遅延および確定更新。親snapshotとIPCの通知/readはfixtureで制御する"
// lifecycle = "permanent"
// impact = "読んでいた応答と実行情報が途切れるか、偽の重複応答を読むことになり、その場の操作と返信対象を見失う"
// distinction = "別mountでのlive・保存描画では、同じ応答行を読みながら送信目録と保存seqが前後して到着する境界を通らない"
// @end-test-value
/** ライブ応答から保存済み応答に引き継ぐ間、開いた詳細・フォーカス・送信カードを保ち、返信が確定した連番を使うことを確認する。 */
test("opened response Details and focus survive turn handoff and late saved sequences", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetHeight: {
      /** 高さのないJSDOMで応答一覧のレイアウトに必要な要素寸法を返す。 */
      get: () => 620,
    },
    offsetWidth: {
      /** 横幅の測定を一定にして引き継ぎ前後で比較できるようにする。 */
      get: () => 800,
    },
    clientHeight: {
      /** 表示領域の高さを与え、一覧の可視行を描画できるようにする。 */
      get: () => 620,
    },
    clientWidth: {
      /** 一覧が一定幅のビューポートにある状態を作る。 */
      get: () => 800,
    },
  });
  const intersection = installIntersectionObserver();
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const scenario of [
      {
        kind: "session",
        terminal: "completed",
        lateInput: true,
        nextStarts: false,
        promptLag: false,
      },
      {
        kind: "auxiliary",
        terminal: "failed",
        lateInput: true,
        nextStarts: false,
        promptLag: false,
      },
      {
        kind: "auxiliary",
        terminal: "completed",
        lateInput: false,
        nextStarts: true,
        promptLag: true,
      },
    ] as const) {
      const { kind, terminal, lateInput, nextStarts, promptLag } = scenario;
      const incarnationId = "inc";
      const target: SessionTarget =
        kind === "session"
          ? { kind: "main", sessionId: kind, incarnationId }
          : {
              kind: "auxiliary",
              sessionId: kind,
              incarnationId,
              mainSessionId: "main",
              mainIncarnationId: "main-inc",
            };
      const inputReadContext = { ownerSessionId: "main", target };
      const executionOptions = {
        model: "Selected model A",
        reasoningEffort: "medium",
        approvalMode: "on-request" as const,
        codexSandboxMode: "workspace-write" as const,
        codexSpeed: "standard" as const,
        codexReviewer: "user" as const,
        customAgentName: "",
      };
      const receipt: SessionTurnQueueReceipt = {
        sessionId: kind,
        incarnationId,
        id: "receipt-a",
        requestId: "request-a",
        sequence: 1,
        queuePosition: 1,
        state: "queued",
        userMessageSeq: null,
        turnId: null,
        reason: null,
        releasedAt: null,
        createdAt: "created",
        updatedAt: "accepted",
        captured: {
          request: {
            clientRequestId: "request-a",
            userMessage: "prompt A",
            executionOptions,
          },
          provider: "codex",
          workspacePath: "fixture",
          attachments: [],
        },
      };
      const userSeq = promptLag ? 1 : 0;
      const savedSeq = userSeq + (lateInput ? 2 : 1);
      const started = {
        ...receipt,
        state: "running" as const,
        userMessageSeq: userSeq,
        turnId: "41",
      };
      const next = {
        ...started,
        id: "receipt-b",
        requestId: "request-b",
        sequence: 2,
        queuePosition: 2,
        userMessageSeq: savedSeq + 1,
        turnId: "42",
        captured: {
          ...receipt.captured,
          request: {
            ...receipt.captured.request,
            userMessage: "prompt B",
            executionOptions: {
              ...executionOptions,
              model: "Selected model B",
            },
          },
        },
      };
      const partial = "Before card\n\nPartial answer A";
      const final =
        terminal === "failed" ? partial : "Before card\n\nSaved answer A";
      /** 受理済み入力とライブ本文を同じTurnに対応付ける。 */
      const run = (
        r: typeof started,
        assistantText: string,
      ): LiveSessionRunState => ({
        sessionId: kind,
        sessionTurnId: r.turnId,
        turnId: "native-" + r.turnId,
        threadId: "provider",
        runState: "running",
        queueReceipt: {
          id: r.id,
          incarnationId,
          userMessageSeq: r.userMessageSeq,
        },
        assistantText,
        backgroundTasks: [],
        steps: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      });
      const prior: Message[] = promptLag
        ? [{ role: "user", text: "Unrelated saved prompt", historyIndex: 0 }]
        : [];
      const prompt: Message = {
        role: "user",
        text: "prompt A",
        historyIndex: userSeq,
      };
      let history: Message[] = prior;
      let live: LiveSessionRunState | null = null;
      let observed = receipt;
      let saved = false;
      let holdCatalogue = false;
      let includeCard = true;
      const pendingCatalogues: (() => void)[] = [];
      let completedUnrelatedRead = false;
      const recipient = {
        kind: "main",
        sessionId: "recipient",
        incarnationId: "recipient-inc",
      } as const;
      const delivery: SentDelivery = {
        receiptId: "out-a",
        sequence: 1,
        sourceTurnId: started.turnId,
        sourceMessageSeq: null,
        target: recipient,
        state: "queued",
        sourceDisplayPosition: "Before card".length,
        text: "Outgoing from A",
        origin: {
          kind: "session",
          operation: "send",
          actorKind: target.kind,
          actorSessionId: kind,
          actorIncarnationId: incarnationId,
          actorTurnId: started.turnId,
          targetSessionId: recipient.sessionId,
          targetIncarnationId: recipient.incarnationId,
          ...(kind === "auxiliary"
            ? { actorMainSessionId: "main", actorMainIncarnationId: "main-inc" }
            : {}),
        },
      };
      /** 終端を一覧から外し、次Turnが始まったときだけその入力を含める。 */
      const active = () =>
        [
          observed,
          ...(live?.sessionTurnId === next.turnId ? [next] : []),
        ].filter((r) => r.state === "queued" || r.state === "running");
      const queues = new Set<(id: string) => void>();
      const turns = new Set<(id: string) => void>();
      const api: ConversationMessageColumnApi = {
        /** ライブ表示に必要な現時点の待機・実行中の入力を返す。 */
        listSessionTurnQueue: async () => active(),
        /** 問い合わせ時の入力IDから先行Turnと次Turnを区別する。 */
        getSessionTurnQueueReceipt: async (_id, requestId) =>
          requestId === receipt.requestId ? observed : next,
        /** キュー変更通知を登録し、購読終了時に解除する。 */
        onSessionTurnQueueChanged(listener) {
          queues.add(listener);
          return () => {
            queues.delete(listener);
          };
        },
      };
      Object.defineProperty(dom.window, "withmate", {
        configurable: true,
        value: {
          ...api,
          /** 保存履歴の更新を手動で通知できるよう購読先を登録する。 */
          onSessionTurnUpdated(listener: (id: string) => void) {
            turns.add(listener);
            return () => {
              turns.delete(listener);
            };
          },
          /** 参照範囲に応じた送信カードと捕捉済み設定を返し、遅延する取得を再現する。 */
          async readSessionExecution(
            _id: string,
            operation: string,
            input: {
              turnId?: string;
              receiptId?: string;
              messageSeqs?: number[];
              liveTurnIds?: string[];
            },
          ) {
            if (operation === "read_turn_input_display") return { ok: true };
            const seqs = input.messageSeqs ?? [];
            const knownSaved = saved && seqs.includes(savedSeq);
            const sourceMessageSeq = !knownSaved
              ? seqs.includes(userSeq)
                ? userSeq
                : null
              : savedSeq;
            const cards =
              includeCard &&
              (sourceMessageSeq !== null ||
                input.liveTurnIds?.includes(started.turnId))
                ? [{ ...delivery, sourceMessageSeq }]
                : [];
            const sentResult = sentInstructionReaderFixture(
              cards,
              operation,
              input,
            );
            if (sentResult) {
              if (holdCatalogue && operation === "list_sent_instruction_cards")
                await new Promise<void>((resolve) =>
                  pendingCatalogues.push(resolve),
                );
              if (
                operation === "list_sent_instruction_cards" &&
                seqs.includes(0) &&
                sourceMessageSeq === null &&
                !input.liveTurnIds?.includes(started.turnId)
              ) {
                completedUnrelatedRead = true;
              }
              return sentResult;
            }
            if (operation !== "get_execution")
              return { ok: true, items: [], nextCursor: null };
            // 新しいメッセージ連番による読み取りは、結果が届くまではすでに取得済みの実行情報を置き換えられない。
            if (!input.turnId && !input.receiptId) return new Promise(() => {});
            const r =
              input.turnId === next.turnId || input.receiptId === next.id
                ? next
                : input.turnId === started.turnId ||
                    input.receiptId === receipt.id
                  ? observed
                  : null;
            if (!r) return { ok: false, message: "No matching execution" };
            return {
              ok: true,
              receiptId: r.id,
              receiptState: r.state,
              turnState: r.state,
              userMessageSeq: r.userMessageSeq,
              executionSettings: {
                ...r.captured.request.executionOptions,
                provider: "codex",
                source: "input",
              },
            };
          },
        },
      });
      const submissions = new SessionTurnSubmissions();
      const replies: number[] = [];
      /** 実行承認やスクロール操作に副作用を持たせない。 */
      const noop = () => {};
      /** 実際の応答列を描画し、開閉状態と返信の確定先を観測できるようにする。 */
      function View() {
        const [expandedArtifacts, setExpandedArtifacts] = useState<
          Record<string, boolean>
        >({});
        const props: SessionMessageColumnProps = {
          sessionId: kind,
          character: {
            name: "Fixture",
            iconPath: "",
          } as SessionMessageColumnProps["character"],
          messages: [],
          expandedArtifacts,
          messageListRef: { current: null },
          isRunning: false,
          inputReadContext,
          turnSubmissions: submissions,
          liveApprovalRequest: null,
          approvalActionRequestId: null,
          liveElicitationRequest: null,
          elicitationActionRequestId: null,
          liveRunAssistantText: "",
          hasLiveRunAssistantText: false,
          liveRunErrorMessage: "",
          isMessageListFollowing: true,
          onMessageListScroll: noop,
          onOpenDiff: noop,
          onResolveLiveApproval: noop,
          onResolveLiveElicitation: noop,
          /** 同じ応答行に結び付いた詳細の開閉状態を更新する。 */
          onToggleArtifact: (key) =>
            setExpandedArtifacts((value) => ({ ...value, [key]: !value[key] })),
          /** 保存済みメッセージへの返信時に選ばれた連番を記録する。 */
          onSelectReply: (_key, reference) => {
            if ("seq" in reference) replies.push(reference.seq);
          },
        };
        return (
          <ConversationMessageColumn
            session={{
              id: kind,
              incarnationId,
              provider: "codex",
              messages: history,
            }}
            baseProps={props}
            enabled
            messageSourceKind={kind}
            api={api}
            liveRun={live}
          />
        );
      }
      const document = dom.window.document;
      /** 現在描画されているアシスタント応答行をDOM順で取得する。 */
      const rows = () => [
        ...document.querySelectorAll<HTMLElement>(".message-row.assistant"),
      ];
      /** 送信カードを除いて応答本文を取り出し、前後の順序と重複を確認できるようにする。 */
      const bodies = () =>
        rows().map((row) =>
          [...row.querySelectorAll('[data-message-body="true"] p')]
            .filter(
              (paragraph) => !paragraph.closest(".session-outbound-inline"),
            )
            .map((paragraph) => paragraph.textContent)
            .join("\n\n"),
        );
      /** シナリオが同じ間は同じビューを再描画する。 */
      const render = () => root.render(<View key={kind + terminal} />);
      /** キューとTurnの変更を購読先に通知し、更新後のDOMを確定させる。 */
      const update = () =>
        act(async () => {
          [...queues, ...turns].forEach((listener) => listener(kind));
          render();
        });
      await act(async () => {
        render();
        submissions.start({
          sessionId: kind,
          incarnationId,
          requestId: receipt.requestId,
          userMessage: "prompt A",
          historyMessageCount: prior.length,
          queuedBehindRun: false,
          error: "",
        });
        submissions.accept(receipt);
      });
      const initial = rows()[0];
      assert.ok(initial);
      observed = started;
      if (!promptLag) history = [prompt];
      live = run(started, partial);
      await update();
      await act(async () => t.mock.timers.tick(100));
      assert.ok(
        rows()[0] === initial,
        "acceptance and streaming use the same answer row",
      );
      assert.deepEqual(bodies(), [partial]);
      const button = initial.querySelector<HTMLButtonElement>(
        'button[aria-label="Show details"]',
      )!;
      assert.ok(button);
      button.focus();
      await act(async () => button.click());
      /** 引き継ぎ後も同じ詳細ボタンにフォーカスがあり、先行Turnの設定だけを表示することを確かめる。 */
      const verifyDetails = () => {
        assert.ok(
          rows()[0] === initial,
          "the old answer row is not remounted or replaced",
        );
        assert.ok(
          document.activeElement === button,
          "Details retains focus through the handoff",
        );
        assert.equal(button.getAttribute("aria-expanded"), "true");
        assert.match(
          initial.querySelector(".artifact-block")?.textContent ?? "",
          /Selected model A/,
        );
        assert.doesNotMatch(
          initial.querySelector(".artifact-block")?.textContent ?? "",
          /Selected model B/,
        );
      };
      /** 送信カードが重複せず先行Turnの本文中に残り、正しい参照範囲で読めることを確かめる。 */
      const verifyCard = () => {
        const cards = document.querySelectorAll(
          "article.session-outbound, .session-outbound-inline",
        );
        assert.equal(
          cards.length,
          1,
          "the outgoing card stays visible without duplication",
        );
        assert.ok(
          initial.contains(cards[0]),
          "the card is owned by A, never a prompt or the next Turn",
        );
        assert.match(
          initial.textContent ?? "",
          /Before card[\s\S]*Outgoing from A[\s\S]*(Partial|Saved) answer A/,
        );
        assert.equal(
          cards[0].querySelector('[role="alert"]'),
          null,
          "only the card's verified scope can read its body",
        );
      };
      verifyDetails();
      verifyCard();
      holdCatalogue = !promptLag;

      if (nextStarts) {
        observed = { ...started, state: terminal };
        await update();
        assert.deepEqual(bodies(), [partial]);
        verifyDetails();
        live = run(next, "Live answer B");
      } else {
        live = null;
      }
      await update();
      await act(async () => t.mock.timers.tick(100));
      assert.deepEqual(
        bodies(),
        nextStarts ? [partial, "Live answer B"] : [partial],
      );
      verifyDetails();
      verifyCard();
      if (promptLag) {
        assert.ok(
          completedUnrelatedRead,
          "a complete catalogue for the unrelated scope arrived during A's bridge",
        );
        holdCatalogue = true;
      }
      if (!nextStarts) {
        observed = {
          ...started,
          state: terminal,
          reason: terminal === "failed" ? "fixture failure" : null,
          updatedAt: "terminal",
        };
        await update();
        assert.deepEqual(bodies(), [partial]);
        verifyDetails();
      }
      saved = true;
      history = [
        ...prior,
        prompt,
        ...(lateInput
          ? [
              {
                role: "user" as const,
                text: "late input A",
                historyIndex: userSeq + 1,
                turnInput: {
                  turnId: started.turnId,
                  nativeTurnId: "native-41",
                  state: "confirmed" as const,
                  attachments: [],
                },
              },
            ]
          : []),
        {
          role: "assistant",
          text: final,
          historyIndex: savedSeq,
          ...(terminal === "failed" ? { runFailure: "fixture failure" } : {}),
        },
      ];
      await update();
      assert.deepEqual(
        bodies(),
        nextStarts ? [final, "Live answer B"] : [final],
      );
      verifyDetails();
      verifyCard();
      assert.ok(pendingCatalogues.length > 0);
      holdCatalogue = false;
      await act(async () =>
        pendingCatalogues.splice(0).forEach((resolve) => resolve()),
      );
      verifyCard();
      const reply = initial.querySelector<HTMLButtonElement>(
        'button[aria-label="Reply to message"]',
      );
      assert.ok(reply);
      await act(async () => reply.click());
      assert.deepEqual(replies, [savedSeq]);
      includeCard = false;
      await update();
      assert.ok(
        !document.querySelector(
          "article.session-outbound, .session-outbound-inline",
        ),
        "a complete current-scope read can remove the card",
      );
    }
  } finally {
    await act(async () => root.unmount());
    intersection.restore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
