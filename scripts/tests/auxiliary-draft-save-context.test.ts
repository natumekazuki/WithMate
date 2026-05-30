import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { areStringArraysEqual, hasSameAuxiliaryDraftSaveContext } from "../../src/auxiliary-draft-save-context.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "copilot",
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write-network",
    customAgentName: "",
    allowedAdditionalDirectories: ["C:/shared"],
    threadId: "thread-1",
    composerDraft: "draft",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

describe("areStringArraysEqual", () => {
  it("同順同長なら true", () => {
    assert.equal(areStringArraysEqual(["a", "b"], ["a", "b"]), true);
  });

  it("配列順が違えば false", () => {
    assert.equal(areStringArraysEqual(["a", "b"], ["b", "a"]), false);
  });

  it("長さが違えば false", () => {
    assert.equal(areStringArraysEqual(["a"], ["a", "a"]), false);
  });
});

describe("hasSameAuxiliaryDraftSaveContext", () => {
  it("共通比較フィールドが同一なら true", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession();

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request), true);
  });

  it("App 側は status を無視して比較できる", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession({ status: "closed" });

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request), true);
    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request, { compareStatus: false }), true);
  });

  it("CompanionReview 側は status を比較するので status 差異で false", () => {
    const base = makeAuxiliarySession();
    const request = makeAuxiliarySession({ status: "closed" });

    assert.equal(hasSameAuxiliaryDraftSaveContext(base, request, { compareStatus: true }), false);
  });
});
