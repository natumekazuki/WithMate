import path from "node:path";

import type {
  FileRootGitChangeEntry,
  FileRootGitChangeKind,
  FileRootGitHistoryAvailableRef,
  FileRootGitHistoryCommit,
  FileRootGitHistoryRef,
  FileRootGitHistoryRefKind,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

export function normalizeGitRelativePath(value: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error("Git path must be a non-empty workspace-relative path.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Git path contains an invalid segment.");
  }
  return segments.join("/");
}

function changeKind(status: string, fallback: FileRootGitChangeKind = "modified"): FileRootGitChangeKind {
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "D") return "deleted";
  if (status === "A") return "added";
  return fallback;
}

export function normalizeWorkspacePrefix(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/` : "";
}

function toWorkspaceRelativePath(repositoryRelativePath: string, workspacePrefix: string): string | null {
  const normalizedPath = repositoryRelativePath.replaceAll("\\", "/");
  const normalizedPrefix = normalizeWorkspacePrefix(workspacePrefix);
  if (!normalizedPrefix) return normalizeGitRelativePath(normalizedPath);
  if (!normalizedPath.startsWith(normalizedPrefix)) return null;
  return normalizeGitRelativePath(normalizedPath.slice(normalizedPrefix.length));
}

export function parseGitPorcelainV1Z(output: Buffer, workspacePrefix = ""): FileRootGitChangeEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: FileRootGitChangeEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw new Error("Git status returned an unsupported porcelain record.");
    const x = field[0] ?? " ";
    const y = field[1] ?? " ";
    const repositoryRelativePath = normalizeGitRelativePath(field.slice(3));
    const isRename = x === "R" || x === "C" || y === "R" || y === "C";
    const repositoryPreviousPath = isRename ? normalizeGitRelativePath(fields[index + 1] ?? "") : null;
    if (isRename) index += 1;
    const currentRelativePath = toWorkspaceRelativePath(repositoryRelativePath, workspacePrefix);
    const previousRelativePath = repositoryPreviousPath
      ? toWorkspaceRelativePath(repositoryPreviousPath, workspacePrefix)
      : null;
    if (!currentRelativePath && !previousRelativePath) continue;
    const relativePath = currentRelativePath ?? previousRelativePath!;
    if (x === "?" && y === "?") {
      entries.push({ relativePath, previousRelativePath: null, kinds: { "working-tree": "untracked" }, scopes: ["working-tree"] });
      continue;
    }
    const scopes: FileRootGitChangeEntry["scopes"] = [];
    const kinds: FileRootGitChangeEntry["kinds"] = {};
    if (x !== " " && x !== "?") {
      scopes.push("staged");
      kinds.staged = !currentRelativePath ? "deleted" : isRename && !previousRelativePath ? "added" : changeKind(x);
    }
    if (y !== " " && y !== "?") {
      scopes.push("working-tree");
      kinds["working-tree"] = !currentRelativePath ? "deleted" : isRename && !previousRelativePath ? "added" : changeKind(y);
    }
    entries.push({ relativePath, previousRelativePath: currentRelativePath ? previousRelativePath : null, kinds, scopes });
  }
  return entries;
}

export function normalizeHistoryObjectId(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(normalized)) throw new Error("Git history returned an unsupported commit id.");
  return normalized;
}

export function normalizeHistoryBranch(value: string): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Git history branch is invalid.");
  }
  return value;
}

function parseHistoryRefs(value: string): FileRootGitHistoryRef[] {
  const refs: FileRootGitHistoryRef[] = [];
  const seen = new Set<string>();
  const add = (kind: FileRootGitHistoryRefKind, name: string) => {
    const normalizedName = name.trim();
    if (!normalizedName || /[\u0000-\u001f\u007f]/u.test(normalizedName)) return;
    const key = `${kind}:${normalizedName}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, name: normalizedName });
  };
  for (const rawToken of value.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const headTarget = /^HEAD -> (refs\/heads\/)?(.+)$/u.exec(token);
    if (headTarget) { add("head", "HEAD"); add("branch", headTarget[2]!); continue; }
    if (token === "HEAD") { add("head", "HEAD"); continue; }
    const tagTarget = /^(?:tag: (?:refs\/tags\/)?|refs\/tags\/)(.+)$/u.exec(token);
    if (tagTarget) { add("tag", tagTarget[1]!); continue; }
    const branchTarget = /^refs\/heads\/(.+)$/u.exec(token);
    if (branchTarget) add("branch", branchTarget[1]!);
  }
  return refs;
}

