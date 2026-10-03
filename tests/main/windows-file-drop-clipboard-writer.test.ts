import assert from "node:assert/strict";
import test from "node:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";

import {
  encodeClipboardHelperPayload,
  resolveWindowsPowerShellExecutablePath,
  runPowerShellClipboardHelper,
  WindowsFileDropClipboardWriter,
  type ClipboardHelperProcessRequest,
  type ClipboardHelperProcessResult,
} from "../../src-electron/files/windows-file-drop-clipboard-writer.js";

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

test("Windows file-drop writerはSystem32のPowerShellを絶対pathで解決する", async () => {
  assert.equal(
    resolveWindowsPowerShellExecutablePath("C:\\Windows"),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(resolveWindowsPowerShellExecutablePath("relative\\Windows"), null);
  assert.equal(resolveWindowsPowerShellExecutablePath(undefined), null);

  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    systemRoot: "relative\\Windows",
  });
  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "failed-before-write" });
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

// @test-value v2
// kind = "invariant"
// claim = "writer process未開始では準備したreaderへclipboard読取りを許可せず失敗を返す"
// oracle = { type = "contract", ref = "docs/adr/013-explicit-local-path-open-policy.md: Decision" }
// fault = "writer未開始を成功または結果不明と誤分類し、readerを実行する"
// observable = "copyFile結果とreaderに渡るwrite完了gateのfalse"
// observation_boundary = "public-boundary"
// scope = "WindowsFileDropClipboardWriter.copyFile"
// lifecycle = "permanent"
// distinction = "native process開始前の失敗をclipboard書込み後の不明と区別する"
// @end-test-value
test("Windows file-drop writerはnative process未開始をeffect noneの失敗として返す", async () => {
  const modes: string[] = [];
  let allowed: boolean | undefined;
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    runHelper: async (request, waitForWrite) => {
      modes.push(request.mode);
      if (waitForWrite) {
        allowed = await waitForWrite;
      }
      return { started: false, exitCode: null, timedOut: false, stdout: "" };
    },
  });

  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "failed-before-write" });
  assert.deepEqual(modes, ["write", "verify"]);
  assert.equal(allowed, false);
});

function createProcessHarness() {
  const children: ReturnType<typeof createChild>[] = [];
  function createChild() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      killed: false,
      kill() {
        child.killed = true;
        child.emit("close", null);
        return true;
      },
    });
    return child;
  }
  const spawnProcess = (() => {
    const child = createChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    createOperationMarker: () => "operation-1",
    runHelper: (request, waitForWrite) => runPowerShellClipboardHelper(request, "C:\\Windows", waitForWrite, spawnProcess),
  });
  return { children, writer };
}

// @test-value v2
// kind = "invariant"
// claim = "reader準備をwriterと並行開始しても、writer終了前は読取りを許可せずread-back一致後だけ成功する"
// oracle = { type = "contract", ref = "docs/adr/013-explicit-local-path-open-policy.md: Decision; https://github.com/natumekazuki/WithMate/issues/771" }
// fault = "reader起動をwriter終了まで待って遅延を直列化する、またはwriter終了前にread-backを開始する"
// observable = "二つのprocess生成、reader stdinの未終了/終了、copyFileのcopied結果"
// observation_boundary = "implementation"
// scope = "Windows clipboard helper startup and read-back gate"
// lifecycle = "permanent"
// impact = "不要な起動待ちと書込み前のclipboard読取りによる結果誤判定を防ぐ"
// distinction = "runHelper結果のstubで通らない実helper runnerのstdin gateをfake processで低コストに検証する"
// @end-test-value
test("Windows file-drop helperは並行準備したreaderをwriter終了後に解放する", async () => {
  const { writer, children } = createProcessHarness();
  const pending = writer.copyFile("C:\\資料\\報告書.txt");
  assert.equal(children.length, 2);
  const [write, verify] = children;
  write.emit("spawn");
  verify.emit("spawn");
  assert.equal(write.stdin.writableEnded, true);
  assert.equal(verify.stdin.writableEnded, false);
  write.stdout.write("WITHMATE_FILE_DROP_READY");
  await setImmediate();
  assert.equal(verify.stdin.writableEnded, false);
  write.emit("close", 0);
  await setImmediate();
  assert.equal(verify.stdin.writableEnded, true);
  assert.equal(verify.stdin.read().toString(), write.stdin.read().toString());
  verify.stdout.write('{"match":true}');
  verify.emit("close", 0);
  assert.deepEqual(await pending, { status: "copied" });
});

