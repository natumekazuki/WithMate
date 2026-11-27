import type { LocalPrData, LocalPrDetail, LocalPrInput, LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import { gitUtf8, LocalPrError, localPrGit } from "./local-pr-git.js";

type Diff = LocalPrData<"pr_diff">;
type File = Diff["files"][number];
type Anchor = NonNullable<LocalPrInput<"pr_comment">["anchor"]>;
type Comparison = Pick<Diff, "beforeCommit" | "afterCommit">;
const fileKinds = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed" } as const;

/** Locates one immutable review version without falling forward to the latest version. */
export function localPrVersion(versions: LocalPrVersion[], wanted: number): LocalPrVersion {
  const version = versions.find(({ version }) => version === wanted);
  if (!version) throw new LocalPrError("VERSION_NOT_FOUND", "The selected PR version does not exist.");
  return version;
}

/** Chooses fixed endpoints for full review and incremental review. */
function comparison(versions: LocalPrDetail["versions"], version: number, mode: Anchor["mode"]): Comparison {
  const selected = localPrVersion(versions, version);
  // The first version has no predecessor; using the merge base here would mislabel an anchor.
  if (mode === "previous" && version === 1) {
    throw new LocalPrError("NO_PREVIOUS_VERSION", "The first submission has no previous version.");
  }
  return {
    beforeCommit: mode === "full" ? selected.mergeBaseCommit : localPrVersion(versions, version - 1).headCommit,
    afterCommit: selected.headCommit,
  };
}

/** Parses Git's NUL-separated statuses without splitting or normalizing filenames. */
function parseChangedFiles(bytes: Buffer): File[] {
  const tokens = gitUtf8(bytes).split("\0");
  const files: File[] = [];
  // With rename detection, R and C carry source and destination paths.
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++][0] as keyof typeof fileKinds;
    const kind = fileKinds[status];
    const first = tokens[i++];
    const paired = status === "R" || status === "C";
    const path = paired ? tokens[i++] : first;
    if (!kind || !first || !path) throw new LocalPrError("GIT_FAILED", "Git returned an unsupported change entry.");
    files.push({ path, previousPath: paired ? first : null, kind });
  }
  return files;
}

/** Reads the full change list or an exact file patch, including both names of a rename. */
export async function readLocalPrDiff(root: string, versions: LocalPrVersion[], input: LocalPrInput<"pr_diff">): Promise<Diff> {
  const range = comparison(versions, input.version, input.mode);
  const args = [
    `--attr-source=${range.afterCommit}`, "diff-tree", "--no-commit-id", "-r", "--find-renames=50%", "-l1000",
    "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", "--diff-algorithm=myers",
  ];
  const commits = [range.beforeCommit, range.afterCommit, "--"];
  const files = parseChangedFiles(await localPrGit(root, [...args, "--name-status", "-z", ...commits]));
  if (input.path === undefined) return { ...range, files, patch: null };
  // Match the published name exactly. A caller cannot smuggle Git pathspec syntax or switch sides.
  const file = files.find(({ path }) => path === input.path);
  if (!file) throw new LocalPrError("FILE_NOT_CHANGED", "This path is not in the selected version's comparison.");
  const specs = [file.previousPath, file.path].filter((value) => value !== null).map((value) => `:(top,literal)${value}`);
  const patch = await localPrGit(root, [
    ...args, "--patch", "--full-index", "--no-indent-heuristic", "--unified=3", "--submodule=short",
    "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", "--line-prefix=",
    "--output-indicator-old=-", "--output-indicator-new=+", "--output-indicator-context= ", ...commits, ...specs,
  ]);
  return { ...range, files: [file], patch: patch.toString("utf8") };
}

/** Anchors address an existing side of a file or visible lines on that side of its text patch. */
export async function validateLocalPrAnchor(root: string, versions: LocalPrVersion[], prId: string, version: number, anchor: Anchor): Promise<void> {
  const fileOnly = anchor.startLine === null && anchor.endLine === null;
  const diff = await readLocalPrDiff(root, versions, { prId, version, mode: anchor.mode, ...(fileOnly ? {} : { path: anchor.path }) });
  const file = diff.files.find(({ path }) => path === anchor.path);
  if (!file || (file.kind === "added" && anchor.side === "before") || (file.kind === "deleted" && anchor.side === "after")) {
    throw new LocalPrError("INVALID_ANCHOR", "This file has no selected side in the comparison.");
  }
  // Binary and rename-only entries can be discussed at file level without fetching a patch.
  if (fileOnly) return;
  if (anchor.startLine === null || anchor.endLine === null) {
    throw new LocalPrError("INVALID_ANCHOR", "Select both endpoints of the line range.");
  }
  let next = anchor.startLine;
  const headers = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu;
  // Combine adjacent hunk ranges on the chosen side but never jump an undisplayed gap.
  for (const match of (diff.patch ?? "").matchAll(headers)) {
    const i = anchor.side === "before" ? 1 : 3;
    const start = Number(match[i]);
    const end = start + Number(match[i + 1] ?? 1) - 1;
    if (next >= start && next <= end) next = end + 1;
    if (next > anchor.endLine) return;
  }
  throw new LocalPrError("INVALID_ANCHOR", "Select a line range shown on the chosen side of this file's diff.");
}
