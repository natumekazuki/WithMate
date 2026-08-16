import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSessionExecutionTurnRequest,
  validateSessionExecutionTurnRequest,
} from "../../src-electron/session-execution-turn-request.js";

test("EXT-ATTACH-10: validation後もdispatch envelopeとattachment identityを保持する", async () => {
  const validated = await validateSessionExecutionTurnRequest(
    "session-1",
    {
      catalogRevision: 7,
      turn: {
        provider: "copilot",
        userMessage: "inspect brief",
        model: "gpt-5.3-codex",
        attachments: [{ kind: "file", relativePath: "brief.md" }],
      },
    },
    async (_sessionId, catalogRevision, turn, providerId) => {
      assert.equal(catalogRevision, 7);
      assert.equal(providerId, "copilot");
      return {
        ...turn,
        attachments: [{
          kind: "file",
          relativePath: "brief.md",
          identity: {
            device: 11,
            inode: 22,
            canonicalRelativePath: "brief.md",
          },
        }],
      };
    },
  );

  const reparsed = parseSessionExecutionTurnRequest(validated);
  assert.equal(reparsed.source, "external");
  if (reparsed.source !== "external") throw new Error("external request expected");
  assert.equal(reparsed.catalogRevision, 7);
  assert.equal(reparsed.providerId, "copilot");
  assert.equal(reparsed.turn.attachments?.[0]?.identity?.canonicalRelativePath, "brief.md");
});

test("GUI queue requestはclient request IDを含む通常Session Turnとしてvalidation後も保持する", async () => {
  let guiValidationCount = 0;
  const validated = await validateSessionExecutionTurnRequest(
    "session-1",
    {
      source: "gui",
      turn: {
        userMessage: "次の依頼",
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        model: "gpt-5.6",
        reasoningEffort: "high",
        approvalMode: "untrusted",
        codexSandboxMode: "workspace-write",
      },
    },
    async () => {
      throw new Error("external validator must not be called");
    },
    async (sessionId, turn) => {
      guiValidationCount += 1;
      assert.equal(sessionId, "session-1");
      assert.equal(turn.userMessage, "次の依頼");
    },
  );

  const reparsed = parseSessionExecutionTurnRequest(validated);
  assert.equal(reparsed.source, "gui");
  assert.equal(reparsed.catalogRevision, null);
  assert.equal(reparsed.turn.clientRequestId, "11111111-1111-4111-8111-111111111111");
  assert.equal(guiValidationCount, 1);
});