// @test-value v2
// kind = "invariant"
// claim = "write開始markerのないwriter終了ではreaderへ対象を渡さず停止し、失敗を返す"
// oracle = { type = "contract", ref = "docs/adr/013-explicit-local-path-open-policy.md: Decision" }
// fault = "書込み未開始でもreaderを待機させ続ける、またはclipboard読取りを許可する"
// observable = "reader kill、stdin未終了とcopyFileのfailed-before-write結果"
// observation_boundary = "implementation"
// scope = "Windows clipboard helper cancellation"
// lifecycle = "permanent"
// distinction = "process生成後かつnative write前の失敗で実runnerがreaderを回収することを検証する"
// @end-test-value
test("Windows file-drop helperはwrite未開始なら待機readerを停止する", async () => {
  const { writer, children } = createProcessHarness();
  const pending = writer.copyFile("C:\\data.txt");
  children[0].emit("spawn");
  children[1].emit("spawn");
  children[0].emit("close", 1);
  assert.deepEqual(await pending, { status: "failed-before-write" });
  assert.equal(children[1].killed, true);
  assert.equal(children[1].stdin.writableEnded, false);
});

// @test-value v2
// kind = "invariant"
// claim = "write開始後にhelperがtimeoutした場合、processを停止して結果不明を返す"
// oracle = { type = "contract", ref = "docs/adr/013-explicit-local-path-open-policy.md: Decision; https://github.com/natumekazuki/WithMate/issues/771" }
// fault = "timeout後もhelper待ちを継続する、または未確認のcopyを成功とする"
// observable = "両processのkillとcopyFileのeffect-unknown結果"
// observation_boundary = "implementation"
// scope = "Windows clipboard helper timeout"
// lifecycle = "permanent"
// distinction = "結果stubのtimedOutフラグでなく実runnerの8秒timerと終了処理を仮想時刻で確認する"
// @end-test-value
test("Windows file-drop helperはtimeout時に停止してunknownを返す", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { writer, children } = createProcessHarness();
  const pending = writer.copyFile("C:\\data.txt");
  children[0].emit("spawn");
  children[1].emit("spawn");
  children[0].stdout.write("WITHMATE_FILE_DROP_READY");
  context.mock.timers.tick(8_000);
  assert.deepEqual(await pending, { status: "effect-unknown" });
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, true);
  assert.equal(children[1].stdin.writableEnded, false);
});

// @test-value v2
// kind = "invariant"
// claim = "operation markerの生成失敗ではnative helperを開始せず失敗を返す"
// oracle = { type = "contract", ref = "docs/adr/013-explicit-local-path-open-policy.md: Decision" }
// fault = "payloadを構築できないままclipboard helperを実行する"
// observable = "copyFile結果とhelper呼出しがないこと"
// observation_boundary = "public-boundary"
// scope = "WindowsFileDropClipboardWriter.copyFile"
// lifecycle = "permanent"
// distinction = "process生成前のpayload準備例外を対象としprocess結果のstubでは代替しない"
// @end-test-value
test("Windows file-drop writerはpayload構築失敗でnative writeとread-backを開始しない", async () => {
  const modes: string[] = [];
  const writer = new WindowsFileDropClipboardWriter({
    platform: "win32",
    createOperationMarker: () => { throw new Error("marker failed"); },
    runHelper: async (request) => {
      modes.push(request.mode);
      return completed();
    },
  });

  assert.deepEqual(await writer.copyFile("C:\\data.txt"), { status: "failed-before-write" });
  assert.deepEqual(modes, []);
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
