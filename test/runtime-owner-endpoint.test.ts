import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNTIME_IPC_LIMITS } from "../src/main/runtime-host/runtime-ipc-common.js";
import {
  deriveRuntimeEndpointDescriptor,
  resolveRuntimeOwnerIdentity,
  validateUnixArtifactSecurity,
} from "../src/main/runtime-host/runtime-owner-identity.js";
import { acquireRuntimeOwnerClaim } from "../src/main/runtime-host/runtime-owner-claim.js";
import {
  canAdmitRuntimeConnection,
  classifyRuntimeSocketConnectError,
  connectRuntimeEndpoint,
  createRuntimeEndpointListener,
  createRuntimeSocketConnection,
  RuntimeConnectionRegistry,
  RuntimeEndpointUnavailableError,
  type RuntimeEndpointConnection,
  type RuntimeEndpointListener,
} from "../src/main/runtime-host/runtime-endpoint.js";
import {
  validateWindowsKernelObjectSecuritySddl,
  WINDOWS_PIPE_CLIENT_SECURITY_QOS,
} from "../src/main/runtime-host/runtime-windows-native.js";

test("runtime owner identity collapses root aliases and separates distinct application roots", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-owner-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const firstRoot = path.join(fixtureRoot, "first");
  const secondRoot = path.join(fixtureRoot, "second");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  const first = await resolveRuntimeOwnerIdentity({ applicationDataRoot: firstRoot });
  const second = await resolveRuntimeOwnerIdentity({ applicationDataRoot: secondRoot });
  assert.notEqual(first.endpointId, second.endpointId);
  assert.notEqual(first.endpoint.address, second.endpoint.address);

  const aliasRoot = path.join(fixtureRoot, "alias");
  await symlink(firstRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const alias = await resolveRuntimeOwnerIdentity({ applicationDataRoot: aliasRoot });
  assert.equal(alias.applicationDirectory, first.applicationDirectory);
  assert.equal(alias.endpointId, first.endpointId);
  assert.equal(alias.endpoint.address, first.endpoint.address);
});

test("runtime owner identity rejects a reparse or symlink application directory", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-owner-link-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const applicationRoot = path.join(fixtureRoot, "root");
  const redirected = path.join(fixtureRoot, "redirected");
  await Promise.all([mkdir(applicationRoot), mkdir(redirected)]);
  await symlink(redirected, path.join(applicationRoot, "WithMate"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    resolveRuntimeOwnerIdentity({ applicationDataRoot: applicationRoot }),
    /application directory is not a canonical owned directory/u,
  );
});

