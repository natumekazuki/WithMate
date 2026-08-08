import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import koffi from "koffi";

import { type RuntimeOwnerIdentity, validateUnixArtifactSecurity } from "./runtime-owner-identity.js";
import { acquireSecureWindowsMutex } from "./runtime-windows-native.js";

const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const LOCK_UNLOCK = 8;
const activeClaims = new Set<string>();

export type RuntimeOwnerClaim =
  | Readonly<{
      status: "busy";
    }>
  | Readonly<{
      status: "acquired";
      endpointId: string;
      generationId: string;
      holdEndpoint(): () => void;
      release(): Promise<void>;
    }>;

export async function acquireRuntimeOwnerClaim(identity: RuntimeOwnerIdentity): Promise<RuntimeOwnerClaim> {
  const claimKey = identity.endpoint.platform === "win32" ? identity.endpoint.claimName : identity.endpoint.claimPath;
  if (activeClaims.has(claimKey)) return { status: "busy" };

  if (identity.endpoint.platform === "win32") {
    const nativeClaim = acquireSecureWindowsMutex(identity.endpoint.claimName, identity.principalId);
    if (nativeClaim.status === "busy") return { status: "busy" };
    activeClaims.add(claimKey);
    let released = false;
    let endpointLeaseCount = 0;
    return {
      status: "acquired",
      endpointId: identity.endpointId,
      generationId: randomUUID(),
      holdEndpoint() {
        if (released) throw new Error("Runtime owner claim is already released.");
        endpointLeaseCount += 1;
        let returned = false;
        return () => {
          if (returned) return;
          returned = true;
          endpointLeaseCount -= 1;
        };
      },
      async release() {
        if (released) return;
        if (endpointLeaseCount !== 0) {
          throw new Error("Runtime owner claim cannot be released while its endpoint is active.");
        }
        released = true;
        try {
          nativeClaim.release();
        } finally {
          activeClaims.delete(claimKey);
        }
      },
    };
  }

  const uid = currentUnixUid();
  const claimFile = await openUnixClaimFile(identity.endpoint.claimPath, uid);
  let acquired: boolean;
  try {
    acquired = flock(claimFile.fd, LOCK_EXCLUSIVE | LOCK_NONBLOCKING);
  } catch (error) {
    await claimFile.close();
    throw error;
  }
  if (!acquired) {
    await claimFile.close();
    return { status: "busy" };
  }

  activeClaims.add(claimKey);
  let released = false;
  let endpointLeaseCount = 0;
  return {
    status: "acquired",
    endpointId: identity.endpointId,
    generationId: randomUUID(),
    holdEndpoint() {
      if (released) throw new Error("Runtime owner claim is already released.");
      endpointLeaseCount += 1;
      let returned = false;
      return () => {
        if (returned) return;
        returned = true;
        endpointLeaseCount -= 1;
      };
    },
    async release() {
      if (released) return;
      if (endpointLeaseCount !== 0) {
        throw new Error("Runtime owner claim cannot be released while its endpoint is active.");
      }
      released = true;
      try {
        flockOrThrow(claimFile.fd, LOCK_UNLOCK, "Runtime owner claim could not be unlocked.");
      } finally {
        try {
          await claimFile.close();
        } finally {
          activeClaims.delete(claimKey);
        }
      }
    },
  };
}

async function openUnixClaimFile(claimPath: string, uid: number): Promise<FileHandle> {
  const baseFlags = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(claimPath, baseFlags | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (error) {
    if (!isFileAlreadyPresent(error)) throw error;
    handle = await open(claimPath, baseFlags);
  }
  try {
    const metadata = await handle.stat();
    validateUnixArtifactSecurity(
      {
        uid: metadata.uid,
        mode: metadata.mode,
        kind: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "socket",
        symbolicLink: false,
      },
      { uid, permissions: 0o600, kind: "file" },
    );
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isFileAlreadyPresent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "EEXIST"
  );
}

function flock(fileDescriptor: number, operation: number): boolean {
  const native = loadUnixClaimApi();
  if (native.flock(fileDescriptor, operation) === 0) return true;
  const errorCode = koffi.errno();
  if (
    operation === (LOCK_EXCLUSIVE | LOCK_NONBLOCKING) &&
    (errorCode === koffi.os.errno.EAGAIN || errorCode === koffi.os.errno.EWOULDBLOCK)
  ) {
    return false;
  }
  throw new Error(`Runtime owner claim operation failed (errno ${String(errorCode)}).`);
}

function flockOrThrow(fileDescriptor: number, operation: number, message: string): void {
  const native = loadUnixClaimApi();
  if (native.flock(fileDescriptor, operation) !== 0) {
    throw new Error(`${message} (errno ${String(koffi.errno())})`);
  }
}

function currentUnixUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Current Unix principal identity is unavailable.");
  }
  return uid;
}

let cachedUnixClaimApi: ReturnType<typeof createUnixClaimApi> | undefined;

function loadUnixClaimApi() {
  if (process.platform === "win32") throw new Error("Unix runtime owner claims are unavailable.");
  cachedUnixClaimApi ??= createUnixClaimApi();
  return cachedUnixClaimApi;
}

function createUnixClaimApi() {
  const library = koffi.load(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6");
  return {
    flock: library.func("int flock(int, int)"),
  };
}
