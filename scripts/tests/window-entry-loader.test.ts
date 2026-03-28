import assert from "node:assert/strict";
import test from "node:test";

import { WindowEntryLoader } from "../../src-electron/window-entry-loader.js";

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
  await loader.loadSessionEntry(stub.window, "session 1");
  await loader.loadCharacterEntry(stub.window, null);
  await loader.loadDiffEntry(stub.window, "diff#1");

  assert.deepEqual(stub.calls, [
    { kind: "url", value: "http://localhost:5173?mode=settings" },
    { kind: "url", value: "http://localhost:5173/session.html?sessionId=session%201" },
    { kind: "url", value: "http://localhost:5173/character.html?mode=create" },
    { kind: "url", value: "http://localhost:5173/diff.html?token=diff%231" },
  ]);
});

test("WindowEntryLoader は production build で loadFile する", async () => {
  const stub = createWindowStub();
  const loader = new WindowEntryLoader({
    devServerUrl: "",
    rendererDistPath: "F:/dist",
  });

  await loader.loadHomeEntry(stub.window);
  await loader.loadCharacterEntry(stub.window, "char-1");

  assert.deepEqual(stub.calls, [
    { kind: "file", value: "F:\\dist\\index.html", search: undefined },
    { kind: "file", value: "F:\\dist\\character.html", search: "characterId=char-1" },
  ]);
});
