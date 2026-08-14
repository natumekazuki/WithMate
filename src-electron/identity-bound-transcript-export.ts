import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Stats } from "node:fs";
import type { Writable } from "node:stream";

const WORKER_SOURCE = String.raw`
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, open, realpath, link, stat } = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const options = JSON.parse(process.env.WITHMATE_TRANSCRIPT_EXPORT_OPTIONS);
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
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
    && String(file.stats.dev) === expected.device && String(file.stats.ino) === expected.inode);
}

async function inspectFile(fileName, expectedDigest, expectedBytes, expectedDevice, expectedInode) {
  try {
    const lexical = await lstat(fileName);
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    }
    const handle = await open(fileName, "r");
    try {
      const before = await handle.stat();
      if (expectedBytes !== undefined && before.size !== expectedBytes) return null;
      if (expectedDevice !== undefined && expectedInode !== undefined
        && (String(before.dev) !== expectedDevice || String(before.ino) !== expectedInode)) return null;
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
      const digest = hash.digest("hex");
      if (expectedDigest !== undefined && digest !== expectedDigest) return null;
      return { stats: after, digest };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function confirmBoundParent(boundStats) {
  const lexical = await lstat(options.parentPath);
  const resolved = await realpath(options.parentPath);
  const current = await stat(resolved);
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || !sameIdentity(lexical, current)
    || !sameIdentity(boundStats, current)) {
    throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
  }
}

async function publish(boundStats, expectedDigest, expectedBytes, targetPrecondition, interactive = true) {
  await confirmBoundParent(boundStats);
  const staged = await inspectFile(options.tempName, expectedDigest, expectedBytes);
  if (!staged) throw Object.assign(new Error("staged output missing"), { code: "NOT_RECOVERABLE" });
  if (options.replace) {
    if (targetPrecondition.kind === "file") {
      throw Object.assign(new Error("safe replacement is unavailable"), { code: "REPLACE_UNAVAILABLE" });
    }
    const publishName = options.tempName + ".publish";
    try {
      await link(options.tempName, publishName);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const publishProof = await inspectFile(publishName, expectedDigest, expectedBytes);
      if (!publishProof || !sameIdentity(publishProof.stats, staged.stats)) {
        throw Object.assign(new Error("publish proof collision"), { code: "PATH_CHANGED" });
      }
    }
    if (interactive) {
      send({ type: "proof-linked" });
      await waitCommand("continue-proof");
    }
    if (interactive) {
      send({ type: "target-claimed" });
      await waitCommand("continue-target-claim");
    }
    try {
      await link(publishName, options.targetName);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw Object.assign(new Error("target changed while publishing replacement"), { code: "PATH_CHANGED" });
      }
      throw error;
    }
    published = true;
    if (interactive) {
      send({ type: "renamed" });
      await waitCommand("continue");
    }
  } else {
    try {
      await link(options.tempName, options.targetName);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });
      }
      throw error;
    }
    published = true;
  }
  const target = await inspectFile(options.targetName, expectedDigest, expectedBytes);
  const proof = await inspectFile(options.tempName, expectedDigest, expectedBytes);
  if (!target || !proof || !sameIdentity(target.stats, staged.stats) || !sameIdentity(proof.stats, target.stats)) {
    throw Object.assign(new Error("publish verification failed"), { code: "RUNTIME_UNAVAILABLE" });
  }
  target.targetPrecondition = targetPrecondition;
  return target;
}

async function stage(boundStats) {
  const target = await inspectFile(options.targetName);
  if (target && !options.replace) {
    throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });
  }
  if (target && options.replace) {
    throw Object.assign(new Error("safe replacement is unavailable"), { code: "REPLACE_UNAVAILABLE" });
  }
  const targetPrecondition = filePrecondition(target);
  let handle;
  try {
    handle = await open(options.tempName, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw Object.assign(new Error("temporary proof already exists"), { code: "PATH_CHANGED" });
    }
    throw error;
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    for await (const chunk of process.stdin) {
      byteLength += chunk.length;
      if (byteLength > options.maxBytes) {
        throw Object.assign(new Error("content too large"), {
          code: "CONTENT_TOO_LARGE",
          actualBytes: byteLength,
        });
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) {
          throw Object.assign(new Error("staging write made no progress"), { code: "RUNTIME_UNAVAILABLE" });
        }
        offset += bytesWritten;
      }
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  const digest = hash.digest("hex");
  const staged = await inspectFile(options.tempName, digest, byteLength);
  if (!staged) throw Object.assign(new Error("stage verification failed"), { code: "PATH_CHANGED" });
  send({
    type: "prepared",
    sha256: digest,
    byteLength,
    device: String(staged.stats.dev),
    inode: String(staged.stats.ino),
    targetPrecondition,
  });
  await waitCommand("publish");
  return publish(boundStats, digest, byteLength, targetPrecondition);
}

async function recover(boundStats) {
  await waitCommand("start");
  await confirmBoundParent(boundStats);
  const target = await inspectFile(
    options.targetName,
    options.expectedSha256,
    options.expectedByteLength,
    options.expectedDevice,
    options.expectedInode,
  );
  const temp = await inspectFile(
    options.tempName,
    options.expectedSha256,
    options.expectedByteLength,
    options.expectedDevice,
    options.expectedInode,
  );
  const publishName = options.tempName + ".publish";
  const currentTarget = await inspectFile(options.targetName);
  const publishProof = await inspectFile(
    publishName,
    options.expectedSha256,
    options.expectedByteLength,
    options.expectedDevice,
    options.expectedInode,
  );
  if (target && temp && sameIdentity(target.stats, temp.stats)) return target;
  if (temp && publishProof && sameIdentity(temp.stats, publishProof.stats)) {
    return publish(boundStats, options.expectedSha256, options.expectedByteLength, options.targetPrecondition, false);
  }
  if (temp && matchesPrecondition(currentTarget, options.targetPrecondition)) {
    return publish(boundStats, options.expectedSha256, options.expectedByteLength, options.targetPrecondition, false);
  }
  if (options.replace && target && !temp) {
    await link(options.targetName, options.tempName);
    return target;
  }
  if (await inspectFile(options.targetName)) {
    throw Object.assign(new Error("target changed after output preparation"), { code: "PATH_CHANGED" });
  }
  if (!temp) throw Object.assign(new Error("prepared output missing"), { code: "NOT_RECOVERABLE" });
  return publish(boundStats, options.expectedSha256, options.expectedByteLength, options.targetPrecondition, false);
}

async function main() {
  const boundStats = await stat(".");
  send({ type: "ready", device: boundStats.dev, inode: boundStats.ino });
  if (options.action === "cleanup") {
    await waitCommand("start");
    // Node does not expose an identity-bound unlink primitive on Windows. Leave
    // operation-owned proofs in place rather than deleting a path that may have
    // been replaced after verification.
    return { cleaned: true };
  }
  const result = options.action === "recover"
    ? await recover(boundStats)
    : await stage(boundStats);
  return {
    sha256: result.digest,
    byteLength: result.stats.size,
    modifiedAt: result.stats.mtime.toISOString(),
    device: String(result.stats.dev),
    inode: String(result.stats.ino),
    targetPrecondition: result.targetPrecondition ?? options.targetPrecondition,
  };
}

main().then((result) => {
  send(result.cleaned ? { type: "cleaned" } : { type: "result", ...result });
}).catch((error) => {
  send({
    type: "failure",
    code: error && typeof error.code === "string" ? error.code : "RUNTIME_UNAVAILABLE",
    published,
    actualBytes: error && typeof error.actualBytes === "number" ? error.actualBytes : undefined,
  });
  process.exitCode = 1;
});
`;