export function parseGitHistoryLog(output: Buffer): FileRootGitHistoryCommit[] {
  const records = output.toString("utf8").split("\x01");
  const commits: FileRootGitHistoryCommit[] = [];
  for (const rawRecord of records) {
    const record = rawRecord.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length !== 9 || fields[8] !== "") throw new Error("Git history returned an unsupported commit record.");
    const [idField, shortHash, authorName, authorEmail, authoredAt, subject, parents, decorations] = fields;
    const id = normalizeHistoryObjectId(idField!);
    if (!/^[0-9a-f]{7,64}$/.test(shortHash!)) throw new Error("Git history returned an unsupported short commit id.");
    if (!authoredAt || Number.isNaN(Date.parse(authoredAt))) throw new Error("Git history returned an unsupported author date.");
    const parentIds = parents ? parents.split(/\s+/u).map(normalizeHistoryObjectId) : [];
    commits.push({ id, shortHash: shortHash!, subject: subject ?? "", authorName: authorName ?? "", authorEmail: authorEmail ?? "", authoredAt: new Date(authoredAt).toISOString(), refs: parseHistoryRefs(decorations ?? ""), parentIds });
  }
  return commits;
}

export function parseGitHistoryNameStatusZ(output: Buffer, workspacePrefix = ""): FileRootGitChangeEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: FileRootGitChangeEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const statusField = fields[index];
    if (!statusField) continue;
    const status = statusField[0];
    if (!status || !/^[A-Z]$/u.test(status)) throw new Error("Git history returned an unsupported file status.");
    const firstRepositoryPath = normalizeGitRelativePath(fields[index + 1] ?? "");
    const isRenameOrCopy = status === "R" || status === "C";
    const secondRepositoryPath = isRenameOrCopy ? normalizeGitRelativePath(fields[index + 2] ?? "") : null;
    index += isRenameOrCopy ? 2 : 1;
    const firstPath = toWorkspaceRelativePath(firstRepositoryPath, workspacePrefix);
    const secondPath = secondRepositoryPath ? toWorkspaceRelativePath(secondRepositoryPath, workspacePrefix) : null;
    if (!firstPath && !secondPath) continue;
    const resolvedPath = secondPath ?? firstPath;
    if (!resolvedPath) continue;
    const kind = !isRenameOrCopy ? changeKind(status) : firstPath && secondPath ? changeKind(status) : secondPath ? "added" : "deleted";
    entries.push({ relativePath: resolvedPath, previousRelativePath: secondPath && firstPath ? firstPath : null, kinds: { commit: kind }, scopes: ["commit"] });
  }
  return entries;
}

export function parseGitHistoryAvailableRefs(output: Buffer): FileRootGitHistoryAvailableRef[] {
  const refs: FileRootGitHistoryAvailableRef[] = [];
  const seen = new Set<string>();
  const add = (kind: FileRootGitHistoryAvailableRef["kind"], name: string) => {
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) return;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, name });
  };
  for (const rawLine of output.toString("utf8").split(/\r?\n/u)) {
    if (rawLine.startsWith("refs/heads/")) add("branch", rawLine.slice("refs/heads/".length));
    else if (rawLine.startsWith("refs/remotes/")) add("remote", rawLine.slice("refs/remotes/".length));
    else if (rawLine.startsWith("refs/tags/")) add("tag", rawLine.slice("refs/tags/".length));
  }
  return refs;
}
