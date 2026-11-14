import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppLogService, type AppLogServiceOptions } from "../../src-electron/app/app-log-service.js";

function createService(logsPath: string, options: Partial<AppLogServiceOptions> = {}): AppLogService {
  return new AppLogService({
    logsPath,
    runtimeInfo: {
      appVersion: "1.0.0",
      electronVersion: "41.0.0",
      chromeVersion: "140.0.0",
      nodeVersion: "25.0.0",
      platform: "test",
      arch: "x64",
      isPackaged: false,
    },
    ...options,
  });
}

test("AppLogService は JSONL に runtime 情報付きで書き込む", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-log-test-"));
  try {
    const service = createService(logsPath);
    service.write({
      level: "info",
      kind: "app.ready",
      process: "main",
      message: "ready",
      data: { ok: true },
    });

    const [line] = readFileSync(path.join(logsPath, "withmate.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(line);

    assert.equal(entry.kind, "app.ready");
    assert.equal(entry.level, "info");
    assert.equal(entry.process, "main");
    assert.equal(entry.appVersion, "1.0.0");
    assert.deepEqual(entry.data, { ok: true });
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(logsPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "非ローテーションの専用ログは5MiBを超えた既存JSONLを保持し、logger再生成後も失敗を追記する"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#background-failure-log-policy" }
// fault = "専用ファイルの容量を理由に既存記録を回転・切捨てする、またはlogger再生成で既存記録を失う"
// observable = "一時ディレクトリの専用JSONL全文とファイル一覧"
// observation_boundary = "component-behavior"
// scope = "AppLogService nonrotating storage"
// lifecycle = "permanent"
// impact = "背景処理の失敗原因が容量到達や再起動で失われる"
// distinction = "型検査や通常ログのtestでは実ファイルの保持と再生成後の追記を検出できない"
// @end-test-value
test("AppLogService は非ローテーションの専用ファイルへ容量超過後も継続追記する", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-log-test-"));
  try {
    const fileName = "background-failures.jsonl";
    const logFilePath = path.join(logsPath, fileName);
    const existingLine = `${JSON.stringify({ message: "x".repeat(5 * 1024 * 1024) })}\n`;
    writeFileSync(logFilePath, existingLine, "utf8");
    const options = { fileName, rotation: false };
    const input = { level: "error", kind: "background.failed", process: "main", message: "failed" } as const;

    const first = createService(logsPath, options).write(input);
    const second = createService(logsPath, options).write({ ...input, message: "failed again" });

    assert.equal(readFileSync(logFilePath, "utf8"), `${existingLine}${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    assert.deepEqual(readdirSync(logsPath), [fileName]);
  } finally {
    rmSync(logsPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "通常ログの既定5MiBローテーションはactiveを含む5ファイルを保持し専用失敗ファイルを変更しない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md#background-failure-log-policy" }
// fault = "通常ログの既定容量・保持数が変わる、または通常ログの世代削除が専用失敗ファイルを削除する"
// observable = "通常ログのactive JSONLと世代ファイル数、専用失敗ファイルの内容"
// observation_boundary = "component-behavior"
// scope = "AppLogService default rotating storage isolation"
// lifecycle = "permanent"
// impact = "通常ログの容量管理が失われる、または背景失敗の診断記録が失われる"
// distinction = "既存のJSONL書式testはローテーションと別ファイルの保持を実行しない"
// @end-test-value
test("AppLogService は既定5MiBと5ファイルで通常ログだけをローテーションする", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-log-test-"));
  try {
    const backgroundFilePath = path.join(logsPath, "background-failures.jsonl");
    const backgroundEntry = createService(logsPath, { fileName: "background-failures.jsonl", rotation: false }).write({
      level: "error", kind: "background.failed", process: "main", message: "failed",
    });
    const logFilePath = path.join(logsPath, "withmate.jsonl");
    const existingLine = `${JSON.stringify({ message: "x".repeat(5 * 1024 * 1024 - 1000) })}\n`;
    writeFileSync(logFilePath, existingLine, "utf8");
    const service = createService(logsPath);
    const belowLimitEntry = service.write({ level: "info", kind: "app.ready", process: "main", message: "ready" });
    assert.equal(readFileSync(logFilePath, "utf8"), `${existingLine}${JSON.stringify(belowLimitEntry)}\n`);

    const rotatedEntry = service.write({ level: "error", kind: "app.failed", process: "main", message: "x".repeat(1000) });
    assert.equal(readFileSync(logFilePath, "utf8"), `${JSON.stringify(rotatedEntry)}\n`);
    const oversizedLine = `${JSON.stringify({ message: "x".repeat(5 * 1024 * 1024) })}\n`;
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(logFilePath, oversizedLine, "utf8");
      createService(logsPath).write({ level: "info", kind: "app.ready", process: "main", message: "ready" });
    }

    assert.equal(readdirSync(logsPath).filter((name) => name === "withmate.jsonl" || name.startsWith("withmate.jsonl.")).length, 5);
    assert.equal(readFileSync(backgroundFilePath, "utf8"), `${JSON.stringify(backgroundEntry)}\n`);
  } finally {
    rmSync(logsPath, { recursive: true, force: true });
  }
});

test("AppLogService は循環 data を安全に記録する", () => {
  const logsPath = mkdtempSync(path.join(tmpdir(), "withmate-log-test-"));
  try {
    const service = createService(logsPath);
    const value: { self?: unknown } = {};
    value.self = value;

    service.write({
      level: "error",
      kind: "ipc.error",
      process: "main",
      message: "failed",
      data: value,
      error: service.errorToLogError(new Error("boom")),
    });

    const [line] = readFileSync(path.join(logsPath, "withmate.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(line);

    assert.equal(entry.data, "[unserializable]");
    assert.equal(entry.error.message, "boom");
  } finally {
    rmSync(logsPath, { recursive: true, force: true });
  }
});

