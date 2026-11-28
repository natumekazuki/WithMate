import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageListProjection,
  hasPersistedLiveAssistantMessage,
  loadOwnedAuxiliaryMessageArtifact,
  loadProjectedMessageArtifact,
  projectLiveAssistantOnSessionHistory,
  resolveLiveAssistantMessageIndex,
  resolvePendingAuxiliaryMessageGroupId,
  shouldProjectLiveAssistantBridge,
} from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  Message,
  MessageArtifact,
} from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "invariant"
// claim = "live本文だけが変わる間、投影済み履歴のmessage要素参照を保持し、保存確定時は同じ応答keyへ引き継ぐ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: UI Implementation Boundary" }
// fault = "live末尾の合成で履歴message要素の参照を変える、または保存確定時に応答keyが変わる"
// observable = "投影済み履歴message要素の同一参照、live末尾本文、保存済みassistantのkey"
// observation_boundary = "component-behavior"
// scope = "conversation-history-projection"
// lifecycle = "permanent"
// impact = "streaming中の履歴message参照が不安定になり、保存時に折りたたみ・bookmark等の応答identityを失う"
// distinction = "既存の全文投影testはlive更新間の履歴参照と保存確定への引継ぎを検証しない"
// @end-test-value
/** 配信本文を更新しても既存履歴の参照を維持し、保存の確定後は最終本文を同じ描画キーの一行に引き継ぐことを確認する。 */
test("live assistant projection は確定履歴を保持して保存済み応答へkeyを引き継ぐ", () => {
  const messages: Message[] = [{ role: "user", text: "request" }];
  const history = buildMessageListProjection(messages, [], "session-1");
  const bridge = {
    sessionId: "session-1",
    threadId: "thread-1",
    messageIndex: 1,
    text: "first",
  };
  const first = projectLiveAssistantOnSessionHistory(
    history,
    messages,
    "session-1",
    bridge,
  );
  const second = projectLiveAssistantOnSessionHistory(
    history,
    messages,
    "session-1",
    { ...bridge, text: "first second" },
  );
  assert.equal(first.messages[0], history.messages[0]);
  assert.equal(second.messages[0], history.messages[0]);
  assert.equal(second.messages[1]?.text, "first second");
  assert.equal(first.keys[1], second.keys[1]);

  const savedMessages: Message[] = [
    ...messages,
    { role: "assistant", text: "final" },
  ];
  const savedHistory = buildMessageListProjection(
    savedMessages,
    [],
    "session-1",
  );
  const saved = projectLiveAssistantOnSessionHistory(
    savedHistory,
    savedMessages,
    "session-1",
    bridge,
  );
  assert.equal(saved.messages, savedHistory.messages);
  assert.equal(saved.keys[1], first.keys[1]);
  assert.equal(saved.messages.length, 2);
});

/** 指定された履歴と必要な配置・実行状態だけを変えられる、親会話付きの Auxiliary を作る。 */
function createAuxiliarySession(
  messages: Message[],
  overrides: Partial<AuxiliarySession> = {},
): AuxiliarySession {
  return {
    id: overrides.id ?? "aux-1",
    parentSessionId: "session-1",
    runState: overrides.runState ?? "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.2",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    threadId: "thread-1",
    composerDraft: "",
    messages,
    displayAfterMessageIndex: overrides.displayAfterMessageIndex ?? 0,
    createdAt: overrides.createdAt ?? "2026-05-24T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-24T00:00:01.000Z",
  };
}

/** 遅延詳細を持つ成果物を、概要と変更ファイルが識別できる内容で作る。 */
function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["updated files"],
    operationTimeline: [],
    changedFiles: [
      {
        kind: "edit",
        path: "src/app/SessionWindowApp.tsx",
        summary: "updated src/App.tsx",
        diffRows: [],
      },
    ],
    runChecks: [],
    detailAvailable: true,
  };
}