test("runtime endpoint descriptors remain version-neutral and Unix metadata validation fails closed", () => {
  const windows = deriveRuntimeEndpointDescriptor({
    platform: "win32",
    endpointId: "a".repeat(64),
    principalId: "S-1-5-21-1000",
    applicationDirectory: "C:\\AppData\\WithMate",
  });
  const unix = deriveRuntimeEndpointDescriptor({
    platform: "linux",
    endpointId: "a".repeat(64),
    principalId: "1000",
    applicationDirectory: "/home/user/.config/WithMate",
  });
  if (windows.platform !== "win32" || unix.platform !== "unix") {
    throw new Error("Expected platform-specific runtime endpoint descriptors.");
  }
  assert.match(windows.address, /^\\\\\.\\pipe\\WithMateRuntime-/u);
  assert.match(windows.claimName, /^Global\\WithMateRuntime-/u);
  assert.doesNotMatch(windows.address, /-v1/u);
  assert.match(unix.address, /runtime\.sock$/u);
  assert.match(unix.address, /^\/tmp\//u);
  assert.equal(unix.claimPath, "/home/user/.config/WithMate/.runtime-owner.lock");
  assert.doesNotMatch(unix.address, /-v1/u);

  assert.doesNotThrow(() =>
    validateUnixArtifactSecurity(
      { uid: 1000, mode: 0o40700, kind: "directory", symbolicLink: false },
      { uid: 1000, permissions: 0o700, kind: "directory" },
    ),
  );
  for (const actual of [
    { uid: 1001, mode: 0o40700, kind: "directory" as const, symbolicLink: false },
    { uid: 1000, mode: 0o40755, kind: "directory" as const, symbolicLink: false },
    { uid: 1000, mode: 0o40700, kind: "directory" as const, symbolicLink: true },
    { uid: 1000, mode: 0o100700, kind: "file" as const, symbolicLink: false },
  ]) {
    assert.throws(
      () => validateUnixArtifactSecurity(actual, { uid: 1000, permissions: 0o700, kind: "directory" }),
      /Unix runtime artifact is not securely owned/u,
    );
  }
});

test("runtime connection admission is bounded at the shared aggregate limit", () => {
  assert.equal(canAdmitRuntimeConnection(31, 32), true);
  assert.equal(canAdmitRuntimeConnection(32, 32), false);
  assert.throws(() => canAdmitRuntimeConnection(-1, 32), RangeError);
});

test("runtime connection registry releases a disconnected pre-accept connection from every aggregate", () => {
  const registry = new RuntimeConnectionRegistry<object>(2);
  const disconnected = {};

  assert.equal(registry.tryAdd(disconnected), true);
  registry.enqueue(disconnected);
  registry.release(disconnected);

  assert.equal(registry.takeQueued(), undefined);
  assert.deepEqual(registry.snapshot(), []);
  assert.equal(registry.tryAdd({}), true);
  assert.equal(registry.tryAdd({}), true);
  assert.equal(registry.tryAdd({}), false);
});

test("Windows kernel object security requires owner and exact protected allow-all ACEs", () => {
  const sid = "S-1-5-21-1000";
  assert.doesNotThrow(() => validateWindowsKernelObjectSecuritySddl(`O:${sid}D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, sid));
  for (const [principalSid, alias] of [
    ["S-1-5-18", "SY"],
    ["S-1-5-19", "LS"],
    ["S-1-5-20", "NS"],
    ["S-1-5-32-545", "BU"],
  ] as const) {
    assert.doesNotThrow(() =>
      validateWindowsKernelObjectSecuritySddl(`O:${alias}D:P(A;;FA;;;SY)(A;;FA;;;${alias})`, principalSid),
    );
  }
  assert.doesNotThrow(() =>
    validateWindowsKernelObjectSecuritySddl(`O:serialized-ownerD:P(A;;FA;;;SY)(A;;FA;;;${sid})`, sid, sid),
  );
  assert.throws(
    () =>
      validateWindowsKernelObjectSecuritySddl(
        `O:serialized-ownerD:P(A;;FA;;;SY)(A;;FA;;;${sid})`,
        sid,
        "S-1-5-21-2000",
      ),
    /reason: owner-mismatch/u,
  );
  for (const [sddl, reason] of [
    [`O:serialized-ownerD:(A;;FA;;;SY)(A;;FA;;;${sid})`, "dacl-not-protected"],
    [`O:serialized-ownerD:P(A;;FA;;;SY)`, "ace-count"],
    [`O:serialized-ownerD:P(A;CI;FA;;;SY)(A;;FA;;;${sid})`, "ace-shape"],
    [`O:serialized-ownerD:P(A;;FA;;;SY)(A;;FA;;;BA)`, "trustee-set"],
  ] as const) {
    assert.throws(() => validateWindowsKernelObjectSecuritySddl(sddl, sid, sid), new RegExp(`reason: ${reason}`, "u"));
  }
  for (const [sddl, reason] of [
    [`D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, "owner-mismatch"],
    [`O:${sid}D:(A;;FA;;;SY)(A;;FA;;;${sid})`, "dacl-not-protected"],
    [`O:${sid}D:P(A;;FA;;;SY)`, "ace-count"],
    [`O:${sid}D:P(D;;FA;;;SY)(A;;FA;;;${sid})`, "ace-shape"],
    [`O:${sid}D:P(A;CI;FA;;;SY)(A;;FA;;;${sid})`, "ace-shape"],
    [`O:${sid}D:P(A;;GR;;;SY)(A;;FA;;;${sid})`, "ace-shape"],
    [`O:${sid}D:P(A;;FA;;;SY)(A;;FA;;;SY)`, "trustee-set"],
    [`O:BAD:P(A;;FA;;;SY)(A;;FA;;;${sid})`, "owner-mismatch"],
    [`O:S-1-5-21-2000D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, "owner-mismatch"],
  ] as const) {
    assert.throws(
      () => validateWindowsKernelObjectSecuritySddl(sddl, sid),
      new RegExp(`not restricted to the current user and SYSTEM \\(reason: ${reason}\\)`, "u"),
    );
  }
});

test("Windows pipe clients disclose identity without granting local impersonation", () => {
  assert.equal(WINDOWS_PIPE_CLIENT_SECURITY_QOS, 0x00110000);
});

test("runtime owner claim is exclusive and release permits a new generation", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-claim-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });

  const first = await acquireRuntimeOwnerClaim(identity);
  assert.equal(first.status, "acquired");
  const second = await acquireRuntimeOwnerClaim(identity);
  assert.equal(second.status, "busy");
  if (first.status !== "acquired") throw new Error("Expected the first runtime owner claim.");
  await first.release();

  const third = await acquireRuntimeOwnerClaim(identity);
  assert.equal(third.status, "acquired");
  if (third.status !== "acquired") throw new Error("Expected the replacement runtime owner claim.");
  assert.notEqual(third.generationId, first.generationId);
  await third.release();
});

test("runtime endpoint absence is explicit and does not create a fallback listener", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-absent-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });

  await assert.rejects(
    connectRuntimeEndpoint(identity, { timeoutMs: 100 }),
    (error: unknown) => error instanceof RuntimeEndpointUnavailableError && error.reason === "absent",
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(connectRuntimeEndpoint(identity, { timeoutMs: 100, signal: aborted.signal }), {
    name: "AbortError",
  });
});

test("Unix socket connect classifies only missing or refused owners as absent", () => {
  for (const code of ["ENOENT", "ECONNREFUSED"]) {
    const classified = classifyRuntimeSocketConnectError(Object.assign(new Error(code), { code }));
    assert.ok(classified instanceof RuntimeEndpointUnavailableError);
    assert.equal(classified.reason, "absent");
  }

  for (const code of ["EACCES", "ENOTSOCK", "EPERM"]) {
    const original = Object.assign(new Error(code), { code });
    assert.equal(classifyRuntimeSocketConnectError(original), original);
  }
});

test(
  "socket transport abort destroys the underlying write before another write can overlap",
  { skip: process.platform !== "win32" },
  async (context) => {
    const address = `\\\\.\\pipe\\WithMateRuntimeSocketAbort-${randomUUID()}`;
    const server = net.createServer({ pauseOnConnect: true });
    let clientSocket: import("node:net").Socket | undefined;
    let peer: import("node:net").Socket | undefined;
    context.after(async () => {
      clientSocket?.destroy();
      peer?.destroy();
      await closeNetServer(server);
    });
    await listenNetServer(server, address);
    const acceptedSocket = new Promise<import("node:net").Socket>((resolve) => server.once("connection", resolve));
    clientSocket = net.createConnection(address);
    peer = await acceptedSocket;
    const connection = createRuntimeSocketConnection(clientSocket, "test-principal", 0o600);
    const cancellation = new AbortController();
    const pendingWrite = connection.write(Buffer.alloc(8 * 1024 * 1024), cancellation.signal);
    cancellation.abort();
    await assert.rejects(pendingWrite, { name: "AbortError" });
    await assert.rejects(connection.write(Buffer.from("must-not-overlap")), RuntimeEndpointUnavailableError);
  },
);

test("runtime owner claim arbitrates simultaneous processes and allows takeover after owner release", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-claim-process-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const first = spawnClaimFixture(fixtureRoot);
  const second = spawnClaimFixture(fixtureRoot);
  context.after(async () => {
    await stopFixture(first);
    await stopFixture(second);
  });

  const results = await Promise.all([nextMessage(first), nextMessage(second)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["acquired", "busy"]);
  const owner = results[0]?.status === "acquired" ? first : second;
  const waiter = owner === first ? second : first;
  await stopFixture(owner);
  await stopFixture(waiter);

  const replacement = spawnClaimFixture(fixtureRoot);
  context.after(() => stopFixture(replacement));
  assert.equal((await nextMessage(replacement)).status, "acquired");
  await stopFixture(replacement);
});

test(
  "Windows named pipe authenticates the client token and server-owned secured object before carrying bytes",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-pipe-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const claim = await acquireRuntimeOwnerClaim(identity);
    assert.equal(claim.status, "acquired");
    if (claim.status !== "acquired") throw new Error("Expected the runtime owner claim.");
    let listener: RuntimeEndpointListener | undefined;
    let client: RuntimeEndpointConnection | undefined;
    let server: RuntimeEndpointConnection | undefined;
    context.after(async () => {
      await client?.close();
      await server?.close();
      await listener?.close();
      await claim.release();
    });

    listener = await createRuntimeEndpointListener(identity, claim);
    await assert.rejects(claim.release(), /Runtime owner claim cannot be released while its endpoint is active/u);
    const accepted = listener.accept();
    client = await connectRuntimeEndpoint(identity, { timeoutMs: 2_000 });
    server = await accepted;

    assert.equal(client.peerPrincipalId, identity.principalId);
    assert.equal(server.peerPrincipalId, identity.principalId);
    assert.doesNotThrow(() =>
      validateWindowsKernelObjectSecuritySddl(
        server.endpointSecurity.daclSddl,
        identity.principalId,
        identity.principalId,
      ),
    );
    assert.doesNotThrow(() =>
      validateWindowsKernelObjectSecuritySddl(
        client.endpointSecurity.daclSddl,
        identity.principalId,
        identity.principalId,
      ),
    );
    assert.doesNotMatch(server.endpointSecurity.daclSddl, /;;;(?:WD|AN|AU|BU)\)/u);

    await client.write(Buffer.from("client"));
    assert.equal(Buffer.from((await server.read()) ?? []).toString(), "client");
    await server.write(Buffer.from("server"));
    assert.equal(Buffer.from((await client.read()) ?? []).toString(), "server");

    const cancellation = new AbortController();
    const interruptedRead = server.read(cancellation.signal);
    cancellation.abort();
    await assert.rejects(interruptedRead, { name: "AbortError" });
    await client.write(Buffer.from("after-cancel"));
    assert.equal(Buffer.from((await server.read()) ?? []).toString(), "after-cancel");
  },
);

test(
  "Windows listener close cancels a pending accept and releases the owner boundary",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-pipe-close-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const claim = await acquireRuntimeOwnerClaim(identity);
    assert.equal(claim.status, "acquired");
    if (claim.status !== "acquired") throw new Error("Expected the runtime owner claim.");
    const listener = await createRuntimeEndpointListener(identity, claim);
    const pendingAccept = listener.accept();

    await listener.close();
    await assert.rejects(pendingAccept);
    await claim.release();

    const replacement = await acquireRuntimeOwnerClaim(identity);
    assert.equal(replacement.status, "acquired");
    if (replacement.status === "acquired") await replacement.release();
  },
);

test(
  "Windows listener rejects a pre-aborted accept without consuming its waiting instance",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-pipe-pre-abort-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const claim = await acquireRuntimeOwnerClaim(identity);
    assert.equal(claim.status, "acquired");
    if (claim.status !== "acquired") throw new Error("Expected the runtime owner claim.");
    const listener = await createRuntimeEndpointListener(identity, claim);
    context.after(async () => {
      await listener.close();
      await claim.release();
    });
    const controller = new AbortController();
    controller.abort();
    const acceptResult = listener.accept(controller.signal).then(
      () => "accepted" as const,
      (error: unknown) => (error instanceof Error && error.name === "AbortError" ? "aborted" : "other_error"),
    );

    const result = await Promise.race([
      acceptResult,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    assert.equal(result, "aborted");

    const accepted = listener.accept();
    const client = await connectRuntimeEndpoint(identity, { timeoutMs: 2_000 });
    const server = await accepted;
    await Promise.all([client.close(), server.close()]);
  },
);

test(
  "Windows listener waits for a connection slot instead of failing the owner at its instance limit",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-pipe-capacity-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    const claim = await acquireRuntimeOwnerClaim(identity);
    assert.equal(claim.status, "acquired");
    if (claim.status !== "acquired") throw new Error("Expected the runtime owner claim.");
    const listener = await createRuntimeEndpointListener(identity, claim);
    const clients: RuntimeEndpointConnection[] = [];
    const servers: RuntimeEndpointConnection[] = [];
    const capacityConnectionTimeoutMs = 10_000;
    context.after(async () => {
      await Promise.allSettled([...clients, ...servers].map((connection) => connection.close()));
      await listener.close();
      await claim.release();
    });

    for (let index = 0; index < RUNTIME_IPC_LIMITS.maxConnections; index += 1) {
      const accepted = listener.accept();
      clients.push(await connectRuntimeEndpoint(identity, { timeoutMs: capacityConnectionTimeoutMs }));
      servers.push(await accepted);
    }

    const pendingAccept = listener.accept();
    const settlement = await Promise.race([
      pendingAccept.then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      ),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    assert.equal(settlement, "pending");

    await clients[1]?.write(Buffer.from("still-alive"));
    assert.equal(Buffer.from((await servers[1]?.read()) ?? []).toString(), "still-alive");
    await Promise.all([clients[0]?.close(), servers[0]?.close()]);
    const replacementClient = await connectRuntimeEndpoint(identity, { timeoutMs: capacityConnectionTimeoutMs });
    clients.push(replacementClient);
    servers.push(await pendingAccept);
  },
);

test(
  "Windows endpoint creation fails closed when another first pipe instance already exists",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-pipe-conflict-"));
    context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot: fixtureRoot });
    if (identity.endpoint.platform !== "win32") throw new Error("Expected a Windows runtime endpoint.");
    const claim = await acquireRuntimeOwnerClaim(identity);
    assert.equal(claim.status, "acquired");
    if (claim.status !== "acquired") throw new Error("Expected the runtime owner claim.");
    const existing = net.createServer();
    context.after(async () => {
      await closeNetServer(existing);
      await claim.release();
    });
    await listenNetServer(existing, identity.endpoint.address);

    await assert.rejects(createRuntimeEndpointListener(identity, claim), /Runtime named pipe could not be created/u);
  },
);

type ClaimFixtureMessage = Readonly<{
  status: "acquired" | "busy";
  generationId?: string;
}>;

function spawnClaimFixture(applicationDataRoot: string): ChildProcess {
  return fork(path.resolve("test/fixtures/runtime-owner-claim-child.ts"), [applicationDataRoot], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function nextMessage(child: ChildProcess): Promise<ClaimFixtureMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as ClaimFixtureMessage);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Runtime claim fixture exited before reporting status (${String(code)}).`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.connected) {
    await new Promise<void>((resolve, reject) => {
      try {
        child.send("release", (error) => {
          if (error === null || error === undefined || isClosedIpcChannel(error)) resolve();
          else reject(error);
        });
      } catch (error) {
        if (isClosedIpcChannel(error)) resolve();
        else reject(error);
      }
    });
  }
  await exited;
}

function isClosedIpcChannel(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "ERR_IPC_CHANNEL_CLOSED"
  );
}

function listenNetServer(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeNetServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
}
