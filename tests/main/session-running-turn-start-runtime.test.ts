import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import assert from "node:assert/strict";
import { it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type {
  ComposerPreview,
  LiveApprovalDecision,
} from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type {
  ProviderCodingAdapter,
  RunSessionTurnInput,
} from "../../src-electron/providers/provider-runtime.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import { refreshSessionCharacterRuntimeSnapshot } from "../../src-electron/character/character-runtime-service.js";
import { NEUTRAL_CHARACTER_ID } from "../../src-shared/character/character-owner.js";
import {
  SessionRuntimeFixture as SessionRuntimeService,
  type SessionRuntimeFixtureDeps as SessionRuntimeServiceDeps,
} from "./session-runtime-fixture.js";

/** 既定のCharacterとモデルを持つSessionを作り、ケースごとの状態だけ上書きする。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Runtime Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model: "gpt-5.4",
      reasoningEffort: "high",
    }),
    ...overrides,
  };
}

const TEST_EXECUTION_OPTIONS = captureSessionExecutionOptions(createSession());

/** 表示名から本文と版が判別できるCharacter snapshotを作る。 */
function createCharacterRuntimeSnapshot(
  name: string,
): CharacterRuntimeSnapshot {
  return {
    characterId: "char-a",
    name,
    description: "",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# " + name,
    definitionSha256: name.toLowerCase(),
    definitionByteSize: name.length + 2,
    snapshotAt: name.toLowerCase(),
  };
}

/** テストのCodexモデルと許可される推論レベルをカタログに載せる。 */
function createProviderCatalog(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
    ],
  };
}

/** 本体と同じturn生成コマンド型をfixtureにも使う。 */
type CreateSessionTurnInput = Parameters<
  SessionRuntimeServiceDeps["createSessionTurn"]
>[0];

/** 渡された開始内容に固定のturn IDを足し、保存済みの形で返す。 */
function createSessionTurn(input: CreateSessionTurnInput): SessionTurnRecord {
  return { id: 1, ...input };
}

/** 外部通信なしで実行開始を試せる依存一式を用意し、観測対象だけケースごとに差し替える。 */
function createRuntimeDeps(
  session: Session,
  adapter: ProviderCodingAdapter,
  overrides: Partial<SessionRuntimeServiceDeps>,
): SessionRuntimeServiceDeps {
  return {
    /** 対象のSessionだけをIDで解決する。 */
    getSession: (sessionId) => (sessionId === session.id ? session : null),
    /** 永続化を使わず、更新要求を既定の保存結果として返す。 */
    upsertSession: (next) => next,
    /** 添付がない正常入力として、既定のコンポーザ検証を通す。 */
    resolveComposerPreview: async () =>
      ({ attachments: [], errors: [] }) satisfies ComposerPreview,
    /** 実環境に依存しないアプリ設定を返す。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** fixtureのモデルを、解決結果とカタログの両方に供給する。 */
    resolveProviderCatalog: () => {
      const provider = createProviderCatalog();
      return { snapshot: { providers: [provider] }, provider };
    },
    /** 実行入力を検証できるケース専用アダプターを返す。 */
    getProviderCodingAdapter: () => adapter,
    createSessionTurn,
    /** 既定のfixtureではturn更新を保存しない。 */
    updateSessionTurn: () => undefined,
    /** 実行状態の通知を開始保存の観測から切り離す。 */
    setLiveSessionRun: () => undefined,
    /** 以前のlive runが残っていない前提にする。 */
    getLiveSessionRun: () => null,
    /** ユーザー操作待ちを発生させず承認済みにする。 */
    waitForApprovalDecision: async (): Promise<LiveApprovalDecision> =>
      "approve",
    /** 対話が必要な要求には固定の取消結果を返す。 */
    waitForElicitationResponse: async () => ({ action: "cancel" }),
    /** Provider使用量の保存を実行開始の検証から切り離す。 */
    setProviderQuotaTelemetry: () => undefined,
    /** コンテキスト使用量の更新を外部状態へ送らない。 */
    setSessionContextTelemetry: () => undefined,
    /** 既定では外部スレッドを持たず、無効化を必要なケースだけで観測する。 */
    invalidateProviderSessionThread: async () => undefined,
    /** 実行後の使用量取得タイマーは起動しない。 */
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
    /** live run変更をウィンドウへ伝播しない。 */
    broadcastLiveSessionRun: () => undefined,
    /** テスト依存には解決すべき承認待ちを保持しない。 */
    resolvePendingApprovalRequest: () => undefined,
    /** テスト依存には残った問い合わせを保持しない。 */
    resolvePendingElicitationRequest: () => undefined,
    currentTimestampLabel,
    ...overrides,
  };
}