/** Auxiliary の履歴を一括の本文にせず、入力と応答それぞれに装飾・元履歴位置・成果物・キー・グループを割り当てることを確認する。 */
test("buildMessageListProjection は Auxiliary transcript を message 単位で保持する", () => {
  const artifact = createArtifact();
  const projection = buildMessageListProjection(
    [{ role: "assistant", text: "parent response" }],
    [
      createAuxiliarySession([
        { role: "user", text: "aux prompt" },
        { role: "assistant", text: "aux response", artifact },
      ]),
    ],
    "session-1",
  );

  assert.deepEqual(
    projection.messages.map((message) => ({
      role: message.role,
      text: message.text,
      accent: message.accent ?? false,
      artifactTitle: message.artifact?.title ?? "",
    })),
    [
      {
        role: "assistant",
        text: "parent response",
        accent: false,
        artifactTitle: "",
      },
      { role: "user", text: "aux prompt", accent: true, artifactTitle: "" },
      {
        role: "assistant",
        text: "aux response",
        accent: true,
        artifactTitle: "Run result",
      },
    ],
  );
  assert.deepEqual(projection.sources, [
    { kind: "session", messageIndex: 0 },
    {
      kind: "auxiliary",
      sessionId: "aux-1",
      messageIndex: 0,
      artifact: undefined,
    },
    { kind: "auxiliary", sessionId: "aux-1", messageIndex: 1, artifact },
  ]);
  assert.deepEqual(projection.keys, [
    "session-session-1-0",
    "auxiliary-aux-1-0",
    "auxiliary-aux-1-1",
  ]);
  assert.deepEqual(projection.groups, [
    null,
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-1", label: "Auxiliary" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "複数Auxiliaryのmessage投影は会話ごとのstable IDを描画keyとgroupへ保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#メッセージの投影とwindow内live受信" }
// fault = "別Auxiliaryのmessageを同じ描画keyやgroupへ結合する"
// observable = "2会話を投影したkeysとgroupsの会話ID・label"
// observation_boundary = "component-behavior"
// scope = "auxiliary-message-projection-group-identity"
// lifecycle = "permanent"
// @end-test-value
/** 同名の Auxiliary でも、会話 ID を描画キーとグループに残して別々に表示することを確認する。 */
test("buildMessageListProjection は Auxiliary session ごとの group を保持する", () => {
  const projection = buildMessageListProjection(
    [],
    [
      createAuxiliarySession([{ role: "user", text: "first aux prompt" }], {
        id: "aux-1",
        createdAt: "2026-05-24T00:00:00.000Z",
      }),
      createAuxiliarySession([{ role: "user", text: "second aux prompt" }], {
        id: "aux-2",
        createdAt: "2026-05-24T00:00:01.000Z",
      }),
    ],
    "session-1",
  );

  assert.deepEqual(projection.keys, ["auxiliary-aux-1-0", "auxiliary-aux-2-0"]);
  assert.deepEqual(projection.groups, [
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-2", label: "Auxiliary" },
  ]);
});

/** 未選択・待機・エラーでは保留グループを作らず、実行中の Auxiliary だけをその ID で識別することを確認する。 */
test("resolvePendingAuxiliaryMessageGroupId は実行中 Auxiliary だけ group id を返す", () => {
  assert.equal(resolvePendingAuxiliaryMessageGroupId(null), null);
  assert.equal(resolvePendingAuxiliaryMessageGroupId(undefined), null);
  assert.equal(
    resolvePendingAuxiliaryMessageGroupId(
      createAuxiliarySession([], { runState: "idle" }),
    ),
    null,
  );
  assert.equal(
    resolvePendingAuxiliaryMessageGroupId(
      createAuxiliarySession([], { runState: "error" }),
    ),
    null,
  );
  assert.equal(
    resolvePendingAuxiliaryMessageGroupId(
      createAuxiliarySession([], { id: "aux-running", runState: "running" }),
    ),
    "aux-running",
  );
});

/** Auxiliary の並びにかかわらず、それぞれの履歴を指定された親応答の直後に挿入することを確認する。 */
test("buildMessageListProjection は Auxiliary を parent message の保存位置へ差し込む", () => {
  const projection = buildMessageListProjection(
    [
      { role: "user", text: "main prompt 1" },
      { role: "assistant", text: "main response 1" },
      { role: "user", text: "main prompt 2" },
      { role: "assistant", text: "main response 2" },
    ],
    [
      createAuxiliarySession([{ role: "user", text: "aux prompt 2" }], {
        id: "aux-2",
        displayAfterMessageIndex: 3,
        createdAt: "2026-05-24T00:00:02.000Z",
      }),
      createAuxiliarySession(
        [
          { role: "user", text: "aux prompt 1" },
          { role: "assistant", text: "aux response 1" },
        ],
        {
          id: "aux-1",
          displayAfterMessageIndex: 1,
          createdAt: "2026-05-24T00:00:01.000Z",
        },
      ),
    ],
    "session-1",
  );

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    [
      "main prompt 1",
      "main response 1",
      "aux prompt 1",
      "aux response 1",
      "main prompt 2",
      "main response 2",
      "aux prompt 2",
    ],
  );
});

/** 未保存の応答を入力の直後に足し、一時行の元セッション・スレッドと描画キーを割り当てることを確認する。 */
test("buildMessageListProjection は live assistant を transient message として末尾に追加する", () => {
  const projection = buildMessageListProjection(
    [{ role: "user", text: "main prompt" }],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["user:main prompt", "assistant:streaming response"],
  );
  assert.deepEqual(projection.sources[1], {
    kind: "live-assistant",
    sessionId: "session-1",
    threadId: "thread-1",
  });
  assert.equal(projection.keys[1], "live-assistant-session-1-1-thread-1");
});

/** 同じ履歴位置の保存済み応答があれば配信行を追加せず、最終本文と元履歴位置を配信中のキーに引き継ぐことを確認する。 */
test("buildMessageListProjection は persisted assistant と live assistant を index で照合して key を引き継ぐ", () => {
  const projection = buildMessageListProjection(
    [
      { role: "user", text: "main prompt" },
      { role: "assistant", text: "final response" },
    ],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["user:main prompt", "assistant:final response"],
  );
  assert.deepEqual(projection.sources, [
    { kind: "session", messageIndex: 0 },
    { kind: "session", messageIndex: 1 },
  ]);
  assert.equal(projection.keys[1], "live-assistant-session-1-1-thread-1");
});

/** 以前の応答の本文と一致しても、別入力後で位置とスレッドが異なる応答は独立した配信行になることを確認する。 */
test("buildMessageListProjection は live text が既存末尾 assistant と同じでも新規 live row を追加する", () => {
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "same response" },
      { role: "user", text: "next prompt" },
    ],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-2",
        messageIndex: 2,
        text: "same response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => `${message.role}:${message.text}`),
    ["assistant:same response", "user:next prompt", "assistant:same response"],
  );
  assert.deepEqual(projection.sources[2], {
    kind: "live-assistant",
    sessionId: "session-1",
    threadId: "thread-2",
  });
  assert.equal(projection.keys[2], "live-assistant-session-1-2-thread-2");
});

