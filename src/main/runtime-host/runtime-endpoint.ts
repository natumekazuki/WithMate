import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";

import { RUNTIME_IPC_LIMITS } from "./runtime-ipc-common.js";
import {
  assertUnixPathSecurity,
  type RuntimeOwnerIdentity,
  validateUnixArtifactSecurity,
} from "./runtime-owner-identity.js";
import type { RuntimeOwnerClaim } from "./runtime-owner-claim.js";
import {
  connectSecureWindowsPipe,
  createSecureWindowsPipeListener,
  RuntimeEndpointUnavailableError,
} from "./runtime-windows-native.js";

export { RuntimeEndpointUnavailableError };

class RuntimeEndpointCleanupIncompleteError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Runtime endpoint cleanup did not close its listener.");
    this.name = "RuntimeEndpointCleanupIncompleteError";
  }
}

export type RuntimeEndpointConnection = Readonly<{
  peerPrincipalId: string;
  endpointSecurity: Readonly<{
    daclSddl: string;
    unixMode?: number;
  }>;
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

export type RuntimeEndpointListener = Readonly<{
  accept(signal?: AbortSignal): Promise<RuntimeEndpointConnection>;
  close(): Promise<void>;
}>;

export async function createRuntimeEndpointListener(
  identity: RuntimeOwnerIdentity,
  claim: Extract<RuntimeOwnerClaim, { status: "acquired" }>,
): Promise<RuntimeEndpointListener> {
  if (claim.endpointId !== identity.endpointId) {
    throw new Error("Runtime owner claim does not belong to this endpoint.");
  }
  const releaseEndpointLease = claim.holdEndpoint();
  try {
    if (identity.endpoint.platform === "win32") {
      const native = createSecureWindowsPipeListener(
        identity.endpoint.address,
        identity.principalId,
        RUNTIME_IPC_LIMITS.maxConnections,
      );
      let closed = false;
      return {
        accept: (signal) => native.accept(signal),
        async close() {
          if (closed) return;
          closed = true;
          try {
            await native.close();
          } finally {
            releaseEndpointLease();
          }
        },
      };
    }
    return await createUnixEndpointListener(identity, releaseEndpointLease);
  } catch (error) {
    if (!(error instanceof RuntimeEndpointCleanupIncompleteError)) releaseEndpointLease();
    throw error;
  }
}

export async function connectRuntimeEndpoint(
  identity: RuntimeOwnerIdentity,
  options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
): Promise<RuntimeEndpointConnection> {
  if (options.signal?.aborted) throw abortFailure();
  if (identity.endpoint.platform === "win32") {
    return await connectSecureWindowsPipe(identity.endpoint.address, identity.principalId, options);
  }
  try {
    await assertUnixPathSecurity(identity.endpoint.runtimeDirectory, {
      uid: Number(identity.principalId),
      permissions: 0o700,
      kind: "directory",
    });
    await assertUnixPathSecurity(identity.endpoint.address, {
      uid: Number(identity.principalId),
      permissions: 0o600,
      kind: "socket",
    });
  } catch (error) {
    if (isMissingArtifact(error)) throw new RuntimeEndpointUnavailableError("absent");
    throw error;
  }
  const socket = net.createConnection({ path: identity.endpoint.address });
  try {
    await waitForSocketConnect(socket, options);
    return createRuntimeSocketConnection(socket, identity.principalId, 0o600);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function isMissingArtifact(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "ENOENT"
  );
}

async function createUnixEndpointListener(
  identity: RuntimeOwnerIdentity,
  releaseEndpointLease: () => void,
): Promise<RuntimeEndpointListener> {
  if (identity.endpoint.platform !== "unix") throw new Error("Expected a Unix runtime endpoint.");
  const uid = Number(identity.principalId);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("Runtime Unix principal identity is invalid.");
  await mkdir(identity.endpoint.runtimeDirectory, { recursive: true, mode: 0o700 });
  await assertUnixPathSecurity(identity.endpoint.runtimeDirectory, {
    uid,
    permissions: 0o700,
    kind: "directory",
  });
  await removeStaleUnixSocket(identity.endpoint.address, uid);

  const connections = new RuntimeConnectionRegistry<RuntimeEndpointConnection>();
  const acceptWaiters: Array<{
    resolve(connection: RuntimeEndpointConnection): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  let closed = false;
  let acceptingConnections = true;
  let closePromise: Promise<void> | undefined;
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    if (!acceptingConnections || closed) {
      socket.destroy();
      return;
    }
    const connection = createRuntimeSocketConnection(socket, identity.principalId, 0o600, () =>
      connections.release(connection),
    );
    if (!connections.tryAdd(connection)) {
      socket.destroy();
      return;
    }
    const waiter = acceptWaiters.shift();
    if (waiter === undefined) {
      connections.enqueue(connection);
      return;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
    waiter.resolve(connection);
  });
  server.maxConnections = RUNTIME_IPC_LIMITS.maxConnections;

  let createdSocket: BigIntStats | undefined;
  try {
    await listenUnixServer(server, identity.endpoint.address);
    createdSocket = await lstat(identity.endpoint.address, { bigint: true });
    assertOwnedUnixSocket(createdSocket, uid);
    await chmod(identity.endpoint.address, 0o600);
    await assertUnixPathSecurity(identity.endpoint.address, {
      uid,
      permissions: 0o600,
      kind: "socket",
    });
  } catch (error) {
    acceptingConnections = false;
    const cleanupErrors: unknown[] = [];
    const connectionResults = await Promise.allSettled(connections.snapshot().map((connection) => connection.close()));
    cleanupErrors.push(
      ...connectionResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    connections.clear();
    let socketIdentityVerified = createdSocket === undefined;
    if (createdSocket !== undefined) {
      try {
        await assertUnixSocketIfSame(identity.endpoint.address, uid, createdSocket.dev, createdSocket.ino, undefined);
        socketIdentityVerified = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await closeServer(server);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
      throw new RuntimeEndpointCleanupIncompleteError([error, ...cleanupErrors]);
    }
    if (createdSocket !== undefined && socketIdentityVerified) {
      try {
        await unlinkUnixSocketIfSameIfPresent(
          identity.endpoint.address,
          uid,
          createdSocket.dev,
          createdSocket.ino,
          undefined,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Runtime Unix endpoint startup and cleanup both failed.");
    }
    throw error;
  }
  const ownedSocket = await lstat(identity.endpoint.address, { bigint: true });

  return {
    async accept(signal) {
      if (!acceptingConnections || closed || closePromise !== undefined) {
        throw new RuntimeEndpointUnavailableError("closed");
      }
      const queued = connections.takeQueued();
      if (queued !== undefined) return queued;
      if (signal?.aborted) throw abortFailure();
      return await new Promise<RuntimeEndpointConnection>((resolve, reject) => {
        const waiter: (typeof acceptWaiters)[number] = {
          resolve,
          reject,
          ...(signal === undefined ? {} : { signal }),
        };
        if (signal !== undefined) {
          waiter.onAbort = () => {
            const index = acceptWaiters.indexOf(waiter);
            if (index !== -1) acceptWaiters.splice(index, 1);
            reject(abortFailure());
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        acceptWaiters.push(waiter);
      });
    },
    async close() {
      if (closed) return;
      if (closePromise !== undefined) return await closePromise;
      closePromise = closeUnixListener();
      try {
        await closePromise;
      } finally {
        if (!closed) closePromise = undefined;
      }
    },
  };

  async function closeUnixListener(): Promise<void> {
    acceptingConnections = false;
    const cleanupErrors: unknown[] = [];
    let socketIdentityVerified = false;
    const unavailable = new RuntimeEndpointUnavailableError("closed");
    for (const waiter of acceptWaiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      waiter.reject(unavailable);
    }
    const connectionResults = await Promise.allSettled(connections.snapshot().map((connection) => connection.close()));
    cleanupErrors.push(
      ...connectionResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    connections.clear();

    try {
      await assertUnixSocketIfSame(identity.endpoint.address, uid, ownedSocket.dev, ownedSocket.ino, 0o600);
      socketIdentityVerified = true;
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await closeServer(server);
    } catch (error) {
      cleanupErrors.push(error);
      throw new RuntimeEndpointCleanupIncompleteError(cleanupErrors);
    }

    if (socketIdentityVerified) {
      try {
        await unlinkUnixSocketIfSameIfPresent(identity.endpoint.address, uid, ownedSocket.dev, ownedSocket.ino);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    closed = true;
    releaseEndpointLease();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Runtime Unix endpoint closed with cleanup failures.");
    }
  }
}

export class RuntimeConnectionRegistry<TConnection> {
  readonly #maximumConnections: number;
  readonly #active = new Set<TConnection>();
  readonly #queued: TConnection[] = [];

  constructor(maximumConnections: number = RUNTIME_IPC_LIMITS.maxConnections) {
    if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1) {
      throw new RangeError("Runtime connection admission counts are invalid.");
    }
    this.#maximumConnections = maximumConnections;
  }

  tryAdd(connection: TConnection): boolean {
    if (this.#active.has(connection)) return true;
    if (!canAdmitRuntimeConnection(this.#active.size, this.#maximumConnections)) return false;
    this.#active.add(connection);
    return true;
  }

  enqueue(connection: TConnection): void {
    if (!this.#active.has(connection)) {
      throw new Error("Only an active runtime connection can wait for accept.");
    }
    if (!this.#queued.includes(connection)) this.#queued.push(connection);
  }

  takeQueued(): TConnection | undefined {
    return this.#queued.shift();
  }

  release(connection: TConnection): void {
    this.#active.delete(connection);
    const queuedIndex = this.#queued.indexOf(connection);
    if (queuedIndex !== -1) this.#queued.splice(queuedIndex, 1);
  }

  snapshot(): readonly TConnection[] {
    return [...this.#active];
  }

  clear(): void {
    this.#queued.length = 0;
    this.#active.clear();
  }
}

export function canAdmitRuntimeConnection(
  currentConnections: number,
  maximumConnections: number = RUNTIME_IPC_LIMITS.maxConnections,
): boolean {
  if (
    !Number.isSafeInteger(currentConnections) ||
    currentConnections < 0 ||
    !Number.isSafeInteger(maximumConnections) ||
    maximumConnections < 1
  ) {
    throw new RangeError("Runtime connection admission counts are invalid.");
  }
  return currentConnections < maximumConnections;
}

export function createRuntimeSocketConnection(
  socket: Socket,
  principalId: string,
  mode: number,
  onClose: () => void = () => undefined,
): RuntimeEndpointConnection {
  const iterator = socket[Symbol.asyncIterator]();
  let closed = false;
  let reading = false;
  let writing = false;
  let closeNotified = false;
  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    onClose();
  };
  socket.once("close", () => {
    closed = true;
    notifyClose();
  });
  return {
    peerPrincipalId: principalId,
    endpointSecurity: { daclSddl: "", unixMode: mode },
    async read(signal) {
      if (closed) return null;
      if (reading) throw new Error("Concurrent runtime socket reads are not allowed.");
      if (signal?.aborted) throw abortFailure();
      reading = true;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        socket.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const next = await iterator.next();
        if (aborted) throw abortFailure();
        return next.done ? null : Uint8Array.from(next.value as Uint8Array);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        reading = false;
      }
    },
    async write(bytes, signal) {
      if (closed) throw new RuntimeEndpointUnavailableError("closed");
      if (writing) throw new Error("Concurrent runtime socket writes are not allowed.");
      if (signal?.aborted) throw abortFailure();
      writing = true;
      try {
        await writeSocket(socket, bytes, signal);
      } catch (error) {
        if (signal?.aborted) {
          closed = true;
          socket.destroy();
        }
        throw error;
      } finally {
        writing = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      socket.destroy();
      notifyClose();
    },
  };
}

function waitForSocketConnect(
  socket: Socket,
  options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("Runtime socket connection timeout is invalid.");
  }
  if (options.signal?.aborted) return Promise.reject(abortFailure());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new RuntimeEndpointUnavailableError("timeout")), options.timeoutMs);
    timer.unref();
    const onConnect = () => finish();
    const onError = (error: unknown) => finish(classifyRuntimeSocketConnectError(error));
    const onAbort = () => finish(abortFailure());
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

export function classifyRuntimeSocketConnectError(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as Readonly<{ code?: unknown }>).code === "ENOENT" ||
      (error as Readonly<{ code?: unknown }>).code === "ECONNREFUSED")
  ) {
    return new RuntimeEndpointUnavailableError("absent");
  }
  return error;
}

function writeSocket(socket: Socket, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      socket.destroy();
      finish(abortFailure());
    };
    const onError = (error: unknown) => finish(error);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", onError);
    socket.write(bytes, () => finish());
  });
}

function listenUnixServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => finish();
    const onError = (error: unknown) => finish(error);
    const finish = (error?: unknown) => {
      server.off("listening", onListening);
      server.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function removeStaleUnixSocket(socketPath: string, uid: number): Promise<void> {
  let first;
  try {
    first = await lstat(socketPath, { bigint: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  validateUnixArtifactSecurity(
    {
      uid: Number(first.uid),
      mode: Number(first.mode),
      kind: first.isSocket() ? "socket" : first.isDirectory() ? "directory" : "file",
      symbolicLink: first.isSymbolicLink(),
    },
    { uid, permissions: 0o600, kind: "socket" },
  );
  await unlinkUnixSocketIfSame(socketPath, uid, first.dev, first.ino);
}

async function unlinkUnixSocketIfSame(
  socketPath: string,
  uid: number,
  expectedDevice: bigint,
  expectedInode: bigint,
  expectedPermissions: number | undefined = 0o600,
): Promise<void> {
  await assertUnixSocketIfSame(socketPath, uid, expectedDevice, expectedInode, expectedPermissions);
  await unlink(socketPath);
}

async function assertUnixSocketIfSame(
  socketPath: string,
  uid: number,
  expectedDevice: bigint,
  expectedInode: bigint,
  expectedPermissions: number | undefined,
): Promise<void> {
  const current = await lstat(socketPath, { bigint: true });
  if (expectedPermissions === undefined) assertOwnedUnixSocket(current, uid);
  else
    validateUnixArtifactSecurity(
      {
        uid: Number(current.uid),
        mode: Number(current.mode),
        kind: current.isSocket() ? "socket" : current.isDirectory() ? "directory" : "file",
        symbolicLink: current.isSymbolicLink(),
      },
      { uid, permissions: expectedPermissions, kind: "socket" },
    );
  if (current.dev !== expectedDevice || current.ino !== expectedInode) {
    throw new Error("Runtime socket identity changed before cleanup.");
  }
}

async function unlinkUnixSocketIfSameIfPresent(
  socketPath: string,
  uid: number,
  expectedDevice: bigint,
  expectedInode: bigint,
  expectedPermissions: number | undefined = 0o600,
): Promise<void> {
  try {
    await unlinkUnixSocketIfSame(socketPath, uid, expectedDevice, expectedInode, expectedPermissions);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function assertOwnedUnixSocket(metadata: BigIntStats, uid: number): void {
  if (metadata.isSymbolicLink() || !metadata.isSocket() || Number(metadata.uid) !== uid) {
    throw new Error("Unix runtime artifact is not securely owned.");
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "ENOENT"
  );
}

function abortFailure(): Error {
  const error = new Error("Runtime endpoint operation was aborted.");
  error.name = "AbortError";
  return error;
}
