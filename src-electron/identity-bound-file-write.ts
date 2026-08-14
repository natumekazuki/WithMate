import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import type { Writable } from "node:stream";

const WORKER_SOURCE = String.raw`
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, mkdir, open, realpath, link, stat } = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const options = JSON.parse(process.env.WITHMATE_IDENTITY_WRITE_OPTIONS);
const control = readline.createInterface({ input: createReadStream(null, { fd: 3 }) });
const commands = [];
const waiters = [];
let published = false;

control.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter(line);
  else commands.push(line);
});

function waitCommand(expected) {
  return new Promise((resolve, reject) => {
    const receive = (value) => value === expected
      ? resolve()
      : reject(Object.assign(new Error("invalid worker command"), { code: "RUNTIME_UNAVAILABLE" }));
    const command = commands.shift();
    if (command !== undefined) receive(command);
    else waiters.push(receive);
  });
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityMatches(stats, device, inode) {
  return String(stats.dev) === device && String(stats.ino) === inode;
}

function filePrecondition(file) {
  return file ? {
    kind: "file",
    sha256: file.digest,
    byteLength: file.stats.size,
    device: String(file.stats.dev),
    inode: String(file.stats.ino),
  } : { kind: "absent" };
}

function matchesPrecondition(file, expected) {
  if (expected.kind === "absent") return !file;
  return Boolean(file && file.digest === expected.sha256 && file.stats.size === expected.byteLength
    && identityMatches(file.stats, expected.device, expected.inode));
}

async function inspectFile(filePath, expectedDigest, expectedBytes, expectedDevice, expectedInode) {
  try {
    const lexical = await lstat(filePath);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    const handle = await open(filePath, "r");
    try {
      const before = await handle.stat();
      if (expectedBytes !== undefined && before.size !== expectedBytes) return null;
      if (expectedDevice !== undefined && expectedInode !== undefined
        && !identityMatches(before, expectedDevice, expectedInode)) return null;
      const real = await realpath(filePath);
      const current = await stat(real);
      if (!sameIdentity(before, current)) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
      }
      const contentDigest = hash.digest("hex");
      if (expectedDigest !== undefined && contentDigest !== expectedDigest) return null;
      return { stats: after, digest: contentDigest };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveDirectories(segments, create) {
  for (const segment of segments) {
    if (create) {
      try { await mkdir(segment); } catch (error) { if (!error || error.code !== "EEXIST") throw error; }
    }
    const lexical = await lstat(segment);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    process.chdir(segment);
    const bound = await stat(".");
    if (!sameIdentity(lexical, bound)) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
  }
  return ".";
}

async function publish(targetPath, tempPath, staged, interactive = true) {
  if (options.replace) {
    if (staged.targetPrecondition.kind === "file") {
      throw Object.assign(new Error("safe replacement is unavailable"), { code: "REPLACE_UNAVAILABLE" });
    }
    const publishPath = tempPath + ".publish";
    try {
      await link(tempPath, publishPath);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const publishProof = await inspectFile(
        publishPath,
        staged.digest,
        staged.stats.size,
        String(staged.stats.dev),
        String(staged.stats.ino),
      );
      if (!publishProof) throw Object.assign(new Error("publish proof collision"), { code: "PATH_CHANGED" });
    }
    if (interactive) {
      send({ type: "proof-linked" });
      await waitCommand("continue");
    }
    if (interactive) {
      send({ type: "target-claimed" });
      await waitCommand("continue-target-claim");
    }
    try {
      await link(publishPath, targetPath);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw Object.assign(new Error("target changed while publishing replacement"), { code: "PATH_CHANGED" });
      }
      throw error;
    }
    published = true;
  } else {
    try { await link(tempPath, targetPath); }
    catch (error) {
      if (error && error.code === "EEXIST") throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });
      throw error;
    }
    published = true;
  }
  const result = await inspectFile(
    targetPath,
    staged.digest,
    staged.stats.size,
    String(staged.stats.dev),
    String(staged.stats.ino),
  );
  const proof = await inspectFile(
    tempPath,
    staged.digest,
    staged.stats.size,
    String(staged.stats.dev),
    String(staged.stats.ino),
  );
  if (!result || !proof || !sameIdentity(proof.stats, result.stats)) {
    throw Object.assign(new Error("publish verification failed"), { code: "RUNTIME_UNAVAILABLE" });
  }
  result.targetPrecondition = staged.targetPrecondition;
  return result;
}

async function stage(targetPath, tempPath) {
  const target = await inspectFile(targetPath);
  if (target && !options.replace) throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });
  if (target && options.replace) {
    throw Object.assign(new Error("safe replacement is unavailable"), { code: "REPLACE_UNAVAILABLE" });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > options.byteLength) throw Object.assign(new Error("content length mismatch"), { code: "PATH_CHANGED" });
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (content.length !== options.byteLength || digest(content) !== options.contentDigest) {
    throw Object.assign(new Error("content digest mismatch"), { code: "PATH_CHANGED" });
  }
  let temp = await inspectFile(tempPath);
  if (temp && (!options.resumed || temp.digest !== options.contentDigest || temp.stats.size !== options.byteLength)) {
    throw Object.assign(new Error("temp collision"), { code: "PATH_CHANGED" });
  }
  if (!temp) {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const staged = await inspectFile(tempPath, options.contentDigest, options.byteLength);
  if (!staged) throw Object.assign(new Error("stage verification failed"), { code: "PATH_CHANGED" });
  staged.targetPrecondition = filePrecondition(target);
  send({
    type: "prepared",
    sha256: staged.digest,
    byteLength: staged.stats.size,
    device: String(staged.stats.dev),
    inode: String(staged.stats.ino),
    targetPrecondition: staged.targetPrecondition,
  });
  await waitCommand("publish");
  return publish(targetPath, tempPath, staged);
}

async function recover(targetPath, tempPath) {
  await waitCommand("start");
  const expected = options.prepared;
  const target = await inspectFile(targetPath, expected.sha256, expected.byteLength, expected.device, expected.inode);
  let temp = await inspectFile(tempPath, expected.sha256, expected.byteLength, expected.device, expected.inode);
  const publishPath = tempPath + ".publish";
  const currentTarget = await inspectFile(targetPath);
  const publishProof = await inspectFile(
    publishPath,
    expected.sha256,
    expected.byteLength,
    expected.device,
    expected.inode,
  );
  if (target && temp && sameIdentity(target.stats, temp.stats)) return target;
  if (temp && publishProof && sameIdentity(temp.stats, publishProof.stats)) {
    temp.targetPrecondition = expected.targetPrecondition;
    return publish(targetPath, tempPath, temp, false);
  }
  if (temp && matchesPrecondition(currentTarget, expected.targetPrecondition)) {
    temp.targetPrecondition = expected.targetPrecondition;
    return publish(targetPath, tempPath, temp, false);
  }
  if (target && !temp) {
    const occupant = await inspectFile(tempPath);
    if (occupant) throw Object.assign(new Error("prepared proof collision"), { code: "PATH_CHANGED" });
    await link(targetPath, tempPath);
    temp = await inspectFile(tempPath, expected.sha256, expected.byteLength, expected.device, expected.inode);
    if (!temp || !sameIdentity(target.stats, temp.stats)) {
      throw Object.assign(new Error("prepared proof recovery failed"), { code: "RUNTIME_UNAVAILABLE" });
    }
    return target;
  }
  if (await inspectFile(targetPath)) {
    throw Object.assign(new Error("target changed after output preparation"), { code: "PATH_CHANGED" });
  }
  if (!temp) throw Object.assign(new Error("prepared output missing"), { code: "NOT_RECOVERABLE" });
  temp.targetPrecondition = expected.targetPrecondition;
  return publish(targetPath, tempPath, temp, false);
}

async function main() {
  const rootStats = await stat(".");
  send({ type: "ready", device: rootStats.dev, inode: rootStats.ino });
  const segments = options.relativePath.split("/");
  const fileName = segments.pop();
  if (options.action === "cleanup") {
    await waitCommand("start");
    // Node does not expose an identity-bound unlink primitive on Windows. Leave
    // operation-owned proofs in place rather than deleting a path that may have
    // been replaced after verification.
    return { cleaned: true };
  }
  const parent = await resolveDirectories(segments, options.action === "write");
  const targetPath = path.join(parent, fileName);
  const tempPath = path.join(parent, options.tempName);
  const result = options.action === "recover"
    ? await recover(targetPath, tempPath)
    : await stage(targetPath, tempPath);
  return {
    sha256: result.digest,
    byteLength: result.stats.size,
    modifiedAt: result.stats.mtime.toISOString(),
    device: String(result.stats.dev),
    inode: String(result.stats.ino),
    targetPrecondition: result.targetPrecondition ?? options.prepared.targetPrecondition,
  };
}

main().then((result) => {
  send(result.cleaned ? { type: "cleaned" } : { type: "result", ...result });
}).catch((error) => {
  send({
    type: "failure",
    code: error && typeof error.code === "string" ? error.code : "RUNTIME_UNAVAILABLE",
    published,
  });
  process.exitCode = 1;
});
`;