/** 配信中と確定後の文言が違っても、対象位置の assistant 行で保存を検知することを確認する。 */
test("hasPersistedLiveAssistantMessage は final text が live text と違っても target index の assistant で完了扱いにする", () => {
  assert.equal(
    hasPersistedLiveAssistantMessage(
      [
        { role: "user", text: "main prompt" },
        { role: "assistant", text: "完了したよ。" },
      ],
      [],
      {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "処理中... テスト完了",
      },
      "session-1",
    ),
    true,
  );
});

/** 部分応答の末尾に失敗通知が加わっても、同じ履歴位置にある確定応答を検知することを確認する。 */
test("hasPersistedLiveAssistantMessage は partial fallback notice 付き final も target index で完了扱いにする", () => {
  assert.equal(
    hasPersistedLiveAssistantMessage(
      [
        { role: "user", text: "main prompt" },
        { role: "assistant", text: "partial response\n\n実行に失敗しました。" },
      ],
      [],
      {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "partial response",
      },
      "session-1",
    ),
    true,
  );
});

/** 親の後続応答より前の Auxiliary グループ内に配信行を置き、同じグループとして描画することを確認する。 */
test("buildMessageListProjection は Auxiliary live assistant を対象 group 内に追加する", () => {
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "main response" },
      { role: "assistant", text: "later main response" },
    ],
    [
      createAuxiliarySession([{ role: "user", text: "aux prompt" }], {
        id: "aux-1",
        displayAfterMessageIndex: 0,
      }),
    ],
    "session-1",
    {
      liveAssistant: {
        sessionId: "aux-1",
        threadId: "aux-thread-1",
        messageIndex: 1,
        text: "aux streaming response",
      },
    },
  );

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    [
      "main response",
      "aux prompt",
      "aux streaming response",
      "later main response",
    ],
  );
  assert.deepEqual(projection.groups, [
    null,
    { id: "aux-1", label: "Auxiliary" },
    { id: "aux-1", label: "Auxiliary" },
    null,
  ]);
  assert.equal(projection.keys[2], "live-assistant-aux-1-1-aux-thread-1");
});