export type IdentityBoundTranscriptPrepared = {
  sha256: string;
  byteLength: number;
  device: string;
  inode: string;
  targetPrecondition:
    | { kind: "absent" }
    | { kind: "file"; sha256: string; byteLength: number; device: string; inode: string };
};

export type IdentityBoundTranscriptResult = IdentityBoundTranscriptPrepared & {
  modifiedAt: string;
  device: string;
  inode: string;
};

export type IdentityBoundTranscriptExportInput = {
  parentPath: string;
  parentStats: Stats;
  targetName: string;
  tempName: string;
  replace: boolean;
  action: "stage" | "recover";
  chunks?: Iterable<string>;
  maxBytes?: number;
  resumed?: boolean;
  expectedSha256?: string;
  expectedByteLength?: number;
  expectedDevice?: string;
  expectedInode?: string;
  targetPrecondition?: IdentityBoundTranscriptPrepared["targetPrecondition"];
  onIdentityBound?(): void;
  onPrepared?(prepared: IdentityBoundTranscriptPrepared): void;
  onAfterReplaceProof?(): void;
  onAfterReplaceTargetClaim?(): void;
  onAfterReplaceRename?(): void;
};

export class IdentityBoundTranscriptExportError extends Error {
  constructor(
    readonly code: string,
    readonly published: boolean,
    readonly actualBytes?: number,
  ) {
    super(code);
    this.name = "IdentityBoundTranscriptExportError";
  }
}

