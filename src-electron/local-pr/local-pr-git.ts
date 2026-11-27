import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { localPrCommitSchema, type LocalPrFailure } from "../../src-shared/local-pr/local-pr-contract.js";
import { getDefaultGitExecutablePath } from "../platform/git-executable.js";

/** One workspace's worktree and the identity shared by all its linked worktrees. */
export type LocalPrRepository = { repositoryId: string; root: string; workspacePath: string };

/** A deliberate public rejection, including whether a persistent effect must be inspected. */
export class LocalPrError extends Error {
  /** Keeps a domain failure separate from unexpected Git or storage errors. */
  constructor(readonly code: string, message: string, readonly effect: LocalPrFailure["effect"] = "none") {
    super(message);
  }
}

const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const gitArgs = [
  "--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${gitNullDevice}`,
  "-c", "gc.auto=0", "-c", "maintenance.auto=false",
];
const timeout = 30_000;
/** Resolves Git on the process PATH, never by looking in the repository working directory. */
async function gitExecutable(): Promise<string> {
  try {
    return await getDefaultGitExecutablePath();
  } catch {
    throw new LocalPrError("GIT_UNAVAILABLE", "Git is not available on the application PATH.");
  }
}

/** Prevents inherited Git routing overrides, replacement objects and network fetches. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
    LC_ALL: "C",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Captures a bounded, non-shell Git invocation. Callers interpret expected nonzero exits. */
export async function runLocalPrGit(root: string, args: string[], input?: Buffer | string) {
  const file = await gitExecutable();
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = execFile(file, [...gitArgs, ...args], {
      cwd: root, windowsHide: true, env: gitEnvironment(), encoding: "buffer", timeout, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      // Signals, timeout and output limits are not ordinary Git exit statuses.
      if (error && typeof error.code !== "number") {
        reject(new LocalPrError("GIT_FAILED", `Git ${args[0]} did not complete: ${error.code ?? error.signal ?? "interrupted"}.`));
        return;
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr: stderr.toString("utf8").trim() });
    });
    // Early Git exit may close stdin before consuming the full request.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** A Git operation that must succeed to produce a usable result. */
export async function localPrGit(root: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  const result = await runLocalPrGit(root, args, input);
  if (result.code) {
    throw new LocalPrError("GIT_FAILED", result.stderr || `Git ${args[0]} exited with code ${result.code}.`);
  }
  return result.stdout;
}

/** Lines emitted by Git end with a newline; spaces and other filename bytes are significant. */
export function gitLine(bytes: Buffer): string {
  return gitUtf8(bytes).replace(/\r?\n$/u, "");
}

/** Rejects path outputs that cannot be represented losslessly by the public string contract. */
export function gitUtf8(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new LocalPrError("UNSUPPORTED_PATH", "Git returned a path that is not valid UTF-8.");
  }
  return value;
}

/** Git object IDs must be full and must never become revision expressions or options. */
export function gitObjectId(value: string): string {
  if (!localPrCommitSchema.safeParse(value).success) {
    throw new LocalPrError("GIT_FAILED", "Git did not return a full object ID.");
  }
  return value;
}

/** Resolves a trusted Session workspace without using its branch or caller input as repository identity. */
export async function resolveLocalPrRepository(workspacePath: string): Promise<LocalPrRepository> {
  const workspace = await realpath(workspacePath);
  const root = await realpath(gitLine(await localPrGit(workspace, ["rev-parse", "--show-toplevel"])));
  const repositoryId = await realpath(gitLine(await localPrGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  return { repositoryId, root, workspacePath: workspace };
}

/** Rejects revision syntax in ref inputs even if it passed the shared shape check. */
export async function validateLocalPrBranch(root: string, ref: string): Promise<void> {
  const result = await runLocalPrGit(root, ["check-ref-format", ref]);
  if (!ref.startsWith("refs/heads/") || result.code !== 0) {
    throw new LocalPrError("INVALID_BRANCH", "Select an exact local branch ref.");
  }
}

/** Reads an exact, direct local commit ref; a symbolic alias is not a merge target. */
export async function readLocalPrBranch(root: string, ref: string): Promise<string | null> {
  const bytes = await localPrGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)", ref]);
  const value = gitUtf8(bytes).split(/\r?\n/u).map((line) => line.split("\0")).find(([name]) => name === ref);
  if (!value) return null;
  if (value[2] !== "commit" || value[3]) {
    throw new LocalPrError("INVALID_BRANCH", "The selected branch is not a direct commit ref.");
  }
  return gitObjectId(value[1]);
}

/** Accepts exact commit objects, not tags, trees, abbreviated IDs or a working tree. */
export async function verifyLocalPrCommit(root: string, oid: string): Promise<void> {
  const result = await runLocalPrGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${gitObjectId(oid)}^{commit}`]);
  if (result.code !== 0 || gitLine(result.stdout) !== oid) {
    throw new LocalPrError("COMMIT_NOT_FOUND", "The selected object is not an available commit.");
  }
}

/**
 * Holds ordinary Git ref locks across pre-commit worktree checks.
 * A lost acknowledgement for commit is not evidence that the ref stayed unchanged.
 */
export async function withPreparedLocalPrRefs<T>(
  root: string, commands: string[], operation: (commit: () => Promise<void>, assertHeld: () => void) => Promise<T>,
): Promise<T> {
  const child = spawn(await gitExecutable(), [...gitArgs, "update-ref", "-m", "WithMate Local PR", "--stdin"], {
    cwd: root, windowsHide: true, env: gitEnvironment(), stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let commitRequested = false;
  // Bound protocol replies, but never drop the ref locks mid-checkout because of a protocol timer.
  let timer = setTimeout(() => child.kill(), timeout);
  const assertHeld = () => {
    if (child.killed || child.exitCode !== null || child.signalCode !== null) {
      throw new LocalPrError("GIT_REF_CHANGED", "Git released the prepared ref locks.");
    }
  };
  try {
    child.stdin.write(["start", ...commands, "prepare", ""].join("\n"));
    if ((await lines.next()).value !== "start: ok" || (await lines.next()).value !== "prepare: ok") {
      await closed;
      throw new LocalPrError("GIT_REF_CHANGED", stderr.trim() || "Git could not lock the expected refs. Refresh the PR and try again.");
    }
    clearTimeout(timer);
    return await operation(async () => {
      assertHeld();
      commitRequested = true;
      timer = setTimeout(() => child.kill(), timeout);
      child.stdin.end("commit\n");
      const reply = await lines.next();
      if (await closed !== 0 || reply.value !== "commit: ok") {
        throw new LocalPrError("MERGE_EFFECT_UNKNOWN", stderr.trim() || "Git did not confirm the ref update.", "unknown");
      }
    }, assertHeld);
  } finally {
    // Never send commit implicitly; an operation returning or throwing before it leaves refs unchanged.
    if (!commitRequested) child.stdin.end();
    await closed;
    clearTimeout(timer);
  }
}
