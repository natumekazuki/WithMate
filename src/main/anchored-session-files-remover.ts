import { spawn } from "node:child_process";

const SAFE_FILESYSTEM_CODES = [
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EINVAL",
  "EISDIR",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "UNKNOWN",
] as const;
const ROOT_MISMATCHES = ["canonical_root", "application_entry", "root_entry", "device", "inode", "birthtime"] as const;

const HELPER_SOURCE = String.raw`
const fs = require("node:fs");
const safeFilesystemCodes = new Set(${JSON.stringify(SAFE_FILESYSTEM_CODES)});

const expectedApplicationDirectory = process.argv[1];
const expectedApplicationIdentity = {
  device: process.argv[2],
  inode: process.argv[3],
  birthtimeNanoseconds: process.argv[4],
};
const expectedRoot = process.argv[5];
const expectedIdentity = {
  device: process.argv[6],
  inode: process.argv[7],
  birthtimeNanoseconds: process.argv[8],
};
const actualRoot = fs.realpathSync(".");
const actualStats = fs.statSync(".", { bigint: true });
const expectedApplicationEntryStats = fs.lstatSync(expectedApplicationDirectory, { bigint: true });
const expectedRootEntryStats = fs.lstatSync(expectedRoot, { bigint: true });
const actualIdentity = {
  device: actualStats.dev.toString(),
  inode: actualStats.ino.toString(),
  birthtimeNanoseconds: actualStats.birthtimeNs.toString(),
};
const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
const isExpectedPlainDirectory = (stats, identity) =>
  !stats.isSymbolicLink() &&
  stats.isDirectory() &&
  stats.dev.toString() === identity.device &&
  stats.ino.toString() === identity.inode &&
  stats.birthtimeNs.toString() === identity.birthtimeNanoseconds;
const sendAndExit = (message, code) => {
  if (process.send) process.send(message);
  setTimeout(() => process.exit(code), 10);
};
process.once("disconnect", () => process.exit(1));

const canonicalRootMismatch = normalize(actualRoot) !== normalize(expectedRoot);
const expectedApplicationEntryMismatch = !isExpectedPlainDirectory(
  expectedApplicationEntryStats,
  expectedApplicationIdentity,
);
const expectedRootEntryMismatch = !isExpectedPlainDirectory(expectedRootEntryStats, expectedIdentity);
const identityMismatches = [];
if (actualIdentity.device !== expectedIdentity.device) identityMismatches.push("device");
if (actualIdentity.inode !== expectedIdentity.inode) identityMismatches.push("inode");
if (actualIdentity.birthtimeNanoseconds !== expectedIdentity.birthtimeNanoseconds) {
  identityMismatches.push("birthtime");
}

if (expectedApplicationEntryMismatch || expectedRootEntryMismatch || identityMismatches.length > 0) {
  // realpathの文字列表現はWindowsのprocess間で揺れるため、plain owner entryとdirectory identityで判定する。
  sendAndExit({
    type: "unsafe_root",
    mismatches: [
      ...(canonicalRootMismatch ? ["canonical_root"] : []),
      ...(expectedApplicationEntryMismatch ? ["application_entry"] : []),
      ...(expectedRootEntryMismatch ? ["root_entry"] : []),
      ...identityMismatches,
    ],
  }, 2);
} else {
  if (process.send) process.send({ type: "ready" });
  process.once("message", (message) => {
    try {
      if (
        message === null ||
        typeof message !== "object" ||
        message.type !== "delete" ||
        typeof message.sessionId !== "string" ||
        !/^session_[0-9a-f]{96}$/.test(message.sessionId)
      ) {
        throw new Error("invalid request");
      }
      fs.rmSync(message.sessionId, { recursive: true, force: true, maxRetries: 0 });
      sendAndExit({ type: "completed" }, 0);
    } catch (error) {
      const rawCode =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      const code = safeFilesystemCodes.has(rawCode) ? rawCode : "UNKNOWN";
      sendAndExit({ type: "filesystem_failed", code }, 1);
    }
  });
}
`;

export type AnchoredSessionFilesRemoveHook = () => void | Promise<void>;
export type SessionFilesRootIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNanoseconds: string;
}>;

type SafeFilesystemCode = (typeof SAFE_FILESYSTEM_CODES)[number];
type RootMismatch = (typeof ROOT_MISMATCHES)[number];
export type AnchoredSessionFilesRemoveDiagnostic =
  | Readonly<{ kind: "helper_start_failed" }>
  | Readonly<{ kind: "unsafe_root"; mismatches: readonly RootMismatch[] }>
  | Readonly<{ kind: "filesystem_failed"; code: SafeFilesystemCode }>
  | Readonly<{ kind: "invalid_response" }>;