/** 親と Auxiliary のどちらを対象にしても、対象会話自身の入力に続く次位置を返すことを確認する。 */
test("resolveLiveAssistantMessageIndex は target session の次 assistant index を返す", () => {
  const auxiliarySession = createAuxiliarySession(
    [{ role: "user", text: "aux prompt" }],
    {
      id: "aux-1",
    },
  );

  assert.equal(
    resolveLiveAssistantMessageIndex(
      [{ role: "user", text: "main prompt" }],
      [auxiliarySession],
      "session-1",
      "session-1",
    ),
    1,
  );
  assert.equal(
    resolveLiveAssistantMessageIndex(
      [{ role: "user", text: "main prompt" }],
      [auxiliarySession],
      "aux-1",
      "session-1",
    ),
    1,
  );
});

/** 遅れて届いた最終本文は対象会話の保存済み末尾に寄せるが、次の入力に先行する古い応答には寄せないことを確認する。 */
test("resolveLiveAssistantMessageIndex は保存済み末尾へ遅延 live final を同じ行として収束させる", () => {
  assert.equal(
    resolveLiveAssistantMessageIndex(
      [
        { role: "user", text: "main prompt" },
        { role: "assistant", text: "final response\n\nFailure notice" },
      ],
      [],
      "session-1",
      "session-1",
      "final response",
    ),
    1,
  );

  assert.equal(
    resolveLiveAssistantMessageIndex(
      [
        { role: "assistant", text: "same response" },
        { role: "user", text: "next prompt" },
      ],
      [],
      "session-1",
      "session-1",
      "same response",
    ),
    2,
  );

  assert.equal(
    resolveLiveAssistantMessageIndex(
      [{ role: "assistant", text: "main response" }],
      [
        createAuxiliarySession(
          [
            { role: "user", text: "aux prompt" },
            { role: "assistant", text: "aux final response" },
          ],
          { id: "aux-1" },
        ),
      ],
      "aux-1",
      "session-1",
      "aux final response",
    ),
    1,
  );
});

/** 実行が消え、対応する保存応答もない場合は古い配信本文を表示しないことを確認する。 */
test("shouldProjectLiveAssistantBridge は live run が消えて persisted assistant もなければ bridge を投影しない", () => {
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "stale streaming response",
      },
      activeSessionId: "session-1",
      hasLiveRun: false,
      hasPersistedAssistant: false,
    }),
    false,
  );
});

/** 実行は消えていても確定待ちの間は配信行を維持することを確認する。 */
test("shouldProjectLiveAssistantBridge は settling 中の bridge を投影する", () => {
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 1,
        text: "streaming response",
      },
      activeSessionId: "session-1",
      hasLiveRun: false,
      hasPersistedAssistant: false,
      isSettling: true,
    }),
    true,
  );
});