export type IdentityBoundFilePrepared = {
  sha256: string;
  byteLength: number;
  device: string;
  inode: string;
  targetPrecondition:
    | { kind: "absent" }
    | { kind: "file"; sha256: string; byteLength: number; device: string; inode: string };
};

export type IdentityBoundFileWriteInput = {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  content: Uint8Array;
  contentDigest: string;
  tempName: string;
  replace: boolean;
  resumed: boolean;
  prepared?: IdentityBoundFilePrepared | null;
  onIdentityBound?: () => void;
  onPrepared?: (prepared: IdentityBoundFilePrepared) => void | Promise<void>;
  onAfterReplaceProof?: () => void;
  onAfterReplaceTargetClaim?: () => void;
  timeoutMs?: number;
};

export type IdentityBoundFileWriteResult = IdentityBoundFilePrepared & {
  modifiedAt: string;
};

export class IdentityBoundFileWriteError extends Error {
  constructor(
    readonly code: string,
    readonly effect: "not_applied" | "indeterminate",
  ) {
    super(code);
    this.name = "IdentityBoundFileWriteError";
  }
}

type WorkerMessage =
  | { type: "ready"; device: number; inode: number }
  | ({ type: "prepared" } & IdentityBoundFilePrepared)
  | ({ type: "result" } & IdentityBoundFileWriteResult)
  | { type: "proof-linked" }
  | { type: "target-claimed" }
  | { type: "cleaned" }
  | { type: "failure"; code: string; published: boolean };

