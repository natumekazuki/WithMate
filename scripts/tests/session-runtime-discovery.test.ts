import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  SESSION_RUNTIME_DISCOVERY_FILE_NAME,
  resolveDefaultSessionRuntimeDirectory,
  resolveDefaultSessionRuntimeDiscoveryFilePath,
} from "../../src/session-runtime-discovery.js";

test("EXT-WIN-CRED-06: Windows runtime discoveryはLOCALAPPDATA配下の固定rootを使う", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" };
  const runtimeDirectoryPath = resolveDefaultSessionRuntimeDirectory(env, "win32");

  assert.equal(
    runtimeDirectoryPath,
    "C:\\Users\\alice\\AppData\\Local\\WithMate\\session-runtime",
  );
  assert.equal(
    resolveDefaultSessionRuntimeDiscoveryFilePath(env, "win32"),
    path.win32.join(runtimeDirectoryPath, SESSION_RUNTIME_DISCOVERY_FILE_NAME),
  );
});

test("EXT-WIN-CRED-06: Windowsではruntime directoryのenvironment overrideを拒否する", () => {
  assert.throws(
    () => resolveDefaultSessionRuntimeDirectory({
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      WITHMATE_SESSION_RUNTIME_DIR: "C:\\shared\\runtime",
    }, "win32"),
    /WITHMATE_SESSION_RUNTIME_DIR is not supported on Windows/,
  );
});

test("EXT-WIN-CRED-06: Windowsではabsolute LOCALAPPDATAを解決できない場合にfail closedする", () => {
  assert.throws(
    () => resolveDefaultSessionRuntimeDirectory({ LOCALAPPDATA: "relative" }, "win32"),
    /LOCALAPPDATA must identify an absolute Windows directory/,
  );
});

test("POSIXではruntime directoryのenvironment overrideを維持する", () => {
  assert.equal(
    resolveDefaultSessionRuntimeDirectory({ WITHMATE_SESSION_RUNTIME_DIR: "./runtime" }, "linux"),
    path.resolve("./runtime"),
  );
});
