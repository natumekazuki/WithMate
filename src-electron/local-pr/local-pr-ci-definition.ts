import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isAlias, parseDocument, visit } from "yaml";
import { z } from "zod";

import type { LocalPrData } from "../../src-shared/local-pr/local-pr-contract.js";
import { getDefaultGitExecutablePath } from "../platform/git-executable.js";

const exec = promisify(execFile);
const definitionPath = ".withmate/ci.yml";
const definitionBytes = 64 * 1024;
const definitionSchema = z.strictObject({
  version: z.literal(1),
  commands: z.array(z.string().max(4096).refine((value) => !!value.trim() && !/[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/u.test(value))).min(1).max(100),
});

/** A validated definition comes exclusively from the submitted commit's ordinary file blob. */
export async function readLocalPrCiDefinition(workspacePath: string, headCommit: string): Promise<{
  definition: LocalPrData<"pr_ci_validate">;
  commands: string[] | null;
}> {
  const identity = { headCommit, path: definitionPath } as const;
  const invalid = (error: string, source: string | null = null) => ({
    definition: { ...identity, state: "invalid" as const, source, error }, commands: null,
  });

  // A missing path is not configured; a missing commit is a Git error, not an empty tree.
  if ((await git(workspacePath, ["cat-file", "-t", headCommit])).toString().trim() !== "commit") {
    throw new Error("The pinned CI head is not a Git commit.");
  }
  // The Session can start in a subdirectory; CI always names a path from the commit's root.
  const entry = (await git(workspacePath, ["ls-tree", "--full-tree", "-z", headCommit, "--", definitionPath])).toString();
  if (!entry) return { definition: { ...identity, state: "not_configured", source: null, error: null }, commands: null };
  const object = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t\.withmate\/ci\.yml\0$/u.exec(entry)?.[1];
  if (!object) return invalid("The CI definition must be an ordinary Git file.");
  if (Number((await git(workspacePath, ["cat-file", "-s", object])).toString().trim()) > definitionBytes) {
    return invalid("The CI definition exceeds 64 KiB.");
  }
  const bytes = await git(workspacePath, ["cat-file", "blob", object]);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("The CI definition is not UTF-8.");
  }
  try {
    // Never materialize aliases, tags, duplicate keys, or YAML merge keys as JavaScript values.
    const document = parseDocument(source, { version: "1.2", schema: "core", uniqueKeys: true, merge: false });
    if (document.errors.length || document.warnings.length) return invalid("Invalid CI YAML.", source);
    visit(document, (_key, node) => {
      if (isAlias(node) || (typeof node === "object" && node !== null && ("anchor" in node || "tag" in node))) {
        throw new Error("CI YAML does not support aliases, anchors, or tags.");
      }
    });
    const parsed = definitionSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success) return invalid("Expected only version: 1 and 1–100 single-line commands (up to 4096 characters each).", source);
    return { definition: { ...identity, state: "valid", source, error: null }, commands: parsed.data.commands };
  } catch {
    return invalid("Unsupported CI YAML.", source);
  }
}

/** Copy only objects reachable from the pinned head into a new Git repository. */
export async function prepareLocalPrCiCheckout(workspacePath: string, checkout: string, headCommit: string, signal: AbortSignal): Promise<void> {
  const step = (cwd: string, args: string[]) => {
    // Let the in-flight local Git command close before treating cancellation as confirmed.
    signal.throwIfAborted();
    return git(cwd, args);
  };
  const common = (await step(workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().replace(/\r?\n$/u, "");
  const localSource = pathToFileURL(await realpath(common)).href;

  // File transport copies Git objects; unlike a worktree or local clone, it shares no metadata, links, or alternates.
  await mkdir(checkout, { mode: 0o700 });
  await step(checkout, ["init", "--quiet", "--template=", `--object-format=${headCommit.length === 64 ? "sha256" : "sha1"}`]);
  await step(checkout, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance", "--no-write-fetch-head", "--", localSource, headCommit]);
  await step(checkout, ["checkout", "--detach", "--no-recurse-submodules", headCommit, "--"]);
  const checkedOut = (await step(checkout, ["rev-parse", "HEAD"])).toString().trim();
  if (checkedOut !== headCommit) throw new Error("The CI checkout did not reach the pinned commit.");
}

/** Don't inherit Git redirects, worktree overrides, helpers, templates, or global/system config. */
async function git(cwd: string, args: string[]): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^git_/iu.test(name)));
  const windows = process.platform === "win32";
  const nullDevice = windows ? "NUL" : "/dev/null";
  // Opt in for these Git invocations only: neither the original repo nor the OS configuration is changed.
  const config = ["-c", `core.hooksPath=${nullDevice}`, ...(windows ? ["-c", "core.longpaths=true"] : [])];
  try {
    const { stdout } = await exec(await getDefaultGitExecutablePath(), ["--no-replace-objects", ...config, ...args], {
      cwd, encoding: "buffer", maxBuffer: definitionBytes * 2, windowsHide: true,
      env: { ...env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim().slice(0, 2000);
    throw new Error(`Git ${args[0]} failed${stderr ? `: ${stderr}` : "."}`);
  }
}