type WorkerExecutionInput = {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  tempName: string;
  action: "write" | "recover" | "cleanup";
  content?: Uint8Array;
  contentDigest?: string;
  replace?: boolean;
  resumed?: boolean;
  prepared?: IdentityBoundFilePrepared | null;
  onIdentityBound?: () => void;
  onPrepared?: (prepared: IdentityBoundFilePrepared) => void | Promise<void>;
  onAfterReplaceProof?: () => void;
  onAfterReplaceTargetClaim?: () => void;
  timeoutMs?: number;
};

function executeIdentityBoundWorker(input: WorkerExecutionInput): Promise<IdentityBoundFileWriteResult | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
      cwd: input.rootPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WITHMATE_IDENTITY_WRITE_OPTIONS: JSON.stringify({
          action: input.action,
          relativePath: input.relativePath,
          byteLength: input.content?.byteLength ?? 0,
          contentDigest: input.contentDigest,
          tempName: input.tempName,
          replace: input.replace,
          resumed: input.resumed,
          prepared: input.prepared,
        }),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const control = child.stdio[3] as Writable | null;
    let stdout = "";
    let stderr = "";
    let result: IdentityBoundFileWriteResult | null = null;
    let cleaned = false;
    let failure: unknown = null;
    let transportError: unknown = null;
    let sentMutation = false;
    let ready = false;
    let settled = false;
    const timeout = setTimeout(() => {
      failure = new IdentityBoundFileWriteError(
        "RUNTIME_UNAVAILABLE",
        sentMutation ? "indeterminate" : "not_applied",
      );
      child.kill();
    }, input.timeoutMs ?? 30_000);

    const fail = (error: unknown, effect: "not_applied" | "indeterminate" = "not_applied") => {
      if (failure) return;
      failure = error instanceof IdentityBoundFileWriteError
        ? error
        : new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", effect);
      child.kill();
    };

    const sendControl = (command: string) => {
      if (!control?.writable) return fail(undefined, sentMutation ? "indeterminate" : "not_applied");
      sentMutation = true;
      control.write(`${command}\n`);
    };

    const consume = () => {
      while (true) {
        const index = stdout.indexOf("\n");
        if (index < 0) return;
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message: WorkerMessage;
        try {
          message = JSON.parse(line) as WorkerMessage;
        } catch {
          fail(undefined, sentMutation ? "indeterminate" : "not_applied");
          return;
        }
        if (message.type === "ready") {
          if (ready || message.device !== input.rootStats.dev || message.inode !== input.rootStats.ino) {
            fail(new IdentityBoundFileWriteError("PATH_CHANGED", "not_applied"));
            continue;
          }
          ready = true;
          try {
            input.onIdentityBound?.();
            if (input.action === "write") {
              sentMutation = true;
              child.stdin.end(input.content ?? new Uint8Array());
            } else {
              child.stdin.end();
              sendControl("start");
            }
          } catch (error) {
            fail(error, sentMutation ? "indeterminate" : "not_applied");
          }
        } else if (message.type === "prepared") {
          void Promise.resolve(input.onPrepared?.({
            sha256: message.sha256,
            byteLength: message.byteLength,
            device: message.device,
            inode: message.inode,
            targetPrecondition: message.targetPrecondition,
          })).then(
            () => sendControl("publish"),
            (error) => fail(error, "indeterminate"),
          );
        } else if (message.type === "result") {
          result = message;
          control?.end();
        } else if (message.type === "proof-linked") {
          try {
            input.onAfterReplaceProof?.();
            sendControl("continue");
          } catch (error) {
            fail(error, "indeterminate");
          }
        } else if (message.type === "target-claimed") {
          try {
            input.onAfterReplaceTargetClaim?.();
            sendControl("continue-target-claim");
          } catch (error) {
            fail(error, "indeterminate");
          }
        } else if (message.type === "cleaned") {
          cleaned = true;
          control?.end();
        } else {
          const effect = message.code === "REPLACE_UNAVAILABLE"
            ? "not_applied"
            : message.published || sentMutation ? "indeterminate" : "not_applied";
          failure = new IdentityBoundFileWriteError(
            message.code,
            effect,
          );
          control?.end();
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; consume(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", (error) => { transportError ??= error; });
    control?.on("error", (error) => { transportError ??= error; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      consume();
      if (failure) return reject(failure);
      if (code === 0 && ready && result) return resolve(result);
      if (code === 0 && ready && cleaned) return resolve(null);
      reject(new IdentityBoundFileWriteError(
        stderr.trim() || (transportError instanceof Error ? transportError.message : "RUNTIME_UNAVAILABLE"),
        sentMutation ? "indeterminate" : "not_applied",
      ));
    });
  });
}

export async function writeIdentityBoundFile(input: IdentityBoundFileWriteInput): Promise<IdentityBoundFileWriteResult> {
  const result = await executeIdentityBoundWorker({
    ...input,
    action: input.prepared ? "recover" : "write",
  });
  if (!result) throw new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", "not_applied");
  return result;
}

export async function cleanupIdentityBoundFileWrite(input: {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  tempName: string;
  prepared: IdentityBoundFilePrepared;
}): Promise<void> {
  await executeIdentityBoundWorker({
    ...input,
    action: "cleanup",
  });
}
