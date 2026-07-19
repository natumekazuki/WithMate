import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, link, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

type HelperResult =
  | Readonly<{ status: "published"; cleanupPending: boolean }>
  | Readonly<{ status: "unknown" }>
  | Readonly<{
      status: "not_published";
      code: "destination_exists" | "destination_invalid" | "integrity_mismatch" | "filesystem_failure";
      temporaryCleanup: "complete" | "pending";
    }>;

class IntegrityMismatchError extends Error {}
class ParentIdentityError extends Error {}
class ExportAbortedError extends Error {}

const [temporaryName, destinationName, requestedParent, expectedLengthRaw, expectedHash] = process.argv.slice(2);

let published = false;
let publicationMayHaveOccurred = false;
let temporaryCreated = false;
let temporaryIdentity: FileIdentity | undefined;
let aborted = false;
const control = createReadStream("", { fd: 3 });
control.setEncoding("utf8");
control.on("data", (value) => {
  if (value.toString().includes("abort")) aborted = true;
});

try {
  if (
    !isLocalName(temporaryName) ||
    !isLocalName(destinationName) ||
    temporaryName === destinationName ||
    requestedParent === undefined ||
    !path.isAbsolute(requestedParent) ||
    !/^(0|[1-9][0-9]*)$/u.test(expectedLengthRaw ?? "") ||
    !/^[0-9a-f]{64}$/u.test(expectedHash ?? "")
  ) {
    await sendResult({ status: "not_published", code: "destination_invalid", temporaryCleanup: "complete" });
  } else {
    const expectedLength = Number(expectedLengthRaw);
    if (!Number.isSafeInteger(expectedLength)) {
      await sendResult({ status: "not_published", code: "destination_invalid", temporaryCleanup: "complete" });
    } else {
      const { canonicalParent, expectedDevice, expectedInode } = await anchorParent(requestedParent);
      if (await destinationExists(destinationName)) {
        await sendResult({ status: "not_published", code: "destination_exists", temporaryCleanup: "complete" });
      } else {
        const temporary = await open(temporaryName, "wx", 0o600);
        temporaryCreated = true;
        temporaryIdentity = fileIdentity(await temporary.stat());
        const hash = createHash("sha256");
        let byteLength = 0;
        await send({ phase: "ready" });
        try {
          for await (const chunk of process.stdin) {
            if (aborted) throw new ExportAbortedError();
            const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
            await writeAll(temporary, bytes);
            hash.update(bytes);
            byteLength += bytes.byteLength;
            if (byteLength > expectedLength) throw new IntegrityMismatchError();
          }
          if (aborted) throw new ExportAbortedError();
          await temporary.sync();
          if (byteLength !== expectedLength || hash.digest("hex") !== expectedHash) {
            throw new IntegrityMismatchError();
          }
          await assertParentIdentity(canonicalParent, expectedDevice, expectedInode);
          await assertPathIdentity(temporaryName, temporaryIdentity);
          if (aborted) throw new ExportAbortedError();
          await send({ phase: "publishing" });
          await link(temporaryName, destinationName);
          publicationMayHaveOccurred = true;
          await assertPathIdentity(destinationName, temporaryIdentity);
          await assertParentIdentity(canonicalParent, expectedDevice, expectedInode);
          published = true;
        } finally {
          await temporary.close();
        }
        const cleanupPending = (await cleanupTemporary(temporaryName, temporaryIdentity)) === "pending";
        temporaryCreated = cleanupPending;
        await sendResult({ status: "published", cleanupPending });
      }
    }
  }
} catch (error) {
  if (temporaryCreated && temporaryName !== undefined && temporaryIdentity !== undefined) {
    temporaryCreated = (await cleanupTemporary(temporaryName, temporaryIdentity)) === "pending";
  }
  const result: HelperResult = published
    ? { status: "published", cleanupPending: temporaryCreated }
    : publicationMayHaveOccurred
      ? { status: "unknown" }
      : {
          status: "not_published",
          code:
            error instanceof IntegrityMismatchError
              ? "integrity_mismatch"
              : isErrorCode(error, "EEXIST")
                ? "destination_exists"
                : error instanceof ParentIdentityError
                  ? "destination_invalid"
                  : "filesystem_failure",
          temporaryCleanup: temporaryCreated ? "pending" : "complete",
        };
  await sendResult(result);
}

async function assertParentIdentity(parent: string, device: string, inode: string): Promise<void> {
  const [currentDirectory, grantedDirectory, currentStats, grantedStats] = await Promise.all([
    realpath("."),
    realpath(parent),
    stat("."),
    stat(parent),
  ]);
  if (
    pathIdentity(currentDirectory) !== pathIdentity(grantedDirectory) ||
    String(currentStats.dev) !== device ||
    String(currentStats.ino) !== inode ||
    String(grantedStats.dev) !== device ||
    String(grantedStats.ino) !== inode
  ) {
    throw new ParentIdentityError();
  }
}

async function anchorParent(
  requestedParent: string,
): Promise<Readonly<{ canonicalParent: string; expectedDevice: string; expectedInode: string }>> {
  try {
    const canonicalParent = await realpath(requestedParent);
    const parentStats = await stat(canonicalParent);
    if (!parentStats.isDirectory()) throw new ParentIdentityError();
    const expectedDevice = String(parentStats.dev);
    const expectedInode = String(parentStats.ino);
    process.chdir(canonicalParent);
    await assertParentIdentity(canonicalParent, expectedDevice, expectedInode);
    return { canonicalParent, expectedDevice, expectedInode };
  } catch (error) {
    if (error instanceof ParentIdentityError) throw error;
    throw new ParentIdentityError();
  }
}

async function destinationExists(name: string): Promise<boolean> {
  try {
    await lstat(name);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

type FileIdentity = Readonly<{ device: string; inode: string }>;

async function assertPathIdentity(name: string, expected: FileIdentity): Promise<void> {
  const actual = fileIdentity(await lstat(name));
  if (actual.device !== expected.device || actual.inode !== expected.inode) throw new ParentIdentityError();
}

async function cleanupTemporary(name: string, expected: FileIdentity): Promise<"complete" | "pending"> {
  try {
    const actual = fileIdentity(await lstat(name));
    if (actual.device !== expected.device || actual.inode !== expected.inode) return "complete";
    await unlink(name);
    return "complete";
  } catch (error) {
    return isErrorCode(error, "ENOENT") ? "complete" : "pending";
  }
}

function fileIdentity(stats: Readonly<{ dev: number | bigint; ino: number | bigint }>): FileIdentity {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Temporary output write made no progress.");
    offset += bytesWritten;
  }
}

function isLocalName(value: string | undefined): value is string {
  return value !== undefined && value !== "" && value !== "." && value !== ".." && path.basename(value) === value;
}

function pathIdentity(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function send(value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (process.stdout.write(line)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
}

async function sendResult(result: HelperResult): Promise<void> {
  await send({ result });
}
