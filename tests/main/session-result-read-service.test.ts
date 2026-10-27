import assert from "node:assert/strict";
import test from "node:test";
import { SessionResultReadService } from "../../src-electron/session/session-result-read-service.js";
import type { SessionTurnTerminalCommit } from "../../src-electron/session/session-turn-terminal-commit.js";

function commit(sessionId: string, turnId: number, phase: SessionTurnTerminalCommit["phase"] = "completed"): SessionTurnTerminalCommit {
  return { sessionId, turnId, phase, assistantMessageSeq: turnId * 2, threadId: "", errorMessage: "", completedAt: "2026-10-26T00:00:00Z" };
}

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの終了結果は会話ごとに未読となり、最新turnの既読要求だけを受理し、重複した終了結果で既読を戻さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "Main閲覧でAuxも既読になる、古い要求で新結果を消す、または同じ結果の再通知で未読に戻す"
// observable = "公開APIの未読結果、既読要求の受理値、変更通知の会話ID"
// observation_boundary = "public-boundary"
// scope = "起動中の結果既読状態"
// lifecycle = "permanent"
// impact = "Monitorで未確認結果を見落とす、または確認済みを再確認させる"
// distinction = "UIや型検査では検出できない会話間の独立性とturn識別の競合を確認する"
// @end-test-value
test("最新結果の既読はMain/Auxで独立し、古い要求と重複commitを無視する", () => {
  const changes: string[] = [];
  const service = new SessionResultReadService((id) => changes.push(id));
  service.recordResult(commit("main", 1));
  service.recordResult(commit("aux", 2, "failed"));
  assert.deepEqual(service.getUnreadResult("main"), { turnId: 1, assistantMessageSeq: 2 });
  assert.equal(service.markRead("main", 1), true);
  assert.equal(service.getUnreadResult("main"), null);
  assert.equal(service.getUnreadResult("aux")?.turnId, 2);
  service.recordResult(commit("main", 1));
  assert.equal(service.getUnreadResult("main"), null);
  service.recordResult(commit("main", 3, "canceled"));
  assert.equal(service.markRead("main", 1), false);
  assert.equal(service.markRead("aux", 3), false);
  service.recordResult(commit("main", 1));
  assert.equal(service.getUnreadResult("main")?.turnId, 3);
  assert.equal(service.markRead("main", 3), true);
  assert.equal(service.markRead("main", 3), false);
  assert.deepEqual(changes, ["main", "aux", "main", "main", "main"]);
});

// @test-value v2
// kind = "contract"
// claim = "既読状態は起動中だけ保持し、再生成またはresetで過去結果を未読へ復元しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "resetで未読が残る、または再生成時に過去結果を未読へ戻す"
// observable = "新instance/reset後の公開未読結果と、新規結果の受付"
// observation_boundary = "public-boundary"
// scope = "結果既読状態の寿命"
// lifecycle = "permanent"
// impact = "再起動後に未確認扱いの古い結果が大量に復活する"
// distinction = "保存型の有無だけでは確認できないruntimeのreset動作を確認する"
// @end-test-value
test("起動またはresetで未読を持ち越さず、新規結果から再開する", () => {
  const service = new SessionResultReadService(() => {});
  service.recordResult(commit("main", 10));
  service.clear();
  assert.equal(service.getUnreadResult("main"), null);
  assert.equal(service.markRead("main", 10), false);
  assert.equal(new SessionResultReadService(() => {}).getUnreadResult("main"), null);
  service.recordResult(commit("main", 1));
  assert.equal(service.getUnreadResult("main")?.turnId, 1);
});
