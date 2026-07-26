import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { resolveApplicationDataRoot, resolveWithMateApplicationDirectory } from "../application-data-path.js";
import { RUNTIME_IPC_PROTOCOL_FAMILY } from "./runtime-ipc-common.js";
import { getCurrentWindowsPrincipalSid, isWindowsReparsePoint } from "./runtime-windows-native.js";

const DATABASE_FILE_NAME = "withmate.sqlite3";
const SESSION_FILES_DIRECTORY_NAME = "session-files";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\WithMateRuntime-";
const WINDOWS_CLAIM_PREFIX = "Global\\WithMateRuntime-";

export type RuntimeEndpointDescriptor =
  | Readonly<{
      platform: "win32";
      address: string;
      claimName: string;
    }>
  | Readonly<{
      platform: "unix";
      address: string;
      claimPath: string;
      runtimeDirectory: string;
    }>;

export type RuntimeOwnerIdentity = Readonly<{
  principalId: string;
  applicationDirectory: string;
  applicationDirectoryIdentity: string;
  databasePath: string;
  sessionFilesRoot: string;
  endpointId: string;
  endpoint: RuntimeEndpointDescriptor;
}>;

export type UnixArtifactSnapshot = Readonly<{
  uid: number;
  mode: number;
  kind: "directory" | "file" | "socket";
  symbolicLink: boolean;
}>;

export type ResolveRuntimeOwnerIdentityOptions = Readonly<{
  applicationDataRoot?: string;
}>;

export async function resolveRuntimeOwnerIdentity(
  options: ResolveRuntimeOwnerIdentityOptions = {},
): Promise<RuntimeOwnerIdentity> {
  const applicationDataRoot = options.applicationDataRoot;
  const requestedDirectory = resolveWithMateApplicationDirectory(applicationDataRoot ?? resolveApplicationDataRoot());
  await mkdir(requestedDirectory, { recursive: true, ...(process.platform === "win32" ? {} : { mode: 0o700 }) });

  const requestedMetadata = await lstat(requestedDirectory);
  if (
    !requestedMetadata.isDirectory() ||
    requestedMetadata.isSymbolicLink() ||
    (process.platform === "win32" && isWindowsReparsePoint(requestedDirectory))
  ) {
    throw new Error("Runtime application directory is not a canonical owned directory.");
  }

  const applicationDirectory = normalizeCanonicalPath(await realpath(requestedDirectory));
  const canonicalMetadata = await lstat(applicationDirectory);
  if (
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink() ||
    (process.platform === "win32" && isWindowsReparsePoint(applicationDirectory))
  ) {
    throw new Error("Runtime application directory is not a canonical owned directory.");
  }

  if (process.platform !== "win32") {
    const uid = currentUnixUid();
    await assertUnixPathSecurity(applicationDirectory, {
      uid,
      permissions: 0o700,
      kind: "directory",
    });
  }

  const storageIdentity = await stat(applicationDirectory, { bigint: true });
  const principalId = process.platform === "win32" ? getCurrentWindowsPrincipalSid() : String(currentUnixUid());
  const applicationDirectoryIdentity = [
    normalizeIdentityPath(applicationDirectory),
    storageIdentity.dev.toString(),
    storageIdentity.ino.toString(),
  ].join("\0");
  const endpointId = createHash("sha256")
    .update(RUNTIME_IPC_PROTOCOL_FAMILY)
    .update("\0")
    .update(principalId)
    .update("\0")
    .update(applicationDirectoryIdentity)
    .digest("hex");
  const endpoint = deriveRuntimeEndpointDescriptor({
    platform: process.platform,
    endpointId,
    principalId,
    applicationDirectory,
  });

  return {
    principalId,
    applicationDirectory,
    applicationDirectoryIdentity,
    databasePath: path.join(applicationDirectory, DATABASE_FILE_NAME),
    sessionFilesRoot: path.join(applicationDirectory, SESSION_FILES_DIRECTORY_NAME),
    endpointId,
    endpoint,
  };
}

export function deriveRuntimeEndpointDescriptor(
  input: Readonly<{
    platform: NodeJS.Platform;
    endpointId: string;
    principalId: string;
    applicationDirectory: string;
  }>,
): RuntimeEndpointDescriptor {
  if (
    !/^[0-9a-f]{64}$/u.test(input.endpointId) ||
    input.principalId.length === 0 ||
    !(input.platform === "win32"
      ? path.win32.isAbsolute(input.applicationDirectory)
      : path.posix.isAbsolute(input.applicationDirectory))
  ) {
    throw new Error("Runtime endpoint identity is invalid.");
  }
  if (input.platform === "win32") {
    const suffix = input.endpointId.slice(0, 48);
    return {
      platform: "win32",
      address: `${WINDOWS_PIPE_PREFIX}${suffix}`,
      claimName: `${WINDOWS_CLAIM_PREFIX}${suffix}`,
    };
  }
  const principalScope = createHash("sha256").update(input.principalId).digest("hex").slice(0, 12);
  const runtimeDirectory = path.posix.join(
    "/tmp",
    `.withmate-runtime-${principalScope}-${input.endpointId.slice(0, 24)}`,
  );
  return {
    platform: "unix",
    runtimeDirectory,
    address: path.posix.join(runtimeDirectory, "runtime.sock"),
    claimPath: path.posix.join(input.applicationDirectory.replaceAll("\\", "/"), ".runtime-owner.lock"),
  };
}

export function validateUnixArtifactSecurity(
  actual: UnixArtifactSnapshot,
  expected: Readonly<{
    uid: number;
    permissions: number;
    kind: UnixArtifactSnapshot["kind"];
  }>,
): void {
  if (
    actual.symbolicLink ||
    actual.uid !== expected.uid ||
    actual.kind !== expected.kind ||
    (actual.mode & 0o777) !== expected.permissions
  ) {
    throw new Error("Unix runtime artifact is not securely owned.");
  }
}

export async function assertUnixPathSecurity(
  artifactPath: string,
  expected: Readonly<{
    uid: number;
    permissions: number;
    kind: UnixArtifactSnapshot["kind"];
  }>,
): Promise<void> {
  const metadata = await lstat(artifactPath);
  validateUnixArtifactSecurity(
    {
      uid: metadata.uid,
      mode: metadata.mode,
      kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "socket",
      symbolicLink: metadata.isSymbolicLink(),
    },
    expected,
  );
}

function normalizeCanonicalPath(value: string): string {
  return process.platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value);
}

function normalizeIdentityPath(value: string): string {
  const normalized = normalizeCanonicalPath(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function currentUnixUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Current Unix principal identity is unavailable.");
  }
  return uid;
}
