import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPastedClipboardFiles,
  collectPastedSessionAttachmentPaths,
  type PastedClipboardFile,
  type PastedClipboardFileItem,
} from "../../src/chat/composer-paste-handlers.js";

function createPastedFile(name: string, content: string): PastedClipboardFile {
  return {
    name,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  };
}

test("collectPastedClipboardFiles は clipboard files を items より優先する", () => {
  const file = createPastedFile("from-files.png", "files");
  const itemFile = createPastedFile("from-items.png", "items");
  const item: PastedClipboardFileItem = {
    kind: "file",
    getAsFile: () => itemFile,
  };

  assert.deepEqual(collectPastedClipboardFiles({ files: [file], items: [item] }), [file]);
});

test("collectPastedClipboardFiles は files が空なら file item から取り出す", () => {
  const itemFile = createPastedFile("from-items.png", "items");
  const fileItem: PastedClipboardFileItem = {
    kind: "file",
    getAsFile: () => itemFile,
  };
  const textItem: PastedClipboardFileItem = {
    kind: "string",
    getAsFile: () => createPastedFile("ignored.txt", "ignored"),
  };
  const nullFileItem: PastedClipboardFileItem = {
    kind: "file",
    getAsFile: () => null,
  };

  assert.deepEqual(collectPastedClipboardFiles({
    files: [],
    items: [textItem, nullFileItem, fileItem],
  }), [itemFile]);
});

test("collectPastedSessionAttachmentPaths は pasted files を保存して path を返す", async () => {
  const saved: Array<{ sessionId: string; fileName: string; dataText: string }> = [];
  let prevented = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: {
      files: [
        createPastedFile(" pasted.png ", "named"),
        createPastedFile("", "fallback"),
      ],
      items: [],
    },
    currentTimestampLabel: () => "2026-06-05T12:34:56.000Z",
    preventDefault: () => {
      prevented = true;
    },
    savePastedSessionFile: async ({ sessionId, fileName, data }) => {
      saved.push({
        sessionId,
        fileName,
        dataText: new TextDecoder().decode(data),
      });
      return `session-files/${fileName}`;
    },
    sessionId: "session-1",
  });

  assert.equal(prevented, true);
  assert.deepEqual(saved, [
    { sessionId: "session-1", fileName: "pasted.png", dataText: "named" },
    { sessionId: "session-1", fileName: "pasted-2026-06-05T12-34-56.000Z.png", dataText: "fallback" },
  ]);
  assert.deepEqual(savedPaths, [
    "session-files/pasted.png",
    "session-files/pasted-2026-06-05T12-34-56.000Z.png",
  ]);
});

test("collectPastedSessionAttachmentPaths は files が空なら item file を保存する", async () => {
  const itemFile = createPastedFile("from-items.png", "items");
  const fileItem: PastedClipboardFileItem = {
    kind: "file",
    getAsFile: () => itemFile,
  };
  const saved: Array<{ sessionId: string; fileName: string; dataText: string }> = [];
  let prevented = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: {
      files: [],
      items: [fileItem],
    },
    currentTimestampLabel: () => "unused",
    preventDefault: () => {
      prevented = true;
    },
    savePastedSessionFile: async ({ sessionId, fileName, data }) => {
      saved.push({
        sessionId,
        fileName,
        dataText: new TextDecoder().decode(data),
      });
      return `session-files/${fileName}`;
    },
    sessionId: "session-2",
  });

  assert.equal(prevented, true);
  assert.deepEqual(saved, [
    { sessionId: "session-2", fileName: "from-items.png", dataText: "items" },
  ]);
  assert.deepEqual(savedPaths, ["session-files/from-items.png"]);
});

test("collectPastedSessionAttachmentPaths は file がなければ preventDefault も保存も行わない", async () => {
  let prevented = false;
  let saved = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: { files: [], items: [] },
    currentTimestampLabel: () => "unused",
    preventDefault: () => {
      prevented = true;
    },
    savePastedSessionFile: async () => {
      saved = true;
      return "unused";
    },
    sessionId: "session-1",
  });

  assert.equal(prevented, false);
  assert.equal(saved, false);
  assert.deepEqual(savedPaths, []);
});
