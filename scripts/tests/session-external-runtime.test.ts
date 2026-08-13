import assert from "node:assert/strict";
import { access, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
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
  writeSessionRuntimeDiscoveryFile,
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
    }, { resolveRuntimeDirectory: () => directory });
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
    }, { resolveRuntimeDirectory: () => directory });
    const second = await publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:10002",
      apiSecret: "api-2",
      cliSecret: "cli-2",
      mcpSecret: "mcp-2",
      runtimeInstanceId: "runtime-2",
    }, { resolveRuntimeDirectory: () => directory });
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
      beforeCommit: async () => { throw new Error("commit failed"); },
    }, { resolveRuntimeDirectory: () => directory }));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EXT-WIN-CRED-06: Windows publicationはdirectoryと全fileのACLをsecret公開前に検証する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-windows-acl-"));
  const securedPaths = new Map<string, string[]>();
  try {
    const publication = await publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      runtimeInstanceId: "runtime-windows-acl",
    }, {
      platform: "win32",
      resolveRuntimeDirectory: () => directory,
      secureWindowsPath: async (targetPath, targetKind) => {
        const observations = securedPaths.get(targetPath) ?? [];
        observations.push(targetKind === "file" ? await readFile(targetPath, "utf8") : targetKind);
        securedPaths.set(targetPath, observations);
      },
    });

    assert.deepEqual(securedPaths.get(directory), ["directory"]);
    const fileObservations = [...securedPaths.entries()]
      .filter(([targetPath]) => targetPath !== directory)
      .map(([, observations]) => observations);
    assert.equal(fileObservations.length, 3);
    for (const observations of fileObservations) {
      assert.deepEqual(observations, [""]);
    }
    await publication.cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EXT-WIN-CRED-06: Windows directory ACLを検証できない場合はcredential fileを作らない", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-windows-directory-failure-"));
  try {
    await assert.rejects(() => publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      runtimeInstanceId: "runtime-windows-directory-failure",
    }, {
      platform: "win32",
      resolveRuntimeDirectory: () => directory,
      secureWindowsPath: async () => { throw new Error("ACL verification failed"); },
    }));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EXT-WIN-CRED-06: Windows file ACLの検証失敗は空の部分fileを除去する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-windows-file-failure-"));
  try {
    await assert.rejects(() => publishSessionRuntimeDiscovery({
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      cliSecret: "cli-secret",
      mcpSecret: "mcp-secret",
      runtimeInstanceId: "runtime-windows-file-failure",
    }, {
      platform: "win32",
      resolveRuntimeDirectory: () => directory,
      secureWindowsPath: async (targetPath, targetKind) => {
        if (targetKind === "directory") return;
        assert.equal(await readFile(targetPath, "utf8"), "");
        throw new Error("ACL verification failed");
      },
    }));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DISCOVERY-CLEANUP-01: credential fileのpermission確定失敗は部分fileを残さない", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-write-failure-"));
  const filePath = path.join(directory, "generation.json");
  try {
    await assert.rejects(() => writeSessionRuntimeDiscoveryFile(filePath, "secret", {
      platform: "linux",
      chmodFile: async () => { throw new Error("chmod failed"); },
    }));
    await assert.rejects(() => access(filePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DISCOVERY-CLEANUP-01: credential fileのwrite失敗は部分fileを残さない", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-write-failure-"));
  const filePath = path.join(directory, "generation.json");
  try {
    await assert.rejects(() => writeSessionRuntimeDiscoveryFile(filePath, "secret", {
      openFile: async (...args) => {
        const file = await open(...args);
        const writeFile = file.writeFile.bind(file);
        file.writeFile = (async (...writeArgs) => {
          await writeFile(...writeArgs);
          throw new Error("write failed");
        }) as typeof file.writeFile;
        return file;
      },
    }));
    await assert.rejects(() => access(filePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DISCOVERY-CLEANUP-01: credential fileのclose失敗は再close後に部分fileを除去する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-close-failure-"));
  const filePath = path.join(directory, "generation.json");
  try {
    await assert.rejects(() => writeSessionRuntimeDiscoveryFile(filePath, "secret", {
      openFile: async (...args) => {
        const file = await open(...args);
        const close = file.close.bind(file);
        let closeCalls = 0;
        file.close = (async () => {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("close failed");
          await close();
        }) as typeof file.close;
        return file;
      },
    }));
    await assert.rejects(() => access(filePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DISCOVERY-CLEANUP-01: credential fileのcleanup失敗を元の失敗と共に通知する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-runtime-cleanup-failure-"));
  const filePath = path.join(directory, "generation.json");
  try {
    await assert.rejects(
      () => writeSessionRuntimeDiscoveryFile(filePath, "secret", {
        platform: "linux",
        chmodFile: async () => { throw new Error("chmod failed"); },
        removeFile: async () => { throw new Error("remove failed"); },
      }),
      (error) => error instanceof AggregateError && error.errors.length === 2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
