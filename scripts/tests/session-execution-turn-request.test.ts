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
      initiator: {
        kind: "session",
        sessionId: "session-actor",
        character: {
          characterId: "character-actor",
          name: "Actor",
          iconFilePath: "C:/characters/actor.png",
        },
      },
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
  assert.equal(reparsed.initiator?.kind, "session");
  assert.equal(reparsed.catalogRevision, 7);
  assert.equal(reparsed.providerId, "copilot");
  assert.equal(reparsed.turn.attachments?.[0]?.identity?.canonicalRelativePath, "brief.md");
});

test("GUI queue requestはclient request IDを含む通常Session Turnとしてvalidation後も保持する", async () => {
  let guiValidationCount = 0;
  const validated = await validateSessionExecutionTurnRequest(
    "session-1",
    {
      initiator: { kind: "user" },
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
  assert.deepEqual(reparsed.initiator, { kind: "user" });
  assert.equal(reparsed.catalogRevision, null);
  assert.equal(reparsed.turn.clientRequestId, "11111111-1111-4111-8111-111111111111");
  assert.equal(guiValidationCount, 1);
});

test("initiatorなしの旧external requestだけをlegacyとして読み込む", () => {
  const legacy = parseSessionExecutionTurnRequest({
    catalogRevision: 3,
    turn: {
      provider: "codex",
      userMessage: "legacy request",
    },
  });
  assert.equal(legacy.initiator, null);
  assert.equal(legacy.catalogRevision, 3);

  const legacyGui = parseSessionExecutionTurnRequest({
    source: "gui",
    turn: { userMessage: "legacy GUI request" },
  });
  assert.deepEqual(legacyGui.initiator, { kind: "user" });
  assert.equal(legacyGui.catalogRevision, null);
});

test("Session initiatorは完全なidentity tupleだけを受け付ける", () => {
  assert.throws(() => parseSessionExecutionTurnRequest({
    initiator: {
      kind: "session",
      sessionId: "session-actor",
      character: { characterId: "character-actor", name: "Actor" },
    },
    catalogRevision: 3,
    turn: { provider: "codex", userMessage: "invalid" },
  }), /icon path/i);
});

test("TN-SNAPSHOT-02: terminal通知targetとsource Session snapshotをtupleで保存しlegacyへ推測しない", async () => {
  const sourceSession = {
    kind: "session" as const,
    sessionId: "source-session",
    character: {
      characterId: "source-character",
      name: "Source Character",
      iconFilePath: "C:/characters/source.png",
    },
  };
  const validated = await validateSessionExecutionTurnRequest(
    "source-session",
    {
      initiator: {
        kind: "session",
        sessionId: "actor-session",
        character: { characterId: "actor", name: "Actor", iconFilePath: "C:/actor.png" },
      },
      catalogRevision: 9,
      terminalFailureNotification: {
        contractVersion: 1,
        targetSessionId: "target-session",
        sourceSession,
      },
      turn: { provider: "codex", userMessage: "work" },
    },
    async (_sessionId, _revision, turn) => turn,
  );

  assert.deepEqual(parseSessionExecutionTurnRequest(validated).terminalFailureNotification, {
    contractVersion: 1,
    targetSessionId: "target-session",
    sourceSession,
  });
  assert.equal(parseSessionExecutionTurnRequest({
    catalogRevision: 1,
    turn: { provider: "codex", userMessage: "legacy" },
  }).terminalFailureNotification, null);
  assert.throws(() => parseSessionExecutionTurnRequest({
    catalogRevision: 1,
    terminalFailureNotification: {
      contractVersion: 1,
      targetSessionId: "target-session",
      sourceSession: { kind: "session", sessionId: "source-session", character: { name: "missing tuple" } },
    },
    turn: { provider: "codex", userMessage: "invalid" },
  }), /character ID/i);
});
