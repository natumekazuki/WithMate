import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeClipboardHelperPayload,
  WindowsFileDropClipboardWriter,
  type ClipboardHelperProcessRequest,
  type ClipboardHelperProcessResult,
} from "../../src-electron/windows-file-drop-clipboard-writer.js";

const completed = (stdout = ""): ClipboardHelperProcessResult => ({
  started: true,
  exitCode: 0,
  timedOut: false,
  stdout,
});
const writeStarted = (overrides: Partial<ClipboardHelperProcessResult> = {}): ClipboardHelperProcessResult => ({
  ...completed("WITHMATE_FILE_DROP_READY"),
  ...overrides,
});

test("Windows file-drop writerは非ASCII pathをASCII-safeなhelper payloadへ変換する", () => {
  const encoded = encodeClipboardHelperPayload({
    path: "C:\\資料\\設計メモ.md",
    marker: "操作-1",
  });
  assert.match(encoded, /^[\x00-\x7f]+$/u);

  const parsed = JSON.parse(encoded) as { pathBase64: string; markerBase64: string };
  assert.equal(Buffer.from(parsed.pathBase64, "base64").toString("utf8"), "C:\\資料\\設計メモ.md");
  assert.equal(Buffer.from(parsed.markerBase64, "base64").toString("utf8"), "操作-1");
});

test("Windows file-drop writerはwriteと別processの三形式read-back一致後だけ成功する", async () => {
  const requests: ClipboardHelperProcessRequest[] = [];
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    createOperationMarker: () => "operation-1",
    runHelper: async (request) => {
      requests.push(request);
      return request.mode === "write" ? writeStarted() : completed('{"match":true}');
    },
  });

  assert.deepEqual(await writer.copyFile("C:\\資料\\報告書.txt"), { status: "copied" });
  assert.deepEqual(requests, [
    { mode: "write", payload: { path: "C:\\資料\\報告書.txt", marker: "operation-1" } },
    { mode: "verify", payload: { path: "C:\\資料\\報告書.txt", marker: "operation-1" } },
  ]);
});

test("Windows file-drop writerはnative process未開始をeffect noneの失敗として返す", async () => {
  const modes: string[] = [];
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async (request) => {
      modes.push(request.mode);
      return { started: false, exitCode: null, timedOut: false, stdout: "" };
    },
  });

  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "failed-before-write" });
  assert.deepEqual(modes, ["write"]);
});

test("Windows file-drop writerはpayload構築失敗でnative writeとread-backを開始しない", async () => {
  const modes: string[] = [];
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async (request) => {
      modes.push(request.mode);
      return completed();
    },
  });

  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "failed-before-write" });
  assert.deepEqual(modes, ["write"]);
});

test("Windows file-drop writerはhelper例外をwrite境界の前後で分類する", async () => {
  const beforeWrite = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async () => {
      throw new Error("spawn failed");
    },
  });
  assert.deepEqual(await beforeWrite.copyFile("C:\\data.txt"), { status: "failed-before-write" });

  const afterWrite = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async (request) => {
      if (request.mode === "write") {
        return writeStarted();
      }
      throw new Error("verification failed");
    },
  });
  assert.deepEqual(await afterWrite.copyFile("C:\\data.txt"), { status: "effect-unknown" });
});

test("Windows file-drop writerはnative write開始後にread-backを確認できなければeffect unknownを返す", async () => {
  for (const verification of [
    completed('{"match":false}'),
    { started: true, exitCode: null, timedOut: true, stdout: "" },
    { started: false, exitCode: null, timedOut: false, stdout: "" },
  ] satisfies ClipboardHelperProcessResult[]) {
    const writer = new WindowsFileDropClipboardWriter({
      platform: "win32",
      runHelper: async (request) => request.mode === "write" ? writeStarted() : verification,
    });
    assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "effect-unknown" });
  }
});

test("Windows file-drop writerはwriter応答より別processのpostconditionを成功根拠にする", async () => {
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async (request) => request.mode === "write"
      ? writeStarted({ exitCode: 1 })
      : completed('{"match":true}'),
  });

  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "copied" });
});

test("Windows file-drop writerは非Windowsでnative helperを開始しない", async () => {
  const writer = new WindowsFileDropClipboardWriter({
    platform: "linux",
    runHelper: async () => assert.fail("helper must not run"),
  });
  assert.deepEqual(await writer.copyFile("/tmp/data.txt"), { status: "failed-before-write" });
});