export class AnchoredSessionFilesRemoveError extends Error {
  readonly diagnostic: AnchoredSessionFilesRemoveDiagnostic;

  constructor(message: string, diagnostic: AnchoredSessionFilesRemoveDiagnostic) {
    super(message);
    this.diagnostic = Object.freeze(
      diagnostic.kind === "unsafe_root"
        ? { ...diagnostic, mismatches: Object.freeze([...diagnostic.mismatches]) }
        : { ...diagnostic },
    );
  }
}

export async function removeSessionFilesFromAnchoredRoot(
  sessionFilesRoot: string,
  expectedCanonicalApplicationDirectory: string,
  expectedApplicationDirectoryIdentity: SessionFilesRootIdentity,
  expectedCanonicalRoot: string,
  expectedRootIdentity: SessionFilesRootIdentity,
  sessionId: string,
  beforeDelete?: AnchoredSessionFilesRemoveHook,
): Promise<void> {
  // cwdでrootの実体へ固定し、検証後のjunction差し替えで削除先が変わる経路を閉じる。
  const child = spawn(
    process.execPath,
    [
      "-e",
      HELPER_SOURCE,
      expectedCanonicalApplicationDirectory,
      expectedApplicationDirectoryIdentity.device,
      expectedApplicationDirectoryIdentity.inode,
      expectedApplicationDirectoryIdentity.birthtimeNanoseconds,
      expectedCanonicalRoot,
      expectedRootIdentity.device,
      expectedRootIdentity.inode,
      expectedRootIdentity.birthtimeNanoseconds,
    ],
    {
      cwd: sessionFilesRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let responseReceived = false;
    let responseError: Error | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (error === undefined) resolve();
      else reject(error);
    };

    child.once("error", () =>
      finish(
        new AnchoredSessionFilesRemoveError("Session Files cleanup helper failed to start.", {
          kind: "helper_start_failed",
        }),
      ),
    );
    child.once("exit", (code) => {
      if (settled) return;
      if (responseReceived) finish(responseError);
      else
        finish(
          new AnchoredSessionFilesRemoveError(
            code === 2 ? "Session Files root changed before cleanup." : "Session Files cleanup failed.",
            code === 2 ? { kind: "unsafe_root", mismatches: [] } : { kind: "filesystem_failed", code: "UNKNOWN" },
          ),
        );
    });
    child.on("message", (message: unknown) => {
      if (message === null || typeof message !== "object" || !("type" in message)) {
        finish(
          new AnchoredSessionFilesRemoveError("Session Files cleanup helper returned an invalid response.", {
            kind: "invalid_response",
          }),
        );
        return;
      }
      const type = (message as Readonly<{ type?: unknown }>).type;
      if (type === "unsafe_root") {
        responseReceived = true;
        const mismatches = (message as Readonly<{ mismatches?: unknown }>).mismatches;
        const safeMismatches = isRootMismatchList(mismatches) ? mismatches : [];
        responseError = new AnchoredSessionFilesRemoveError(
          safeMismatches.length > 0
            ? `Session Files root changed before cleanup (${safeMismatches.join(", ")}).`
            : "Session Files root changed before cleanup.",
          { kind: "unsafe_root", mismatches: safeMismatches },
        );
        return;
      }
      if (type === "filesystem_failed") {
        responseReceived = true;
        const rawCode = (message as Readonly<{ code?: unknown }>).code;
        const code = isSafeFilesystemCode(rawCode) ? rawCode : "UNKNOWN";
        responseError = new AnchoredSessionFilesRemoveError(`Session Files cleanup failed (${code}).`, {
          kind: "filesystem_failed",
          code,
        });
        return;
      }
      if (type === "completed") {
        responseReceived = true;
        return;
      }
      if (type !== "ready" || ready) {
        responseReceived = true;
        responseError = new AnchoredSessionFilesRemoveError(
          "Session Files cleanup helper returned an invalid response.",
          { kind: "invalid_response" },
        );
        child.kill();
        return;
      }
      ready = true;
      Promise.resolve()
        .then(() => beforeDelete?.())
        .then(() => {
          if (!settled) child.send({ type: "delete", sessionId });
        })
        .catch(() => {
          if (!settled) child.send({ type: "cancel" });
        });
    });
  });
}

function isRootMismatchList(value: unknown): value is RootMismatch[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((mismatch) => typeof mismatch === "string" && ROOT_MISMATCHES.includes(mismatch as RootMismatch))
  );
}

function isSafeFilesystemCode(value: unknown): value is SafeFilesystemCode {
  return typeof value === "string" && SAFE_FILESYSTEM_CODES.includes(value as SafeFilesystemCode);
}