type WorkerMessage =
  | { type: "ready"; device: number; inode: number }
  | ({ type: "prepared" } & IdentityBoundTranscriptPrepared)
  | ({ type: "result" } & IdentityBoundTranscriptResult)
  | { type: "renamed" }
  | { type: "proof-linked" }
  | { type: "target-claimed" }
  | { type: "cleaned" }
  | { type: "failure"; code: string; published: boolean; actualBytes?: number };

type WorkerExecutionInput = IdentityBoundTranscriptExportInput | {
  parentPath: string;
  parentStats: Stats;
  tempName: string;
  action: "cleanup";
  expectedSha256: string;
  expectedByteLength: number;
  expectedDevice: string;
  expectedInode: string;
};

async function executeWorker(input: WorkerExecutionInput): Promise<IdentityBoundTranscriptResult | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
      cwd: input.parentPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WITHMATE_TRANSCRIPT_EXPORT_OPTIONS: JSON.stringify({
          action: input.action,
          parentPath: input.parentPath,
          targetName: "targetName" in input ? input.targetName : undefined,
          tempName: input.tempName,
          replace: "replace" in input ? input.replace : false,
          maxBytes: "maxBytes" in input ? input.maxBytes : undefined,
          resumed: "resumed" in input ? input.resumed : false,
          expectedSha256: "expectedSha256" in input ? input.expectedSha256 : undefined,
          expectedByteLength: "expectedByteLength" in input ? input.expectedByteLength : undefined,
          expectedDevice: "expectedDevice" in input ? input.expectedDevice : undefined,
          expectedInode: "expectedInode" in input ? input.expectedInode : undefined,
          targetPrecondition: "targetPrecondition" in input ? input.targetPrecondition : undefined,
        }),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const control = child.stdio[3] as Writable | null;
    let stdout = "";
    let stderr = "";
    let result: IdentityBoundTranscriptResult | null = null;
    let cleaned = false;
    let failure: unknown = null;
    let settled = false;
    let ready = false;
    let sentMutation = false;
    let inactivityTimer: NodeJS.Timeout;

    const touch = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        failure = new IdentityBoundTranscriptExportError("RUNTIME_UNAVAILABLE", sentMutation || input.action === "recover");
        child.kill();
      }, 300_000);
    };

    const fail = (error: unknown) => {
      if (failure) return;
      failure = error;
      child.kill();
    };

    const normalizeIdentityHookError = (error: unknown, published: boolean): unknown => {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      return code === "EBUSY" || code === "EPERM"
        ? new IdentityBoundTranscriptExportError("PATH_CHANGED", published)
        : error;
    };

    const sendControl = (command: string) => {
      if (!control?.writable) return fail(new IdentityBoundTranscriptExportError("RUNTIME_UNAVAILABLE", sentMutation || input.action === "recover"));
      sentMutation = true;
      control.write(`${command}\n`);
      touch();
    };

    const streamChunks = async () => {
      try {
        const chunks = "chunks" in input ? input.chunks : undefined;
        for (const chunk of chunks ?? []) {
          if (!child.stdin.write(Buffer.from(chunk, "utf8"))) await once(child.stdin, "drain");
          touch();
        }
        child.stdin.end();
      } catch (error) {
        fail(error);
      }
    };

    const consume = () => {
      while (true) {
        const index = stdout.indexOf("\n");
        if (index < 0) return;
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        touch();
        let message: WorkerMessage;
        try {
          message = JSON.parse(line) as WorkerMessage;
        } catch {
          fail(new IdentityBoundTranscriptExportError("RUNTIME_UNAVAILABLE", sentMutation || input.action === "recover"));
          return;
        }
        if (message.type === "ready") {
          if (ready || message.device !== input.parentStats.dev || message.inode !== input.parentStats.ino) {
            fail(new IdentityBoundTranscriptExportError("PATH_CHANGED", false));
            continue;
          }
          ready = true;
          try {
            if ("onIdentityBound" in input) input.onIdentityBound?.();
          } catch (error) {
            fail(error);
            continue;
          }
          if (input.action === "stage") void streamChunks();
          else {
            child.stdin.end();
            sendControl("start");
          }
        } else if (message.type === "prepared") {
          try {
            if (!("onPrepared" in input)) throw new Error("Unexpected prepared worker message.");
            input.onPrepared?.({
              sha256: message.sha256,
              byteLength: message.byteLength,
              device: message.device,
              inode: message.inode,
              targetPrecondition: message.targetPrecondition,
            });
            sendControl("publish");
          } catch (error) {
            fail(normalizeIdentityHookError(error, false));
          }
        } else if (message.type === "renamed") {
          try {
            if ("onAfterReplaceRename" in input) input.onAfterReplaceRename?.();
            sendControl("continue");
          } catch (error) {
            fail(normalizeIdentityHookError(error, true));
          }
        } else if (message.type === "proof-linked") {
          try {
            if ("onAfterReplaceProof" in input) input.onAfterReplaceProof?.();
            sendControl("continue-proof");
          } catch (error) {
            fail(normalizeIdentityHookError(error, true));
          }
        } else if (message.type === "target-claimed") {
          try {
            if ("onAfterReplaceTargetClaim" in input) input.onAfterReplaceTargetClaim?.();
            sendControl("continue-target-claim");
          } catch (error) {
            fail(normalizeIdentityHookError(error, true));
          }
        } else if (message.type === "result") {
          result = message;
          control?.end();
        } else if (message.type === "cleaned") {
          cleaned = true;
          control?.end();
        } else {
          const published = message.code === "REPLACE_UNAVAILABLE"
            ? false
            : message.published || sentMutation || input.action === "recover";
          failure = new IdentityBoundTranscriptExportError(
            message.code,
            published,
            message.actualBytes,
          );
          control?.end();
        }
      }
    };

    touch();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; consume(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; touch(); });
    child.stdin.on("error", (error) => { if (!failure) fail(error); });
    control?.on("error", (error) => { if (!failure) fail(error); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      consume();
      if (failure) return reject(failure);
      if (code === 0 && ready && result) return resolve(result);
      if (code === 0 && ready && cleaned) return resolve(null);
      reject(new IdentityBoundTranscriptExportError(
        stderr.trim() || "RUNTIME_UNAVAILABLE",
        sentMutation || input.action === "recover",
      ));
    });
  });
}

export async function exportIdentityBoundTranscript(
  input: IdentityBoundTranscriptExportInput,
): Promise<IdentityBoundTranscriptResult> {
  const result = await executeWorker(input);
  if (!result) throw new IdentityBoundTranscriptExportError("RUNTIME_UNAVAILABLE", false);
  return result;
}

export async function cleanupIdentityBoundTranscript(input: {
  parentPath: string;
  parentStats: Stats;
  tempName: string;
  expectedSha256: string;
  expectedByteLength: number;
  expectedDevice: string;
  expectedInode: string;
  targetPrecondition?: IdentityBoundTranscriptPrepared["targetPrecondition"];
}): Promise<void> {
  await executeWorker({ ...input, action: "cleanup" });
}
