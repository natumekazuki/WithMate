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
  assert.equal(reparsed.catalogRevision, 7);
  assert.equal(reparsed.providerId, "copilot");
  assert.equal(reparsed.turn.attachments?.[0]?.identity?.canonicalRelativePath, "brief.md");
});