/** 表示対象の会話だけで実行中または保存応答確認後の橋渡しを許し、別会話には出さないことを確認する。 */
test("shouldProjectLiveAssistantBridge は live run 中または persisted assistant 検知後だけ bridge を投影する", () => {
  const bridge = {
    sessionId: "session-1",
    threadId: "thread-1",
    messageIndex: 1,
    text: "streaming response",
  };

  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-1",
      hasLiveRun: true,
      hasPersistedAssistant: false,
    }),
    true,
  );
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-1",
      hasLiveRun: false,
      hasPersistedAssistant: true,
    }),
    true,
  );
  assert.equal(
    shouldProjectLiveAssistantBridge({
      bridge,
      activeSessionId: "session-2",
      hasLiveRun: true,
      hasPersistedAssistant: true,
    }),
    false,
  );
});

/** 親履歴を指す行は保存位置を親の詳細取得に渡し、同じ成果物を返すことを確認する。 */
test("loadProjectedMessageArtifact は parent source の artifact detail loader を呼ぶ", async () => {
  const artifact = createArtifact();
  const loaded = await loadProjectedMessageArtifact({
    source: { kind: "session", messageIndex: 2 },
    /** 親の取得に渡された履歴位置を確かめて所定の成果物を返す。 */
    loadSessionArtifact: (messageIndex) => {
      assert.equal(messageIndex, 2);
      return Promise.resolve(artifact);
    },
  });

  assert.equal(loaded, artifact);
});

/** Auxiliary の挿入で描画位置が移動しても、親成果物を元の履歴位置で読むことを確認する。 */
test("loadProjectedMessageArtifact は projected index ではなく source messageIndex で parent artifact を読む", async () => {
  const artifact = createArtifact();
  const projection = buildMessageListProjection(
    [
      { role: "assistant", text: "parent response 1" },
      { role: "assistant", text: "parent response 2" },
    ],
    [
      createAuxiliarySession([{ role: "assistant", text: "aux response" }], {
        displayAfterMessageIndex: 0,
      }),
    ],
    "session-1",
  );
  const loaded = await loadProjectedMessageArtifact({
    source: projection.sources[2],
    /** 挿入後の描画位置ではなく挿入前の親履歴位置で取得されたことを確かめる。 */
    loadSessionArtifact: (messageIndex) => {
      assert.equal(messageIndex, 1);
      return artifact;
    },
  });

  assert.deepEqual(
    projection.messages.map((message) => message.text),
    ["parent response 1", "aux response", "parent response 2"],
  );
  assert.equal(loaded, artifact);
});

// @test-value v2
// kind = "contract"
// claim = "追加detailがないAuxiliary artifactは投影済み内容をそのまま返す"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Turn・監査" }
// fault = "detail不要なartifactに不要な詳細取得を行い表示を失う"
// observable = "投影済みartifactのidentity"
// observation_boundary = "public-boundary"
// scope = "auxiliary-projected-artifact-inline"
// lifecycle = "permanent"
// impact = "軽量なAuxiliary artifact表示が失われる"
// distinction = "detailAvailableのない既存内容はlazy APIと別経路で扱う"
// @end-test-value
/** 追加詳細がない Auxiliary の成果物は親へ照会せず、投影済みの参照をそのまま使うことを確認する。 */
test("loadProjectedMessageArtifact は Auxiliary source の artifact を直接返す", async () => {
  const artifact = { ...createArtifact(), detailAvailable: false };
  const loaded = await loadProjectedMessageArtifact({
    source: {
      kind: "auxiliary",
      sessionId: "aux-1",
      messageIndex: 1,
      artifact,
    },
    /** 親の詳細 API を誤って呼ぶと試験を失敗させる。 */
    loadSessionArtifact: () => {
      throw new Error(
        "parent artifact loader should not run for auxiliary source",
      );
    },
  });

  assert.equal(loaded, artifact);
});