/** 開始後の本体呼び出しだけを注入し、それ以外を固定したProviderアダプターを作る。 */
function createAdapter(
  runSessionTurn: ProviderCodingAdapter["runSessionTurn"],
): ProviderCodingAdapter {
  return {
    /** 実行入力の検証に必要な最小の論理プロンプトを返す。 */
    composePrompt: () => ({
      systemBodyText: "system",
      inputBodyText: "input",
      logicalPrompt: {
        systemText: "system",
        inputText: "input",
        composedText: "system\ninput",
      },
      imagePaths: [],
      additionalDirectories: [],
    }),
    /** 使用量情報を提供しないアダプターとして振る舞う。 */
    getProviderQuotaTelemetry: async () => null,
    /** 既定のアダプターは個別スレッドの外部状態を持たない。 */
    invalidateSessionThread: async () => undefined,
    /** 全スレッドの無効化で実Providerへ接続しない。 */
    invalidateAllSessionThreads: async () => undefined,
    runSessionTurn,
  };
}

// @test-value v2
// kind = "invariant"
// claim = "各送信で採用したCharacter定義を保存してからProviderへ渡し、実行中の変更は次の送信から反映する"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "更新snapshotを保存前に送る、保存時に旧定義へ戻す、または実行中に再解決して同じTurnの定義が変わる"
// observable = "Provider入力の本文とthread、送信時点の保存snapshot、次Turnの入力"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService send-time Character definition"
// lifecycle = "permanent"
// impact = "長期Sessionに古い定義が残るか、Archive後や再起動後に採用した定義を再現できない"
// distinction = "storage単体と異なり解決・保存・prompt合成・Provider dispatchを通した入力を観測する"
// @end-test-value
/** 更新済みのCharacter定義を永続化してから送信し、実行中に変わった定義は次回だけ使うことを確認する。 */
it("送信時snapshotを先に保存し、Turn中の定義更新は次の送信で採用する", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Saved");
  let canonical = {
    ...oldSnapshot,
    definitionMarkdown: "# Latest definition",
    definitionSha256: "latest",
    snapshotAt: "latest",
  };
  let persisted = createSession({
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "continuing-thread",
  });
  let resolveCount = 0;
  const prompts: string[] = [];
  const adapter = createAdapter(async (input) => {
    assert.deepEqual(
      input.session.characterRuntimeSnapshot,
      persisted.characterRuntimeSnapshot,
    );
    assert.equal(input.session.threadId, "continuing-thread");
    const prompt = composeProviderPrompt(input);
    prompts.push(prompt.systemBodyText);
    const adoptedSnapshot = input.session.characterRuntimeSnapshot;
    canonical = {
      ...canonical,
      definitionMarkdown: "# Following definition",
      definitionSha256: "following",
      snapshotAt: "following",
    };
    assert.deepEqual(input.session.characterRuntimeSnapshot, adoptedSnapshot);
    return {
      threadId: "continuing-thread",
      assistantText: "done",
      usage: null,
    };
  });
  adapter.composePrompt = composeProviderPrompt;
  const runtime = new SessionRuntimeService(
    createRuntimeDeps(persisted, adapter, {
      /** 初回・次回のいずれも最後に保存されたSessionを解決する。 */
      getSession: () => persisted,
      /** 送信開始ごとにその時点の正本を返し、定義の解決回数を記録する。 */
      resolveRuntimeSessionForTurn: (session) =>
        refreshSessionCharacterRuntimeSnapshot(session, async () => {
          resolveCount += 1;
          return canonical;
        }),
      /** 既存メッセージ数の一致を要求したうえで、新しいsnapshotと追加分を保持する。 */
      persistRunningTurnStart: (session, expectedMessageCount) => {
        assert.equal(persisted.messages.length, expectedMessageCount);
        persisted = structuredClone({
          ...session,
          messages: [...persisted.messages, ...session.messages],
        });
        return session;
      },
      /** 終端時の保存内容を次の送信で観測できるように複製する。 */
      upsertSession: (session) => {
        persisted = structuredClone(session);
        return persisted;
      },
    }),
  );
  const first = await runtime.runSessionTurn(persisted.id, {
    executionOptions: TEST_EXECUTION_OPTIONS,
    userMessage: "first",
  });
  assert.equal(first.runState, "idle");
  assert.equal(first.characterRuntimeSnapshot?.definitionSha256, "latest");
  assert.equal(first.characterRuntimeSnapshot?.name, oldSnapshot.name);
  const second = await runtime.runSessionTurn(persisted.id, {
    executionOptions: TEST_EXECUTION_OPTIONS,
    userMessage: "second",
  });
  assert.equal(second.runState, "idle");
  assert.equal(resolveCount, 2);
  assert.match(prompts[0]!, /Latest definition/);
  assert.doesNotMatch(prompts[0]!, /Following definition/);
  assert.match(prompts[1]!, /Following definition/);
  assert.deepEqual(
    persisted.messages.map((message) => message.text),
    ["first", "done", "second", "done"],
  );
  assert.deepEqual(
    second.messages.map((message) => message.text),
    ["second", "done"],
  );
  assert.equal(second.messageCount, 4);
});

