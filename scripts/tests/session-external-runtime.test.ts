import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  SESSION_RUNTIME_DISCOVERY_FILE_NAME,
  SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
  SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
} from "../../src/session-runtime-discovery.js";
import {
  publishSessionRuntimeDiscovery,
  resolveSessionRuntimeGenerationFilePath,
} from "../../src-electron/session-external-runtime.js";

test("Session discovery publishes separate CLI and MCP credentials under a Session-only schema", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-test-"));
  try {
    const publication = await publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      runtimeInstanceId: "runtime-1",
      runtimeDirectoryPath: directory,
    });
    const pointer = JSON.parse(await readFile(publication.discoveryFilePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(pointer, {
      schemaVersion: SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
      runtimeInstanceId: "runtime-1",
    });
    const cli = JSON.parse(await readFile(
      resolveSessionRuntimeGenerationFilePath(publication.discoveryFilePath, "cli", "runtime-1"),
      "utf8",
    )) as Record<string, unknown>;
    const mcp = JSON.parse(await readFile(
      resolveSessionRuntimeGenerationFilePath(publication.discoveryFilePath, "mcp", "runtime-1"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(cli.schemaVersion, SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION);
    assert.equal(mcp.schemaVersion, SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION);
    assert.equal(cli.adapterSecret, "cli-secret");
    assert.equal(mcp.adapterSecret, "mcp-secret");
    assert.notEqual(cli.adapterSecret, mcp.adapterSecret);
    assert.equal(path.basename(publication.discoveryFilePath), SESSION_RUNTIME_DISCOVERY_FILE_NAME);
    await publication.cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopping an old Session runtime does not delete a newer publication", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-owner-test-"));
  try {
    const first = await publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:10001",
      apiSecret: "api-1",
      cliSecret: "cli-1",
      mcpSecret: "mcp-1",
      runtimeInstanceId: "runtime-1",
      runtimeDirectoryPath: directory,
    });
    const second = await publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:10002",
      apiSecret: "api-2",
      cliSecret: "cli-2",
      mcpSecret: "mcp-2",
      runtimeInstanceId: "runtime-2",
      runtimeDirectoryPath: directory,
    });
    await first.cleanup();
    const pointer = JSON.parse(await readFile(second.discoveryFilePath, "utf8")) as { runtimeInstanceId: string };
    assert.equal(pointer.runtimeInstanceId, "runtime-2");
    await readFile(resolveSessionRuntimeGenerationFilePath(second.discoveryFilePath, "cli", "runtime-2"), "utf8");
    await second.cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Session discovery cleans prepared generations when atomic publication fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-failure-test-"));
  try {
    await assert.rejects(() => publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      runtimeInstanceId: "runtime-failure",
      runtimeDirectoryPath: directory,
      beforeCommit: async () => { throw new Error("commit failed"); },
    }));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
