import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppLogService } from "../../src-electron/app-log-service.js";

function createService(logsPath: string): AppLogService {
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

