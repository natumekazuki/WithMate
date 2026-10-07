import assert from "node:assert/strict";
import test from "node:test";
import type { SessionTurnInput } from "../../src-shared/session/session-turn-state.js";
import { SessionTurnService } from "../../src-electron/session/session-turn-service.js";

const input: SessionTurnInput = {
  sessionId: "session-1", createdAt: "2026-10-07T00:00:00.000Z", phase: "running",
  provider: "codex", model: "model", reasoningEffort: "medium", approvalMode: "on-request",
  userMessageSeq: 0, threadId: "thread", errorMessage: "",
};

// @test-value v2
// kind = "contract"
// claim = "turn作成と更新は永続化完了後の正本を返し、通知時にも同じ正本を渡す"
// oracle = { type = "contract", ref = "src-electron/session/session-turn-service.ts SessionTurnService" }
// fault = "storage write完了前に通知するか、作成と更新で別turnのIDを渡す"
// observable = "保存完了前後の通知とcreate/updateの返却turn"
// observation_boundary = "public-boundary"
// scope = "session turn persistence notification"
// lifecycle = "permanent"
// @end-test-value
test("SessionTurnServiceは保存後に作成と更新を通知する", async () => {
  let resolveCreate!: (turn: typeof input & { id: number }) => void;
  const persisted = { ...input, id: 7 };
  const notifications: unknown[] = [];
  const service = new SessionTurnService({
    createSessionTurn: () => new Promise((resolve) => { resolveCreate = resolve; }),
    updateSessionTurn: (id, next) => ({ ...next, id }),
  }, (turn) => notifications.push(turn));
  const creating = service.createSessionTurn(input);
  assert.deepEqual(notifications, []);
  resolveCreate(persisted);
  assert.equal(await creating, persisted);
  const updated = await service.updateSessionTurn(7, { ...input, phase: "canceled", errorMessage: "canceled" });
  assert.deepEqual(notifications, [persisted, updated]);
  assert.equal(updated.id, 7);
  assert.equal(updated.phase, "canceled");
});

// @test-value v2
// kind = "contract"
// claim = "turn保存失敗は元のerrorを伝播し成功通知を発行しない"
// oracle = { type = "contract", ref = "AGENTS.md 失敗を成功に見せる救済を作らない" }
// fault = "保存失敗を正常結果へ変換してRendererへ成功を通知する"
// observable = "create/updateのreject errorの同一性と通知件数"
// observation_boundary = "public-boundary"
// scope = "session turn persistence failure"
// lifecycle = "permanent"
// @end-test-value
test("SessionTurnServiceは保存失敗を補完しない", async () => {
  const failure = new Error("unknown persistence outcome");
  let notifications = 0;
  const service = new SessionTurnService({
    createSessionTurn: async () => { throw failure; },
    updateSessionTurn: async () => { throw failure; },
  }, () => { notifications += 1; });
  await assert.rejects(service.createSessionTurn(input), (error) => error === failure);
  await assert.rejects(service.updateSessionTurn(7, input), (error) => error === failure);
  assert.equal(notifications, 0);
});
