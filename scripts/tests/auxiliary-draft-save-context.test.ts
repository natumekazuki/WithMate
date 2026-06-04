import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areStringArraysEqual,
  hasSameAuxiliaryDraftSaveContext,
  resolveAuxiliaryDraftSaveResult,
  runAuxiliaryDraftSaveOperation,
} from "../../src/auxiliary-draft-save-context.js";
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

describe("resolveAuxiliaryDraftSaveResult", () => {
  it("保存 context が一致すると saved を返す", () => {
    const current = makeAuxiliarySession({ composerDraft: "draft" });
    const request = makeAuxiliarySession({ composerDraft: "draft" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved), saved);
  });

  it("current がない場合は null を返す", () => {
    const request = makeAuxiliarySession();
    const saved = makeAuxiliarySession({ updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(null, request, saved), null);
  });

  it("保存 context が変わった場合は current を維持する", () => {
    const current = makeAuxiliarySession({ composerDraft: "newer" });
    const request = makeAuxiliarySession({ composerDraft: "older" });
    const saved = makeAuxiliarySession({ composerDraft: "older", updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved), current);
  });

  it("compareStatus が true の場合は status 差異で current を維持する", () => {
    const current = makeAuxiliarySession({ status: "closed" });
    const request = makeAuxiliarySession({ status: "active" });
    const saved = makeAuxiliarySession({ status: "active", updatedAt: "saved" });

    assert.equal(resolveAuxiliaryDraftSaveResult(current, request, saved, { compareStatus: true }), current);
  });
});

describe("runAuxiliaryDraftSaveOperation", () => {
  it("保存 request を作って save 結果を返す", async () => {
    const current = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "current" });
    const saved = makeAuxiliarySession({ composerDraft: "draft", updatedAt: "saved" });
    const requests: AuxiliarySession[] = [];

    assert.deepEqual(
      await runAuxiliaryDraftSaveOperation({
        currentSession: current,
        targetSessionId: current.id,
        draft: "draft",
        updatedAt: "request",
        saveAuxiliarySession: async (request) => {
          requests.push(request);
          return saved;
        },
      }),
      {
        request: {
          ...current,
          updatedAt: "request",
        },
        saved,
      },
    );
    assert.deepEqual(requests, [{
      ...current,
      updatedAt: "request",
    }]);
  });

  it("保存 request を作れない場合は save しない", async () => {
    let saved = false;

    assert.equal(
      await runAuxiliaryDraftSaveOperation({
        currentSession: makeAuxiliarySession({ composerDraft: "newer" }),
        targetSessionId: "aux-1",
        draft: "older",
        updatedAt: "request",
        saveAuxiliarySession: async (request) => {
          saved = true;
          return request;
        },
      }),
      null,
    );
    assert.equal(saved, false);
  });

  it("save が失敗した場合は例外を伝播する", async () => {
    const error = new Error("save failed");

    await assert.rejects(
      runAuxiliaryDraftSaveOperation({
        currentSession: makeAuxiliarySession({ composerDraft: "draft" }),
        targetSessionId: "aux-1",
        draft: "draft",
        updatedAt: "request",
        saveAuxiliarySession: async () => {
          throw error;
        },
      }),
      error,
    );
  });
});
