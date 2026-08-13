import { spawn } from "node:child_process";
import type { Stats } from "node:fs";

const WORKER_SOURCE = String.raw`
const { createHash } = require("node:crypto");
const { lstat, mkdir, open, realpath, rename, link, stat, unlink } = require("node:fs/promises");
const path = require("node:path");

const options = JSON.parse(process.env.WITHMATE_IDENTITY_WRITE_OPTIONS);
let published = false;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectFile(filePath) {
  try {
    const lexical = await lstat(filePath);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    const handle = await open(filePath, "r");
    try {
      const before = await handle.stat();
      const real = await realpath(filePath);
      const current = await stat(real);
      if (before.dev !== current.dev || before.ino !== current.ino) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
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
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
      }
      return { stats: after, digest: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkOwnedTemp(tempPath) {
  try {
    const lexical = await lstat(tempPath);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    await unlink(tempPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
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
    if (lexical.dev !== bound.dev || lexical.ino !== bound.ino) {
      throw Object.assign(new Error("path changed"), { code: "PATH_CHANGED" });
    }
  }
  return ".";
}

async function main() {
  const rootStats = await stat(".");
  process.stdout.write(JSON.stringify({ type: "ready", device: rootStats.dev, inode: rootStats.ino }) + "\n");
  if (options.action === "cleanup") {
    const segments = options.relativePath.split("/");
    segments.pop();
    try {
      const parent = await resolveDirectories(segments, false);
      await unlinkOwnedTemp(path.join(parent, options.tempName));
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    return { cleaned: true };
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
  const segments = options.relativePath.split("/");
  const fileName = segments.pop();
  const parent = await resolveDirectories(segments, true);
  const targetPath = path.join(parent, fileName);
  const tempPath = path.join(parent, options.tempName);
  const target = await inspectFile(targetPath);
  const temp = await inspectFile(tempPath);

  if (options.resumed && target && target.digest === options.contentDigest) {
    if (temp && temp.digest === options.contentDigest && temp.stats.dev === target.stats.dev && temp.stats.ino === target.stats.ino) {
      return target.stats;
    }
  }
  if (target && !options.replace) throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });

  if (temp) {
    if (!options.resumed) throw Object.assign(new Error("temp collision"), { code: "PATH_CHANGED" });
    if (temp.digest !== options.contentDigest) await unlinkOwnedTemp(tempPath);
  }
  if (!temp || temp.digest !== options.contentDigest) {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const staged = await inspectFile(tempPath);
  if (!staged || staged.digest !== options.contentDigest) {
    throw Object.assign(new Error("stage verification failed"), { code: "PATH_CHANGED" });
  }

  if (options.replace) {
    await rename(tempPath, targetPath);
    published = true;
    await link(targetPath, tempPath);
  } else {
    try { await link(tempPath, targetPath); }
    catch (error) {
      if (error && error.code === "EEXIST") throw Object.assign(new Error("file already exists"), { code: "FILE_ALREADY_EXISTS" });
      throw error;
    }
    published = true;
  }
  const result = await inspectFile(targetPath);
  const proof = await inspectFile(tempPath);
  if (!result || !proof || result.digest !== options.contentDigest
    || result.stats.dev !== staged.stats.dev || result.stats.ino !== staged.stats.ino
    || proof.stats.dev !== result.stats.dev || proof.stats.ino !== result.stats.ino) {
    throw Object.assign(new Error("publish verification failed"), { code: "RUNTIME_UNAVAILABLE" });
  }
  return result.stats;
}

main().then((result) => {
  process.stdout.write(result.cleaned
    ? JSON.stringify({ type: "cleaned" }) + "\n"
    : JSON.stringify({ type: "result", byteLength: result.size, modifiedAt: result.mtime.toISOString() }) + "\n");
}).catch((error) => {
  process.stdout.write(JSON.stringify({
    type: "failure",
    code: error && typeof error.code === "string" ? error.code : "RUNTIME_UNAVAILABLE",
    published,
  }) + "\n");
  process.exitCode = 1;
});
`;

export type IdentityBoundFileWriteInput = {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  content: Uint8Array;
  contentDigest: string;
  tempName: string;
  replace: boolean;
  resumed: boolean;
  onIdentityBound?: () => void;
};

export type IdentityBoundFileWriteResult = {
  byteLength: number;
  modifiedAt: string;
};

export class IdentityBoundFileWriteError extends Error {
  constructor(readonly code: string, readonly published: boolean) {
    super(code);
    this.name = "IdentityBoundFileWriteError";
  }
}

type WorkerMessage =
  | { type: "ready"; device: number; inode: number }
  | { type: "result"; byteLength: number; modifiedAt: string }
  | { type: "cleaned" }
  | { type: "failure"; code: string; published: boolean };

type WorkerExecutionInput = {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  tempName: string;
  action: "write" | "cleanup";
  content?: Uint8Array;
  contentDigest?: string;
  replace?: boolean;
  resumed?: boolean;
  onIdentityBound?: () => void;
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
        }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let result: IdentityBoundFileWriteResult | null = null;
    let cleaned = false;
    let failure: IdentityBoundFileWriteError | null = null;
    let sent = false;
    let settled = false;
    const timeout = setTimeout(() => {
      failure = new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", false);
      child.kill();
    }, 30_000);

    const failBeforeSend = (error: unknown) => {
      failure = error instanceof IdentityBoundFileWriteError
        ? error
        : new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", false);
      child.kill();
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
          failBeforeSend(new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", false));
          return;
        }
        if (message.type === "ready") {
          if (message.device !== input.rootStats.dev || message.inode !== input.rootStats.ino) {
            failure = new IdentityBoundFileWriteError("PATH_CHANGED", false);
            child.kill();
            continue;
          }
          try {
            input.onIdentityBound?.();
            sent = true;
            child.stdin.end(input.content ?? new Uint8Array());
          } catch (error) {
            failBeforeSend(error);
            return;
          }
        } else if (message.type === "result") {
          result = { byteLength: message.byteLength, modifiedAt: message.modifiedAt };
        } else if (message.type === "cleaned") {
          cleaned = true;
        } else {
          failure = new IdentityBoundFileWriteError(message.code, message.published);
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; consume(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
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
      if (code === 0 && sent && result) return resolve(result);
      if (code === 0 && sent && cleaned) return resolve(null);
      reject(new IdentityBoundFileWriteError(stderr.trim() || "RUNTIME_UNAVAILABLE", false));
    });
  });
}

export async function writeIdentityBoundFile(input: IdentityBoundFileWriteInput): Promise<IdentityBoundFileWriteResult> {
  const result = await executeIdentityBoundWorker({
    ...input,
    action: "write",
  });
  if (!result) throw new IdentityBoundFileWriteError("RUNTIME_UNAVAILABLE", false);
  return result;
}

export async function cleanupIdentityBoundFileWrite(input: {
  rootPath: string;
  rootStats: Stats;
  relativePath: string;
  tempName: string;
}): Promise<void> {
  await executeIdentityBoundWorker({
    ...input,
    action: "cleanup",
  });
}
