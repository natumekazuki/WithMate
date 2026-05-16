import assert from "node:assert/strict";
import test from "node:test";

import { buildChatEntrySearch, WindowEntryLoader } from "../../src-electron/window-entry-loader.js";

function createWindowStub() {
  const calls: Array<{ kind: "url" | "file"; value: string; search?: string }> = [];
  return {
    window: {
      async loadURL(url: string) {
        calls.push({ kind: "url", value: url });
      },
      async loadFile(filePath: string, options?: { search?: string }) {
        calls.push({ kind: "file", value: filePath, search: options?.search });
      },
    },
    calls,
  };
}

test("WindowEntryLoader は dev server 使用時に loadURL する", async () => {
  const stub = createWindowStub();
  const loader = new WindowEntryLoader({
    devServerUrl: "http://localhost:5173",
    rendererDistPath: "F:/dist",
  });

  await loader.loadHomeEntry(stub.window, "settings");
  await loader.loadChatEntry(stub.window, { kind: "agent", sessionId: "session 1" });
  await loader.loadCharacterEntry(stub.window, null);
  await loader.loadCharacterEntry(stub.window, "char-1");
  await loader.loadDiffEntry(stub.window, "diff#1");
  await loader.loadBootEntry(stub.window);
  await loader.loadChatEntry(stub.window, { kind: "companion", sessionId: "companion 1" });
  await loader.loadChatEntry(stub.window, { kind: "mate-talk" });
  await loader.loadCompanionMergeReviewEntry(stub.window, "companion 1");

  assert.deepEqual(stub.calls, [
    { kind: "url", value: "http://localhost:5173?mode=settings" },
    { kind: "url", value: "http://localhost:5173/session.html?sessionId=session%201" },
    { kind: "url", value: "http://localhost:5173/character.html?mode=create" },
    { kind: "url", value: "http://localhost:5173/character.html?characterId=char-1" },
    { kind: "url", value: "http://localhost:5173/diff.html?token=diff%231" },
    { kind: "url", value: "http://localhost:5173/boot.html" },
    { kind: "url", value: "http://localhost:5173/session.html?companionSessionId=companion%201&mode=companion" },
    { kind: "url", value: "http://localhost:5173/session.html?mode=mate-talk" },
    { kind: "url", value: "http://localhost:5173/review.html?companionSessionId=companion%201&view=merge" },
  ]);
});

test("buildChatEntrySearch は chat mode ごとの session.html query を組み立てる", () => {
  assert.equal(buildChatEntrySearch({ kind: "agent", sessionId: "session 1" }), "?sessionId=session%201");
  assert.equal(
    buildChatEntrySearch({ kind: "companion", sessionId: "companion 1" }),
    "?companionSessionId=companion%201&mode=companion",
  );
  assert.equal(buildChatEntrySearch({ kind: "mate-talk" }), "?mode=mate-talk");
  assert.equal(
    buildChatEntrySearch({ kind: "mate-talk", launch: { provider: "copilot", model: "claude-sonnet-4.5", reasoningEffort: "medium" } }),
    "?mode=mate-talk&provider=copilot&model=claude-sonnet-4.5&reasoningEffort=medium",
  );
});

test("WindowEntryLoader は production build で loadFile する", async () => {
  const stub = createWindowStub();
  const loader = new WindowEntryLoader({
    devServerUrl: "",
    rendererDistPath: "F:/dist",
  });

  await loader.loadHomeEntry(stub.window);
  await loader.loadCharacterEntry(stub.window, "char-1");
  await loader.loadHomeEntry(stub.window, "settings");
  await loader.loadBootEntry(stub.window);
  await loader.loadChatEntry(stub.window, { kind: "companion", sessionId: "companion 1" });
  await loader.loadChatEntry(stub.window, { kind: "mate-talk" });
  await loader.loadCompanionMergeReviewEntry(stub.window, "companion 1");

  assert.deepEqual(stub.calls, [
    { kind: "file", value: "F:\\dist\\index.html", search: undefined },
    { kind: "file", value: "F:\\dist\\character.html", search: "?characterId=char-1" },
    { kind: "file", value: "F:\\dist\\index.html", search: "?mode=settings" },
    { kind: "file", value: "F:\\dist\\boot.html", search: undefined },
    {
      kind: "file",
      value: "F:\\dist\\session.html",
      search: "?companionSessionId=companion%201&mode=companion",
    },
    {
      kind: "file",
      value: "F:\\dist\\session.html",
      search: "?mode=mate-talk",
    },
    {
      kind: "file",
      value: "F:\\dist\\review.html",
      search: "?companionSessionId=companion%201&view=merge",
    },
  ]);
});
