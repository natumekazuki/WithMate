import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { CodexProjectionOwner } from "../../src-electron/providers/codex/codex-projection-owner.js";
import { CopilotOutputProjection } from "../../src-electron/providers/copilot/copilot-output.js";
import { OpenCodeTurnProjection } from "../../src-electron/providers/opencode/opencode-events.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "Providerの親出力はnative identityで増分を置換し、phase・本文確定・最終回答と実行終端を独立に保持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836" }
// fault = "commentaryや子本文をfinalへ混ぜる、同一本文の別messageを重複として落とす、確定通知を増分へ連結する、またはstep終了を実行成功として最終回答にする"
// observable = "実adapterが使う3 Provider投影の本文・出力identity/順序/range・phase・completion/finalityとMessage正規化後の範囲"
// observation_boundary = "component-behavior"
// scope = "Codex/Copilot/OpenCode common provider output projection"
// lifecycle = "permanent"
// impact = "取得した出力の欠落・二重化と途中経過を確定回答として回収する誤認を防ぐ"
// distinction = "stream表示・artifactの既存testは保存用共通出力単位と最終回答根拠を観測しない"
// @end-test-value
test("provider boundaries preserve identity, unknown phases and independent text finality", () => {
  const codex = new CodexProjectionOwner({ sessionId: "session", threadId: "thread", turnId: "native", apiKey: "", progress: false });
  const send = (method: string, item: object) => codex.apply({ method, params: { threadId: "thread", turnId: "native", item } });
  send("item/completed", { type: "agentMessage", id: "progress", text: "working", phase: "commentary" });
  send("item/completed", { type: "agentMessage", id: "partial-phase", text: "in progress answer", phase: "partial_answer" });
  send("item/started", { type: "agentMessage", id: "answer", text: "draft", phase: "final_answer" });
  send("item/completed", { type: "agentMessage", id: "answer", text: "answer", phase: "final_answer" });
  send("item/completed", { type: "agentMessage", id: "unknown", text: "other", phase: "future_phase" });
  codex.apply({ method: "turn/completed", params: { threadId: "thread", turn: { id: "native", status: "failed", error: { message: "after output" } } } });
  const native = codex.finish([]);
  assert.equal(native.terminalStatus, "failed");
  assert.deepEqual(native.output.units.map((unit) => [unit.id, unit.role, unit.completion, unit.final]), [["progress", "progress", "complete", false], ["partial-phase", "answer", "complete", false], ["answer", "answer", "complete", true], ["unknown", "unclassified", "complete", false]]);
  assert.equal(native.output.finality, "identified");
  assert.equal(native.output.units.filter((unit) => unit.final).map((unit) => native.assistantText.slice(unit.start, unit.end)).join(), "answer");

  const copilot = new CopilotOutputProjection();
  const emit = (id: string, type: string, data: object) => copilot.apply({ id, type, data } as SessionEvent);
  emit("start", "assistant.message_start", { messageId: "a", phase: "response" });
  emit("delta", "assistant.message_delta", { messageId: "a", deltaContent: "draft" });
  emit("delta", "assistant.message_delta", { messageId: "a", deltaContent: "draft" });
  emit("done", "assistant.message", { messageId: "a", content: "same", phase: "response" });
  emit("done2", "assistant.message", { messageId: "b", content: "same" });
  emit("draft2", "assistant.message_delta", { messageId: "c", deltaContent: "partial" });
  emit("tool-child", "assistant.message", { messageId: "tool-child", content: "child text", parentToolCallId: "tool" });
  copilot.apply({ id: "agent-child", type: "assistant.message", agentId: "child", data: { messageId: "agent-child", content: "child text" } } as SessionEvent);
  assert.equal(copilot.lastNonEmptyText, "partial");
  const projected = copilot.project();
  assert.equal(projected.assistantText, "same\n\nsame\n\npartial");
  assert.deepEqual(projected.output.units.map((unit) => [unit.messageId, unit.phase, unit.completion, unit.final]), [["a", "response", "complete", false], ["b", null, "complete", false], ["c", null, "partial", false]]);
  assert.equal(projected.output.finality, "unknown");
  emit("answer1", "assistant.message", { messageId: "d", content: "chunk one", originatingMessageId: "request", turnId: "native-final" });
  emit("answer2", "assistant.message", { messageId: "e", content: "chunk two", originatingMessageId: "request", turnId: "native-final" });
  copilot.completeRequest("request");
  assert.deepEqual(copilot.project().output.units.filter((unit) => unit.final).map((unit) => unit.id), ["d", "e"]);

  const opencode = new OpenCodeTurnProjection("root");
  opencode.apply({ id: "text", type: "session.text.ended", data: { sessionID: "root", assistantMessageID: "one", ordinal: 0, text: "part one" } } as OpenCodeEvent);
  assert.equal(opencode.output().output.finality, "unknown");
  opencode.replaceMessages([
    { id: "one", type: "assistant", time: { created: 0, completed: 1 }, finish: "length", content: [{ type: "text", text: "part one" }] },
    { id: "two", type: "assistant", time: { created: 1, completed: 2 }, finish: "stop", content: [{ type: "text", text: "part two" }, { type: "text", text: "tail" }] },
  ] as SessionMessageInfo[]);
  const output = opencode.output();
  assert.equal(output.assistantText, "part one\n\npart two\n\ntail");
  assert.deepEqual(output.output.units.map((unit) => unit.id), ["one:0", "two:0", "two:1"]);
  assert.equal(output.output.finality, "identified");
  assert.deepEqual(output.output.units.filter((unit) => unit.final).map((unit) => unit.id), ["one:0", "two:0", "two:1"]);
  assert.deepEqual(normalizeMessage({ role: "assistant", text: output.assistantText, output: output.output })?.output, output.output);
});