// @test-value v2
// kind = "invariant"
// claim = "定義の解決または送信開始保存に失敗した場合、Providerは動かず保存済みsnapshotと会話を維持する"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "更新失敗を旧snapshotへのfallbackで隠して実行する、または保存失敗後もProviderをdispatchする"
// observable = "runSessionTurnのreject、Provider呼出数、元Sessionのsnapshotとmessages"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService Character failure admission"
// lifecycle = "permanent"
// impact = "利用者が更新反映済みと誤認したまま操作を実行する"
// distinction = "CharacterStorageの例外検証ではなく送信入口からProvider副作用までの停止を検証する"
// @end-test-value
/** Character解決と開始時の永続化のどちらに失敗しても、既存snapshot・スレッドを維持してdispatchしない。 */
it("Character解決またはsnapshot保存の失敗を送信成功へ読み替えない", async () => {
  for (const stage of ["resolve", "persist"] as const) {
    const snapshot = createCharacterRuntimeSnapshot("Saved");
    const session = createSession({
      characterRuntimeSnapshot: snapshot,
      threadId: "thread-kept",
    });
    let dispatched = 0;
    const adapter = createAdapter(async () => {
      dispatched += 1;
      throw new Error("must not dispatch");
    });
    const runtime = new SessionRuntimeService(
      createRuntimeDeps(session, adapter, {
        /** 解決が失敗した場合と、新しい定義を解決できた場合を分ける。 */
        resolveRuntimeSessionForTurn: async (current) => {
          if (stage === "resolve") throw new Error("definition unavailable");
          return {
            ...current,
            characterRuntimeSnapshot: {
              ...snapshot,
              definitionMarkdown: "updated",
            },
          };
        },
        /** snapshotの開始保存だけを失敗させ、Providerが未呼び出しであることを検証する。 */
        persistRunningTurnStart: () => {
          throw new Error("snapshot persistence failed");
        },
      }),
    );
    await assert.rejects(
      runtime.runSessionTurn(session.id, {
        executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "send",
      }),
      stage === "resolve"
        ? /definition unavailable/
        : /snapshot persistence failed/,
    );
    assert.equal(dispatched, 0);
    assert.deepEqual(session.characterRuntimeSnapshot, snapshot);
    assert.deepEqual(session.messages, []);
    assert.equal(session.threadId, "thread-kept");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Characterを選ばず作成したneutral Sessionはcatalog解決なしで継続できる"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "neutralを削除済みCharacterと誤認して既存会話を使用不可にする"
// observable = "turn用Sessionとresolver呼出の有無"
// observation_boundary = "consumer"
// scope = "refreshSessionCharacterRuntimeSnapshot neutral"
// lifecycle = "permanent"
// impact = "Characterが0件の環境で作成したSessionが送信不能になる"
// distinction = "通常Characterの更新とは異なる既存neutral契約を最小のresolver境界で守る"
// @end-test-value
/** Characterを持たない通常Sessionを、削除済みCharacterと誤認して再解決しない。 */
it("snapshotなしneutral SessionはCharacterの再解決を行わない", async () => {
  const session = createSession({
    characterId: NEUTRAL_CHARACTER_ID,
    characterRuntimeSnapshot: null,
  });
  assert.equal(
    await refreshSessionCharacterRuntimeSnapshot(session, async () => {
      throw new Error("neutral must not resolve a Character");
    }),
    session,
  );
});

// @test-value v2
// kind = "contract"
// claim = "通常Turnは開始日時をProviderへ渡し、設定OFFとauthoringでは日時を渡さない"
// oracle = { type = "contract", ref = "docs/design/prompt-composition.md" }
// fault = "現在日時が欠落するか設定/Session種別を無視して送信する"
// observable = "Provider runSessionTurnが受け取るcurrentDateTime"
// observation_boundary = "consumer"
// scope = "SessionRuntimeServiceの現在日時入力"
// lifecycle = "permanent"
// @end-test-value
/** 通常Turnでのみ設定に従って日時を渡し、無効設定とauthoringでは送らないことを確認する。 */
it("開始時の現在日時を通常Turnの設定に従って渡す", async () => {
  for (const [sessionKind, enabled] of [
    ["default", true],
    ["default", false],
    ["character-authoring", true],
  ] as const) {
    const session = createSession({ sessionKind });
    const seen: Array<string | undefined> = [];
    const adapter = createAdapter(async (input) => {
      seen.push(input.currentDateTime);
      throw new Error("stop after dispatch");
    });
    const observed = new Date("2026-11-01T03:00:00Z");
    const service = new SessionRuntimeService(
      createRuntimeDeps(session, adapter, {
        /** 設定による現在日時の有効・無効を切り替える。 */
        getAppSettings: () => ({
          ...normalizeAppSettings({}),
          currentDateEnabled: enabled,
        }),
        /** Providerへ渡された日時を比較できる固定の時点を返す。 */
        currentDate: () => observed,
      }),
    );
    await service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "依頼",
    });
    assert.equal(seen.length, 1);
    if (enabled && sessionKind === "default")
      assert.equal(Date.parse(seen[0]!), observed.getTime());
    else assert.equal(seen[0], undefined);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "invalid authoring snapshotの専用metadata transactionが失敗した場合はcomposer、thread invalidation、running開始保存、providerへ進まない"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "snapshot/thread clearがcommitできていないのにvalidationまたはprovider外部副作用を開始する"
// observable = "composer・invalidation・running保存・provider・turnの呼出フラグ"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "running開始transactionではなくcomposerより前の専用metadata transaction failure timingを観測する"
// @end-test-value
/** authoringの無効snapshotを保存から除去できない場合は、添付の検証にも実行開始にも進まない。 */
it("invalid authoring snapshotのmetadata clear失敗時はcomposerもthread invalidationも開始しない", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  let providerDispatched = false;
  let providerThreadInvalidated = false;
  let runningTurnCreated = false;
  let composerResolved = false;
  let runningStartPersisted = false;
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(
    createRuntimeDeps(session, adapter, {
      /** 無効なCharacter snapshotが解決結果に残らない状態を再現する。 */
      resolveRuntimeSessionForTurn: (stored) => ({
        ...stored,
        characterRuntimeSnapshot: null,
      }),
      /** 専用メタデータの保存を拒否し、この時点から先へ進まないことを検証する。 */
      clearCharacterAuthoringRuntimeState: () => {
        throw new Error("metadata clear failed");
      },
      /** メタデータ保存失敗後にコンポーザー解決へ進んだ場合を記録する。 */
      resolveComposerPreview: async () => {
        composerResolved = true;
        return { attachments: [], errors: [] };
      },
      /** 未確定メタデータのまま開始保存へ進む誤動作を記録する。 */
      persistRunningTurnStart: (next) => {
        runningStartPersisted = true;
        return next;
      },
      /** 失敗した更新に伴って外部スレッドを無効化した場合を記録する。 */
      invalidateProviderSessionThread: () => {
        providerThreadInvalidated = true;
      },
      /** 開始前の失敗でturnレコードを作った場合に検知する。 */
      createSessionTurn: (input) => {
        runningTurnCreated = true;
        return createSessionTurn(input);
      },
    }),
  );

  await assert.rejects(
    service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願い",
    }),
    /metadata clear failed/,
  );
  assert.equal(composerResolved, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerDispatched, false);
  assert.equal(providerThreadInvalidated, false);
  assert.equal(runningTurnCreated, false);
});

// @test-value v2
// kind = "regression"
// claim = "invalid authoring snapshotは専用metadata transactionで永続clearし、thread cache無効化後のcomposer validationが失敗してもclear済み状態を維持する"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "composer validation失敗時に古いsnapshotまたはprovider threadを永続状態やprocess-local cacheへ残す"
// observable = "永続Sessionのsnapshot/thread/messages/runStateとinvalidation・provider呼出履歴"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "metadata transaction failureではなく、clear commit後のcomposer validation failureとuser message非保存を観測する"
// @end-test-value
/** 無効snapshotとthreadを先に永続解除し、後続の添付検証が失敗しても解除済み状態を残す。 */
it("invalid authoring snapshotはcomposerより前に永続clearし、validation失敗後もclear済み状態を維持する", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  let genericUpsertCalled = false;
  let runningStartPersisted = false;
  let providerThreadInvalidated = false;
  let providerDispatched = false;
  let persistedSession = session;
  const events: string[] = [];
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(
    createRuntimeDeps(session, adapter, {
      /** 解決でsnapshotが無効と判明する経路を再現する。 */
      resolveRuntimeSessionForTurn: (stored) => ({
        ...stored,
        characterRuntimeSnapshot: null,
      }),
      /** snapshotとthreadを取り除いたSessionを専用経路の保存結果とする。 */
      clearCharacterAuthoringRuntimeState: (resolved) => {
        events.push("metadata-clear");
        persistedSession = {
          ...resolved,
          characterRuntimeSnapshot: null,
          threadId: "",
        };
        return persistedSession;
      },
      /** 解除済み状態で検証へ進んだことを照合し、添付だけを意図的に拒否する。 */
      resolveComposerPreview: async (resolved) => {
        events.push("composer-validation");
        assert.equal(resolved.characterRuntimeSnapshot, null);
        assert.equal(resolved.threadId, "");
        return { attachments: [], errors: ["attachment invalid"] };
      },
      /** 入力検証が失敗したのに開始保存があった場合を記録する。 */
      persistRunningTurnStart: (next) => {
        runningStartPersisted = true;
        return next;
      },
      /** 専用解除を汎用upsertで代用した場合を記録する。 */
      upsertSession: (next) => {
        genericUpsertCalled = true;
        return next;
      },
      /** 保存後のローカルthread無効化を順序付きで観測する。 */
      invalidateProviderSessionThread: () => {
        providerThreadInvalidated = true;
        events.push("thread-invalidated");
      },
    }),
  );

  await assert.rejects(
    service.runSessionTurn(session.id, {
      executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "お願い",
    }),
    /attachment invalid/,
  );
  assert.equal(genericUpsertCalled, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerThreadInvalidated, true);
  assert.equal(providerDispatched, false);
  assert.equal(persistedSession.characterRuntimeSnapshot, null);
  assert.equal(persistedSession.threadId, "");
  assert.deepEqual(persistedSession.messages, []);
  assert.equal(persistedSession.runState, "idle");
  assert.deepEqual(events, [
    "metadata-clear",
    "thread-invalidated",
    "composer-validation",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "authoring snapshotの専用clear commit後にthreadをinvalidateし、composerとrunning開始保存の成功後だけproviderをdispatchする"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "snapshot clearのcommit前にthreadをinvalidateするか、古いthreadを保持したままproviderを開始する"
// observable = "metadata clearからterminalまでのevent順序と保存Session"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "composer validation failureではなく、metadata clear、invalidation、composer、running開始、provider、terminalの成功順序を観測する"
// @end-test-value
/** 専用解除、thread無効化、入力検証、開始保存を順に経てからdispatchし、終端を汎用経路で保存することを確認する。 */
it("snapshot clearをcommitしてthreadをinvalidateした後にproviderをdispatchし、terminal状態はgeneric経路で保存する", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  const events: string[] = [];
  const adapter = createAdapter(async () => {
    events.push("provider-dispatch");
    throw new Error("provider failed");
  });
  const service = new SessionRuntimeService(
    createRuntimeDeps(session, adapter, {
      /** 無効なauthoring定義を取り除くべき状態として返す。 */
      resolveRuntimeSessionForTurn: (stored) => ({
        ...stored,
        characterRuntimeSnapshot: null,
      }),
      /** 専用解除を記録し、snapshotとthreadのない状態を後続段階へ渡す。 */
      clearCharacterAuthoringRuntimeState: (resolved) => {
        events.push("metadata-clear");
        return { ...resolved, characterRuntimeSnapshot: null, threadId: "" };
      },
      /** 入力検証の時点を記録し、ここでは正常に通す。 */
      resolveComposerPreview: async () => {
        events.push("composer-validation");
        return { attachments: [], errors: [] };
      },
      /** 解除済みsnapshotとthread、開始位置を照合して開始保存を記録する。 */
      persistRunningTurnStart: (next, expectedMessageCount) => {
        assert.equal(expectedMessageCount, 0);
        assert.equal(next.characterRuntimeSnapshot, null);
        assert.equal(next.threadId, "");
        events.push("running-start-persisted");
        return next;
      },
      /** 元SessionとProviderに対応するthreadだけが対象かを照合する。 */
      invalidateProviderSessionThread: (providerId, sessionId) => {
        assert.equal(providerId, session.provider);
        assert.equal(sessionId, session.id);
        events.push("provider-thread-invalidated");
      },
      /** 汎用保存へ進んだ時点と終端状態を記録する。 */
      upsertSession: (next) => {
        events.push("generic-terminal-" + next.runState);
        return next;
      },
    }),
  );

  const result = await service.runSessionTurn(session.id, {
    executionOptions: TEST_EXECUTION_OPTIONS,
    userMessage: "お願い",
  });

  assert.equal(result.runState, "error");
  assert.deepEqual(events, [
    "metadata-clear",
    "provider-thread-invalidated",
    "composer-validation",
    "running-start-persisted",
    "provider-dispatch",
    "generic-terminal-error",
    "provider-thread-invalidated",
  ]);
});
