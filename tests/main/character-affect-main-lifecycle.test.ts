import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionMetadataResult } from "../../src-electron/session/session-runtime-storage-contract.js";
import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { CharacterContextResponse, CharacterAffectAppraiseRequest } from "../../src-shared/character-context/character-context-contract.js";
import type { AppLogInput } from "../../src-shared/window/app-log-types.js";
import { CharacterAffectTurnSettlementStorage, CHARACTER_AFFECT_TURN_MAX_ATTEMPTS } from "../../src-electron/character/character-affect-turn-settlement-storage.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character/character-affect-turn-ownership-coordinator.js";
import { createCharacterAffectTurnMainLifecycle, type CharacterAffectTurnLifecycleRuntime } from "../../src-electron/character/character-affect-turn-main-lifecycle.js";
import type { CharacterAffectTurnDrainCursor } from "../../src-electron/character/character-affect-turn-drain.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import type { RunBackgroundStructuredPromptInput, RunBackgroundStructuredPromptResult } from "../../src-electron/providers/provider-runtime.js";

function toMetadata(session: Session | null): SessionMetadataResult | null {
  if (!session) return null;
  const { messages, stream: _stream, characterRuntimeSnapshot, ...summary } = session;
  return { summary, characterRuntimeSnapshot, messageCount: messages.length };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const occurredAt = "2026-09-19T00:00:00.000Z";
const session: Session = {
  ...buildNewSession({
    id: "session-a", taskTitle: "Lifecycle test", workspaceLabel: "workspace", workspacePath: "C:/workspace",
    branch: "main", characterId: "character-a", character: "A", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
  }),
  messages: [{ role: "user", text: "user" }, { role: "assistant", text: "assistant" }],
};
const context: CharacterContextResponse = {
  schemaVersion: "withmate-character-context-v1",
  baseline: { definitionSha256: "fixture", snapshotAt: occurredAt },
  affect: { mode: "active", effective: [], evaluatedAt: occurredAt, version: "v1", updatedAt: null },
  memory: { items: [], updatedAt: null },
};

// @test-value v2
// kind = "invariant"
// claim = "metadataまたはtarget assistantの読取失敗はowner不在扱いで破棄せず有限retryで隔離し、role/text不一致と評価後・排他内のCharacter owner変更にはAffectを適用しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "owner読取失敗をnullへ救済してpendingを失う、無期限retryする、または古いowner/本文照合だけで評価を適用する"
// observable = "retry回数とquarantine状態、pending消失、evaluation/appraise呼出数、外部評価promptのpending本文"
// observation_boundary = "component-behavior"
// scope = "Main Affect lifecycleと実SQLite Session metadata/target identity・settlement storage"
// lifecycle = "permanent"
// impact = "会話読取障害時に確定turnの評価が失われるか、別Character/assistantのAffectが誤適用される"
// distinction = "incarnation再作成testでは扱わないrole/text/Character変更と読取例外を受入drainから一時SQLiteで短時間に検証する"
// @end-test-value
test("Main Affect drainはtarget照合と最新Character ownerを検証し読取失敗を有限retryする", { timeout: 10_000 }, async (t) => {
  for (const scenario of ["metadata-error", "identity-error", "role-mismatch", "text-mismatch", "character-after-evaluation", "character-in-ownership"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-target-"));
    const dbPath = path.join(directory, "app.db");
    const sessions = new SessionStorageV6(dbPath);
    const settlements = new CharacterAffectTurnSettlementStorage(dbPath);
    try {
      const owner = sessions.insertSession(session);
      settlements.enqueue({ correlationId: scenario, characterId: owner.characterId, sessionId: owner.id,
        sessionIncarnationId: owner.incarnationId, userMessage: "pending user", assistantMessage: "assistant",
        assistantMessageIndex: 1, occurredAt });
      settlements.markReady(scenario);
      let evaluations = 0;
      let appraisals = 0;
      let characterChanged = false;
      const changeCharacter = () => {
        if (characterChanged) return;
        characterChanged = true;
        sessions.updateSession({ ...sessions.getSession(owner.id)!, characterId: "character-b" });
      };
      const runtime: CharacterAffectTurnLifecycleRuntime = { characterContextService: {
        getContext: async () => context,
        appraise: async () => {
          appraisals += 1;
          return { schemaVersion: "withmate-character-context-v1", characterId: owner.characterId,
            sessionId: owner.id, saved: [], rejected: [], version: "v2", updatedAt: occurredAt };
        },
      } };
      const failure = settlements.recordFailure.bind(settlements);
      t.mock.method(settlements, "recordFailure", (input: Parameters<CharacterAffectTurnSettlementStorage["recordFailure"]>[0]) => failure({ ...input, observedAt: "2000-01-01T00:00:00.000Z" }));
      const lifecycle = createCharacterAffectTurnMainLifecycle({
        getSettlementStorage: () => settlements,
        getRuntimeApi: () => runtime,
        getCharacterSnapshot: () => ({ characterId: owner.characterId, name: "A", description: "", iconFilePath: "",
          theme: { main: "#6f8cff", sub: "#6fb8c7" }, definitionMarkdown: "Character A",
          definitionSha256: "fixture", definitionByteSize: 11, snapshotAt: occurredAt }),
        getAppSettings: () => normalizeAppSettings({}),
        getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async <TOutput>(input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> => {
          evaluations += 1;
          assert.ok(input.prompt.userText.includes("pending user"));
          assert.ok(input.prompt.userText.includes("assistant"));
          if (scenario === "character-after-evaluation") changeCharacter();
          return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
            layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
            valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
          }] } as TOutput };
        } }),
        getSessionMetadata: async (id) => {
          if (scenario === "metadata-error") throw new Error("metadata read failed");
          return sessions.getSessionMetadata(id);
        },
        getSessionMessageIdentity: async (input) => {
          if (scenario === "identity-error") throw new Error("identity read failed");
          const message = sessions.getSessionMessageIdentity(input);
          if (scenario === "role-mismatch" && message) return { ...message, role: "user" };
          if (scenario === "text-mismatch" && message) return { ...message, text: "different assistant" };
          return message;
        },
        startupRecoveryCutoff: occurredAt,
        runAppraisalExclusive: async (operation) => {
          if (scenario === "character-in-ownership") changeCharacter();
          return operation();
        },
        writeAppLog: () => undefined,
        getDrainCursor: () => undefined,
        setDrainCursor: () => undefined,
      });
      const readFailure = scenario === "metadata-error" || scenario === "identity-error";
      for (let attempt = 0; attempt < (readFailure ? CHARACTER_AFFECT_TURN_MAX_ATTEMPTS : 1); attempt += 1) {
        assert.equal(await lifecycle.drain(), readFailure && attempt + 1 < CHARACTER_AFFECT_TURN_MAX_ATTEMPTS);
      }
      assert.equal(appraisals, 0);
      assert.equal(evaluations, scenario.startsWith("character-") ? 1 : 0);
      if (readFailure) {
        const pending = settlements.getPending(scenario);
        assert.ok(pending?.quarantinedAt);
        assert.equal(pending.attemptCount, CHARACTER_AFFECT_TURN_MAX_ATTEMPTS);
        assert.equal(pending.attemptStartedAt, null);
        assert.equal(await lifecycle.drain(), false);
      } else {
        assert.equal(settlements.getPending(scenario), null);
      }
    } finally {
      settlements.close();
      sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Mainが使用するdrainは評価・metadata・target読取待機中のruntime/storage交換後、成功・例外のどちらでも旧試行を適用せず、現行storageで次回drainを完了できる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "失効した評価の保存・failure記録が旧storageへ到達する、storage交換後のcursorを旧drainが上書きする、またはcurrent pendingが試行中のまま回復できない"
// observable = "実SQLiteのpending全体とattemptStartedAt・lastFailure、旧storageへの書込呼出数、appraise呼出数、invalidationログ、storage交換後cursor、次回drain後のpending解消"
// observation_boundary = "component-behavior"
// scope = "Main Affect lifecycle factory・drain・settler・ownership coordinator・実SQLite settlement storage"
// lifecycle = "permanent"
// impact = "runtime再起動やDB交換により完了済みTurnのAffectが永久待機または誤適用になる"
// distinction = "settlerへ直接依存を注入するtestと異なり、Mainと同じdrainのattempt取得・例外処理・中断回収・cursor管理を通す。外部LLM/contextのみ制御し一時DBで短時間に検証する"
// @end-test-value
test("Main Affect drainは交換前の評価・owner読取結果と例外を破棄してcurrent pendingを回復する", { timeout: 10_000 }, async (t) => {
  for (const replacement of ["runtime", "storage"] as const) {
    for (const [pauseAt, failEvaluation] of [["evaluation", false], ["evaluation", true], ["metadata", false], ["metadata", true], ["identity", false], ["identity", true]] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), "withmate-main-affect-"));
      const dbPath = path.join(directory, "settlement.db");
      let storage = new CharacterAffectTurnSettlementStorage(dbPath);
      const entered = deferred();
      const release = deferred();
      try {
        const correlationId = `${replacement}-${pauseAt}-${failEvaluation}`;
        storage.enqueue({ correlationId, characterId: "character-a", sessionId: session.id,
          userMessage: "user", assistantMessage: "assistant", assistantMessageIndex: 1, occurredAt });
        storage.markReady(correlationId);
        let appraisals = 0;
        const runtime: CharacterAffectTurnLifecycleRuntime = {
          characterContextService: {
            getContext: async () => context,
            appraise: async () => {
              appraisals += 1;
              return { schemaVersion: "withmate-character-context-v1", characterId: "character-a",
                sessionId: session.id, saved: [], rejected: [], version: "v2", updatedAt: occurredAt };
            },
          },
        };
        let currentRuntime = runtime;
        let evaluations = 0;
        let paused = false;
        const pauseOnce = async (point: typeof pauseAt) => {
          if (pauseAt !== point || paused) return;
          paused = true;
          entered.resolve();
          await release.promise;
          if (failEvaluation) throw new Error("old operation failed");
        };
        const logs: AppLogInput[] = [];
        let cursor: CharacterAffectTurnDrainCursor | undefined;
        const ownership = new CharacterAffectTurnOwnershipCoordinator();
        const lifecycle = createCharacterAffectTurnMainLifecycle({
          getSettlementStorage: () => storage,
          getRuntimeApi: () => currentRuntime,
          getCharacterSnapshot: () => ({
            characterId: "character-a", name: "A", description: "", iconFilePath: "",
            theme: { main: "#6f8cff", sub: "#6fb8c7" }, definitionMarkdown: "Character A",
            definitionSha256: "fixture", definitionByteSize: 11, snapshotAt: occurredAt,
          }),
          getAppSettings: () => normalizeAppSettings({}),
          getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async <TOutput>(_input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> => {
            evaluations += 1;
            await pauseOnce("evaluation");
            return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
              layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
              valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
            }] } as TOutput };
          } }),
          getSessionMetadata: async () => { await pauseOnce("metadata"); return toMetadata(session); },
          getSessionMessageIdentity: async () => { await pauseOnce("identity"); return { role: "assistant", text: "assistant", historyIndex: 1 }; },
          startupRecoveryCutoff: occurredAt,
          runAppraisalExclusive: (operation) => ownership.runExclusive(operation),
          writeAppLog: (log) => { logs.push(log); },
          getDrainCursor: () => cursor,
          setDrainCursor: (next) => { cursor = next; },
        });
        const draining = lifecycle.drain();
        await entered.promise;
        assert.notEqual(storage.getPending(correlationId)?.attemptStartedAt, null);
        const replacementCursor = { createdAt: occurredAt, correlationId: "new-cursor" };
        let staleWriteCallCounts = () => [] as number[];
        if (replacement === "storage") {
          const writes = [
            t.mock.method(storage, "saveEvaluation"),
            t.mock.method(storage, "recordFailure"),
            t.mock.method(storage, "recordAppraisalFailure"),
            t.mock.method(storage, "markSettled"),
            t.mock.method(storage, "markDiscarded"),
            t.mock.method(storage, "recoverInterruptedAttempts"),
          ];
          staleWriteCallCounts = () => writes.map((write) => write.mock.callCount());
          storage.close();
          storage = new CharacterAffectTurnSettlementStorage(dbPath);
          cursor = replacementCursor;
        } else {
          currentRuntime = { characterContextService: runtime.characterContextService };
        }
        const pendingBeforeResume = storage.getPending(correlationId);
        release.resolve();
        assert.equal(await draining, true);
        assert.equal(appraisals, 0);
        assert.equal(logs.filter((log) => log.kind === "character-affect.lifecycle.settlement-invalidated").length, 1);
        assert.equal(logs.some((log) => log.kind === "character-affect.lifecycle.settlement-deferred"), false);
        if (replacement === "storage") {
          assert.deepEqual(staleWriteCallCounts(), [0, 0, 0, 0, 0, 0]);
          assert.deepEqual(storage.getPending(correlationId), pendingBeforeResume);
          assert.equal(cursor, replacementCursor);
        }
        const pending = storage.getPending(correlationId);
        assert.ok(pending);
        assert.equal(pending.evaluation, null);
        assert.equal(pending.attemptStartedAt, null);
        assert.equal(pending.lastFailure?.code, "attempt_interrupted");
        assert.equal(await lifecycle.drain(), false);
        assert.equal(storage.getPending(correlationId), null);
        assert.equal(evaluations, pauseAt === "evaluation" ? 2 : 1);
        assert.equal(appraisals, 1);
      } finally {
        release.resolve();
        storage.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同じID・Character・assistant本文のSessionが再作成されても、削除前のpendingと評価結果は適用せず、新Sessionのpendingだけを適用する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "drain受付時または評価await後のowner検証がIDと本文一致だけで旧incarnationの結果を新Sessionへ適用する"
// observable = "旧pendingの解消、評価回数、appraise回数、新Session行の不変、新incarnationのpending完了"
// observation_boundary = "component-behavior"
// scope = "Main Affect lifecycleと実V6 Session/settlement DBのdelete-recreate競合"
// lifecycle = "permanent"
// impact = "削除された会話の感情やMemoryが別の会話へ混入する"
// distinction = "単なる行不在の削除testでは検出できない同一ID再利用を、受付前と外部評価待機中に再現する"
// @end-test-value
test("Main Affect drainは同じIDで再作成されたSessionへ旧評価を適用しない", { timeout: 10_000 }, async () => {
  for (const recreateAt of ["before-drain", "during-evaluation"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-owner-"));
    const dbPath = path.join(directory, "app.db");
    const sessions = new SessionStorageV6(dbPath);
    const settlements = new CharacterAffectTurnSettlementStorage(dbPath);
    const entered = deferred();
    const release = deferred();
    try {
      const original = sessions.insertSession(session);
      const queue = (correlationId: string, owner: Session) => {
        settlements.enqueue({ correlationId, characterId: owner.characterId, sessionId: owner.id,
          sessionIncarnationId: owner.incarnationId, userMessage: "user", assistantMessage: "assistant",
          assistantMessageIndex: 1, occurredAt });
        settlements.markReady(correlationId);
      };
      queue("old-owner", original);
      let evaluations = 0;
      let appraisals = 0;
      const runtime: CharacterAffectTurnLifecycleRuntime = {
        characterContextService: {
          getContext: async () => context,
          appraise: async () => {
            appraisals += 1;
            return { schemaVersion: "withmate-character-context-v1", characterId: "character-a",
              sessionId: session.id, saved: [], rejected: [], version: "v2", updatedAt: occurredAt };
          },
        },
      };
      const ownership = new CharacterAffectTurnOwnershipCoordinator();
      const lifecycle = createCharacterAffectTurnMainLifecycle({
        getSettlementStorage: () => settlements,
        getRuntimeApi: () => runtime,
        getCharacterSnapshot: () => ({ characterId: "character-a", name: "A", description: "", iconFilePath: "",
          theme: { main: "#6f8cff", sub: "#6fb8c7" }, definitionMarkdown: "Character A",
          definitionSha256: "fixture", definitionByteSize: 11, snapshotAt: occurredAt }),
        getAppSettings: () => normalizeAppSettings({}),
        getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async <TOutput>(_input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> => {
          evaluations += 1;
          if (recreateAt === "during-evaluation" && evaluations === 1) {
            entered.resolve();
            await release.promise;
          }
          return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
            layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
            valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
          }] } as TOutput };
        } }),
        getSessionMetadata: async (id) => sessions.getSessionMetadata(id),
        getSessionMessageIdentity: async (input) => sessions.getSessionMessageIdentity(input),
        startupRecoveryCutoff: occurredAt,
        runAppraisalExclusive: (operation) => ownership.runExclusive(operation),
        writeAppLog: () => undefined,
        getDrainCursor: () => undefined,
        setDrainCursor: () => undefined,
      });
      const draining = recreateAt === "during-evaluation" ? lifecycle.drain() : null;
      if (draining) await entered.promise;
      sessions.deleteSession(original.id);
      const replacement = sessions.insertSession(session);
      assert.notEqual(replacement.incarnationId, original.incarnationId);
      release.resolve();
      await (draining ?? lifecycle.drain());
      assert.equal(settlements.getPending("old-owner"), null);
      assert.equal(evaluations, recreateAt === "during-evaluation" ? 1 : 0);
      assert.equal(appraisals, 0);
      assert.deepEqual(sessions.getSession(session.id), replacement);
      queue("new-owner", replacement);
      assert.equal(await lifecycle.drain(), false);
      assert.equal(settlements.getPending("new-owner"), null);
      assert.equal(appraisals, 1);
    } finally {
      release.resolve();
      settlements.close();
      sessions.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "評価保存後にAffect runtimeが交換されても、durableなevaluationを破棄せず、同じexpectedVersionとidempotency keyで次のdrainへ引き継ぐ"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "runtime交換後に保存済みevaluationを外部再評価して別candidateを作る、または交換前のappraise結果が不明なままpendingを失敗扱いにする"
// observable = "実SQLiteの保存済みevaluation全文、外部evaluation回数、appraiseへ渡ったruntime・expectedVersion・candidate全文、runtime交換後のpending解消"
// observation_boundary = "component-behavior"
// scope = "Main Affect lifecycle factory・settler・drain・ownership coordinator・実SQLite settlement storage"
// lifecycle = "permanent"
// impact = "runtime再起動時に評価済みのAffectが再評価で変質するか、未処理pendingとして永久に残る"
// distinction = "保存前のruntime交換だけを扱う既存testと異なり、appraisal排他callback実行前とappraise応答待ちの両方で、保存済み評価の再利用とpending完了を受入境界から確認する"
// @end-test-value
test("Main Affect drainはruntime交換後も保存済みevaluationを再利用して完了する", { timeout: 10_000 }, async () => {
  for (const { replacementPoint, oldAppraiseResult } of [
    { replacementPoint: "ownership" as const, oldAppraiseResult: null },
    { replacementPoint: "appraise" as const, oldAppraiseResult: "success" as const },
    { replacementPoint: "appraise" as const, oldAppraiseResult: "throw" as const },
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-main-affect-saved-"));
    const dbPath = path.join(directory, "settlement.db");
    const storage = new CharacterAffectTurnSettlementStorage(dbPath);
    const ownership = new CharacterAffectTurnOwnershipCoordinator();
    const entered = deferred();
    const release = deferred();
    let currentRuntime: CharacterAffectTurnLifecycleRuntime;
    let evaluations = 0;
    const appraiseCalls: Array<{ runtime: string; expectedVersion: string; candidates: unknown[] }> = [];
    try {
      const correlationId = `${replacementPoint}-${oldAppraiseResult}`;
      storage.enqueue({ correlationId, characterId: "character-a", sessionId: session.id,
        userMessage: "user", assistantMessage: "assistant", assistantMessageIndex: 1, occurredAt });
      storage.markReady(correlationId);
      const createRuntime = (runtime: "initial" | "replacement"): CharacterAffectTurnLifecycleRuntime => ({
        characterContextService: {
          getContext: async () => context,
          appraise: async (request: CharacterAffectAppraiseRequest) => {
            appraiseCalls.push({ runtime, expectedVersion: request.expectedVersion ?? "", candidates: structuredClone(request.candidates) });
            if (runtime === "initial" && replacementPoint === "appraise") {
              entered.resolve();
              await release.promise;
              if (oldAppraiseResult === "throw") throw new Error("appraise response became unknown");
            }
            return { schemaVersion: "withmate-character-context-v1", characterId: "character-a",
              sessionId: session.id, saved: [], rejected: [], version: "v2", updatedAt: occurredAt };
          },
        },
      });
      const initialRuntime = createRuntime("initial");
      const replacementRuntime = createRuntime("replacement");
      currentRuntime = initialRuntime;
      const logs: AppLogInput[] = [];
      const lifecycle = createCharacterAffectTurnMainLifecycle({
        getSettlementStorage: () => storage,
        getRuntimeApi: () => currentRuntime,
        getCharacterSnapshot: () => ({ characterId: "character-a", name: "A", description: "", iconFilePath: "",
          theme: { main: "#6f8cff", sub: "#6fb8c7" }, definitionMarkdown: "Character A",
          definitionSha256: "fixture", definitionByteSize: 11, snapshotAt: occurredAt }),
        getAppSettings: () => normalizeAppSettings({}),
        getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async <TOutput>(_input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> => {
          evaluations += 1;
          return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
            layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
            valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
          }] } as TOutput };
        } }),
        getSessionMetadata: async () => toMetadata(session),
          getSessionMessageIdentity: async () => ({ role: "assistant", text: "assistant", historyIndex: 1 }),
        startupRecoveryCutoff: occurredAt,
        runAppraisalExclusive: (operation) => ownership.runExclusive(async () => {
          if (replacementPoint === "ownership") {
            const pending = storage.getPending(correlationId);
            assert.ok(pending?.evaluation);
            entered.resolve();
            await release.promise;
          }
          return operation();
        }),
        writeAppLog: (log) => { logs.push(log); },
        getDrainCursor: () => undefined,
        setDrainCursor: () => undefined,
      });
      const draining = lifecycle.drain();
      await entered.promise;
      const pendingBeforeSwap = structuredClone(storage.getPending(correlationId));
      assert.ok(pendingBeforeSwap?.evaluation);
      if (replacementPoint === "appraise") {
        assert.deepEqual(appraiseCalls, [{ runtime: "initial", expectedVersion: "v1", candidates: pendingBeforeSwap.evaluation.candidates }]);
      }
      currentRuntime = replacementRuntime;
      release.resolve();
      assert.equal(await draining, true);
      assert.equal(logs.filter((log) => log.kind === "character-affect.lifecycle.settlement-invalidated").length, 1);
      const pendingAfterSwap = storage.getPending(correlationId);
      assert.ok(pendingAfterSwap?.evaluation);
      assert.deepEqual(pendingAfterSwap.evaluation, pendingBeforeSwap.evaluation);
      assert.equal(evaluations, 1);
      assert.equal(pendingAfterSwap.attemptStartedAt, null);
      assert.equal(await lifecycle.drain(), false);
      assert.equal(storage.getPending(correlationId), null);
      assert.equal(evaluations, 1);
      assert.equal(appraiseCalls.length, replacementPoint === "appraise" ? 2 : 1);
      const replacementCall = appraiseCalls.at(-1)!;
      assert.equal(replacementCall.runtime, "replacement");
      assert.equal(replacementCall.expectedVersion, pendingBeforeSwap.evaluation.expectedVersion);
      assert.deepEqual(replacementCall.candidates, pendingBeforeSwap.evaluation.candidates);
    } finally {
      release.resolve();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