// @test-value v2
// kind = "contract"
// claim = "投影済みAuxiliary messageのdetailAvailable artifactは元会話IDとmessage indexで詳細を取得する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Turn・監査" }
// fault = "軽量summaryを詳細として返し、再読み込み後のoperation detailを表示できない"
// observable = "detail API呼び出しの会話ID・indexと返されたartifact"
// observation_boundary = "public-boundary"
// scope = "auxiliary-projected-artifact-detail"
// lifecycle = "permanent"
// impact = "Auxiliary turnの詳細が閲覧できなくなる"
// distinction = "Main session indexとAuxiliary owner indexの写像を検査する"
// @end-test-value
/** 遅延詳細のある Auxiliary の成果物は、親でなく元の会話 ID とメッセージ位置で詳細を取得することを確認する。 */
test("loadProjectedMessageArtifact は Auxiliary source の詳細を元会話IDとindexで読む", async () => {
  const artifact = createArtifact();
  const detail = { ...artifact, title: "Loaded detail" };
  const loaded = await loadProjectedMessageArtifact({
    source: {
      kind: "auxiliary",
      sessionId: "aux-1",
      messageIndex: 1,
      artifact,
    },
    /** Auxiliary の詳細取得が親のローダーに流れた場合に失敗させる。 */
    loadSessionArtifact: () => {
      throw new Error(
        "parent artifact loader should not run for auxiliary source",
      );
    },
    /** Auxiliary の元会話と履歴位置を確かめ、概要と区別できる詳細を返す。 */
    loadAuxiliaryArtifact: (sessionId, messageIndex) => {
      assert.equal(sessionId, "aux-1");
      assert.equal(messageIndex, 1);
      return detail;
    },
  });

  assert.equal(loaded, detail);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary detail取得中に選択ownerが変わった場合は古い詳細を新しい列へ表示しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 会話の選択と表示" }
// fault = "遅延した旧会話detailが切替後の会話へ混入する"
// observable = "遅延API結果に対するnull戻り値"
// observation_boundary = "component-behavior"
// scope = "auxiliary-artifact-owner-guard"
// lifecycle = "permanent"
// impact = "別の会話の実行詳細を誤表示する"
// distinction = "同期的な元ID index写像だけでは非同期owner切替を検出できない"
// @end-test-value
/** 以前の Auxiliary の詳細が選択変更後に届いたとき、別会話の列へ持ち込まず null にすることを確認する。 */
test("Auxiliary artifact detailは取得中にownerが切り替われば破棄する", async () => {
  const owner = createAuxiliarySession([
    { role: "assistant", text: "done", artifact: createArtifact() },
  ]);
  let current: AuxiliarySession | null = owner;
  const deferred: { resolve?: (artifact: MessageArtifact) => void } = {};
  const loading = loadOwnedAuxiliaryMessageArtifact({
    owner,
    /** 詳細待ちの間に切り替えた最新オーナーを返す。 */
    getCurrentOwner: () => current,
    messageIndex: 0,
    /** オーナーを変更するまで API 応答を保留できるようにする。 */
    loadArtifact: () =>
      new Promise((resolve) => {
        deferred.resolve = resolve;
      }),
  });
  current = createAuxiliarySession([], { id: "aux-2" });
  assert.ok(deferred.resolve);
  deferred.resolve(createArtifact());
  assert.equal(await loading, null);
});

/** 元情報なし、Auxiliary の成果物なし、親の取得結果なしのいずれでも null を返すことを確認する。 */
test("loadProjectedMessageArtifact は source 不明または artifact なしなら null を返す", async () => {
  const missingSource = await loadProjectedMessageArtifact({
    source: undefined,
    /** 元情報がなければ採用されない親成果物を返す。 */
    loadSessionArtifact: () => createArtifact(),
  });
  const missingArtifact = await loadProjectedMessageArtifact({
    source: {
      kind: "auxiliary",
      sessionId: "aux-1",
      messageIndex: 1,
      artifact: undefined,
    },
    /** Auxiliary の欠落を親で埋めないことを見分けるための親成果物。 */
    loadSessionArtifact: () => createArtifact(),
  });
  const parentMissingArtifact = await loadProjectedMessageArtifact({
    source: { kind: "session", messageIndex: 1 },
    /** 親メッセージを取得しても成果物がない状態を返す。 */
    loadSessionArtifact: () => undefined,
  });

  assert.equal(missingSource, null);
  assert.equal(missingArtifact, null);
  assert.equal(parentMissingArtifact, null);
});
