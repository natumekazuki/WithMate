import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { CharacterContextResponse } from "../../src/character-context/character-context-contract.js";
import type { AppLogInput } from "../../src/app-log-types.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character-affect-turn-ownership-coordinator.js";
import { createCharacterAffectTurnMainLifecycle, type CharacterAffectTurnLifecycleRuntime } from "../../src-electron/character-affect-turn-main-lifecycle.js";
import type { CharacterAffectTurnDrainCursor } from "../../src-electron/character-affect-turn-drain.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

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
  schemaVersion: "withmate-character-context-v1", characterId: "character-a", sessionId: session.id,
  baseline: { definitionSha256: "fixture", snapshotAt: occurredAt },
  affect: { mode: "active", effective: [], evaluatedAt: occurredAt, version: "v1", updatedAt: null },
  memory: { items: [], updatedAt: null },
  scope: { userId: "local-user", characterId: "character-a", sessionId: session.id },
};

// @test-value v2
// kind = "invariant"
// claim = "Mainが使用するdrainは評価待機中のruntime/storage交換後、評価成功・例外のどちらでも旧試行を適用せず、現行storageで次回drainを完了できる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "失効した評価の保存・failure記録が旧storageへ到達する、storage交換後のcursorを旧drainが上書きする、またはcurrent pendingが試行中のまま回復できない"
// observable = "実SQLiteのpending全体とattemptStartedAt・lastFailure、旧storageへの書込呼出数、appraise呼出数、invalidationログ、storage交換後cursor、次回drain後のpending解消"
// observation_boundary = "component-behavior"
// scope = "Main Affect lifecycle factory・drain・settler・ownership coordinator・実SQLite settlement storage"
// lifecycle = "permanent"
// impact = "runtime再起動やDB交換により完了済みTurnのAffectが永久待機または誤適用になる"
// distinction = "settlerへ直接依存を注入するtestと異なり、Mainと同じdrainのattempt取得・例外処理・中断回収・cursor管理を通す。外部LLM/contextのみ制御し一時DBで短時間に検証する"
// @end-test-value
test("Main Affect drainは交換前の評価結果と例外を破棄してcurrent pendingを回復する", { timeout: 10_000 }, async (t) => {
  for (const replacement of ["runtime", "storage"] as const) {
    for (const failEvaluation of [false, true]) {
      const directory = await mkdtemp(path.join(tmpdir(), "withmate-main-affect-"));
      const dbPath = path.join(directory, "settlement.db");
      let storage = new CharacterAffectTurnSettlementStorage(dbPath);
      const entered = deferred();
      const release = deferred();
      try {
        const correlationId = `${replacement}-${failEvaluation}`;
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
          getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async () => {
            evaluations += 1;
            if (evaluations === 1) {
              entered.resolve();
              await release.promise;
              if (failEvaluation) throw new Error("old evaluator failed");
            }
            return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
              layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
              valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
            }] } };
          } }),
          getSession: async () => session,
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
        assert.equal(evaluations, 2);
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
        getProviderBackgroundAdapter: () => ({ runBackgroundStructuredPrompt: async () => {
          evaluations += 1;
          if (recreateAt === "during-evaluation" && evaluations === 1) {
            entered.resolve();
            await release.promise;
          }
          return { threadId: null, rawText: "", rawItemsJson: "[]", usage: null, output: { candidates: [{
            layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest",
            valence: 0.4, arousal: null, intensity: 0.5, reason: "test", evidence: "test",
          }] } };
        } }),
        getSession: async (id) => sessions.getSession(id),
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
