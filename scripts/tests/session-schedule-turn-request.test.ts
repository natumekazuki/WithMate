import assert from "node:assert/strict";
import test from "node:test";

import { buildScheduledTurnRequest } from "../../src-electron/session-schedule-turn-request.js";
import type { SessionScheduleTurn } from "../../src/session-schedule.js";

function turn(): SessionScheduleTurn {
  return {
    provider: "codex",
    userMessage: "review",
    model: "gpt",
    reasoningEffort: "high",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    attachments: [
      { path: "C:/allowed/evidence.txt", source: "text", kind: "file" },
      { path: "C:/allowed/screenshot.png", source: "markdown-image", kind: "image" },
    ],
  };
}

test("scheduled turn inserts saved attachment references for ordinary composer validation", () => {
  const request = buildScheduledTurnRequest(turn(), "fire-key");
  assert.match(request.userMessage, /@C:\/allowed\/evidence\.txt/);
  assert.match(request.userMessage, /!\[screenshot\.png\]\(C:\/allowed\/screenshot\.png\)/);
  assert.equal(request.clientRequestId, "fire-key");
  assert.equal(request.attachments, undefined);
});

test("scheduled turn does not duplicate an attachment already referenced by the prompt", () => {
  const scheduledTurn = turn();
  scheduledTurn.userMessage = 'review @"C:/allowed/evidence.txt"';
  scheduledTurn.attachments = scheduledTurn.attachments?.slice(0, 1);
  const request = buildScheduledTurnRequest(scheduledTurn, "fire-key");
  assert.equal(request.userMessage.match(/evidence\.txt/g)?.length, 1);
});
