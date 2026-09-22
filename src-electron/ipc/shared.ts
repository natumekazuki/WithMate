import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import type { MarkdownLinkContextMenuRequest } from "../../src-shared/window/markdown-link-context-menu.js";

import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";

import type {
  SessionFilePreviewImageActionRequest,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileTreePathActionRequest,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryComparison,
  FileRootGitHistoryComparisonSelector,
  FileRootGitHistoryDiffRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyRequest,
} from "../../src-shared/file-explorer/session-file-object-copy-contract.js";

import {
  areSessionFileResourcesEqual,
  isFileRootGitHistoryComparisonDiffRequest,
  isSessionFileGitCommitResource,
  isSessionFileRootResource,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

import { resolveWorkspaceDirectoryValidationMessage } from "../../src-shared/window/workspace-directory-validation.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

export async function assertUsableWorkspaceDirectory(
  targetPath: unknown,
  deps: MainIpcWorkspaceValidationDeps,
): Promise<void> {
  const result = await deps.validateWorkspaceDirectory(targetPath);
  if (!result.valid) {
    throw new Error(resolveWorkspaceDirectoryValidationMessage(result));
  }
}

export function resolveTargetWindow(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps & MainIpcHomeWindowDeps,
): BrowserWindow | undefined {
  return (
    deps.resolveEventWindow(event) ?? deps.resolveHomeWindow() ?? undefined
  );
}

export function assertMemoryV6ReviewSender(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps & MainIpcMemoryReviewWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (window && deps.isMemoryV6ReviewWindow(window)) {
    return;
  }
  throw new Error(
    "Memory V6 Review IPC is only available from the Memory Review window.",
  );
}

export function assertSettingsWindowSender(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps & MainIpcSettingsWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (window && deps.isSettingsWindow(window)) {
    return;
  }
  throw new Error("Settings IPC is only available from the Settings window.");
}

export function assertHomeWindowSender(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps & MainIpcHomeWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (window && deps.resolveHomeWindow() === window) {
    return;
  }
  throw new Error(
    "Workspace validation IPC is only available from the Home window.",
  );
}

export function assertSessionMonitorContextMenuSender(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps &
    MainIpcHomeWindowDeps &
    MainIpcSessionMonitorWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (
    window &&
    (deps.resolveHomeWindow() === window || deps.isSessionMonitorWindow(window))
  ) {
    return;
  }
  throw new Error(
    "Session Monitor context menu IPC is only available from Home or Session Monitor window.",
  );
}

export function assertSessionDeleteSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps &
    MainIpcHomeWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcSettingsWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (!window) {
    throw new Error(
      "Session delete IPC is only available from Home, Settings, or the target Session window.",
    );
  }
  if (deps.isSettingsWindow(window)) {
    return;
  }
  if (deps.resolveHomeWindow() === window) {
    return;
  }
  if (deps.resolveSessionWindow(sessionId) === window) {
    return;
  }
  throw new Error(
    "Session delete IPC is only available from Home, Settings, or the target Session window.",
  );
}

export function assertOwningSessionWindowSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps,
): void {
  const window = deps.resolveEventWindow(event);
  if (!window || deps.resolveSessionWindow(sessionId) !== window) {
    throw new Error(
      "Glossary IPC is only available from the target Session window.",
    );
  }
}

export async function assertSessionFileExplorerSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      getSessionFileExplorerOwnerSessionId(
        sessionId: string,
      ): Awaitable<string | null>;
    },
): Promise<SessionFilePreviewResourceRequest | null> {
  const ownerSessionId =
    await deps.getSessionFileExplorerOwnerSessionId(sessionId);
  const window = deps.resolveEventWindow(event);
  if (
    ownerSessionId &&
    window &&
    deps.resolveSessionWindow(ownerSessionId) === window
  ) {
    return null;
  }
  const currentResource = window
    ? deps.getFilePreviewWindowResource(window, sessionId)
    : null;
  if (currentResource) {
    return currentResource;
  }
  throw new Error(
    "File Explorer IPC is only available from the owning Session window.",
  );
}

export async function assertOwningSessionFileExplorerSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps & {
      getSessionFileExplorerOwnerSessionId(
        sessionId: string,
      ): Awaitable<string | null>;
    },
): Promise<void> {
  const ownerSessionId =
    await deps.getSessionFileExplorerOwnerSessionId(sessionId);
  const window = deps.resolveEventWindow(event);
  if (
    ownerSessionId &&
    window &&
    deps.resolveSessionWindow(ownerSessionId) === window
  ) {
    return;
  }
  throw new Error(
    "File preview navigation is only available from the owning Session window.",
  );
}

export async function assertSessionFileResourceSender(
  event: IpcMainInvokeEvent,
  resource: SessionFilePreviewResourceRequest,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      getSessionFileExplorerOwnerSessionId(
        sessionId: string,
      ): Awaitable<string | null>;
    },
): Promise<void> {
  const ownerSessionId = await deps.getSessionFileExplorerOwnerSessionId(
    resource.sessionId,
  );
  const window = deps.resolveEventWindow(event);
  if (
    ownerSessionId &&
    window &&
    deps.resolveSessionWindow(ownerSessionId) === window &&
    isSessionFileRootResource(resource)
  ) {
    return;
  }
  const currentResource = window
    ? deps.getFilePreviewWindowResource(window, resource.sessionId)
    : null;
  if (
    currentResource &&
    areSessionFileResourcesEqual(currentResource, resource)
  ) {
    return;
  }
  throw new Error(
    "File Preview IPC is only available for the current Preview resource.",
  );
}

export async function assertSessionFileLinkSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  baseResource: SessionFilePreviewResourceRequest | undefined,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      getSessionFileExplorerOwnerSessionId(
        sessionId: string,
      ): Awaitable<string | null>;
    },
): Promise<void> {
  const ownerSessionId =
    await deps.getSessionFileExplorerOwnerSessionId(sessionId);
  const window = deps.resolveEventWindow(event);
  if (
    ownerSessionId &&
    window &&
    deps.resolveSessionWindow(ownerSessionId) === window
  ) {
    return;
  }
  const currentResource = window
    ? deps.getFilePreviewWindowResource(window, sessionId)
    : null;
  if (
    currentResource &&
    baseResource &&
    areSessionFileResourcesEqual(currentResource, baseResource)
  ) {
    return;
  }
  throw new Error(
    "File Preview navigation must use the current Preview resource as its base.",
  );
}

export function assertValidSessionFilePreviewResourceRequest(
  input: unknown,
  expectedSessionId?: string,
): asserts input is SessionFilePreviewResourceRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("File preview resource is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    (expectedSessionId !== undefined &&
      candidate.sessionId !== expectedSessionId)
  ) {
    throw new TypeError("File preview resource is invalid.");
  }
  if (candidate.resourceKind === "git-commit-file") {
    if (
      Object.hasOwn(candidate, "absolutePath") ||
      typeof candidate.rootId !== "string" ||
      !candidate.rootId ||
      typeof candidate.repositoryId !== "string" ||
      !/^git:[0-9a-f]{24}$/u.test(candidate.repositoryId) ||
      typeof candidate.commitId !== "string" ||
      !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(candidate.commitId) ||
      typeof candidate.relativePath !== "string" ||
      !candidate.relativePath
    ) {
      throw new TypeError("File preview resource is invalid.");
    }
    assertValidGitHistoryRelativePath(candidate.relativePath);
    return;
  }
  if (candidate.resourceKind !== undefined) {
    throw new TypeError("File preview resource is invalid.");
  }
  const hasAbsolutePath = Object.hasOwn(candidate, "absolutePath");
  const hasRootFields =
    Object.hasOwn(candidate, "rootId") ||
    Object.hasOwn(candidate, "relativePath");
  if (
    hasAbsolutePath === hasRootFields ||
    (hasAbsolutePath &&
      (typeof candidate.absolutePath !== "string" ||
        !candidate.absolutePath)) ||
    (hasRootFields &&
      (typeof candidate.rootId !== "string" ||
        !candidate.rootId ||
        typeof candidate.relativePath !== "string"))
  ) {
    throw new TypeError("File preview resource is invalid.");
  }
}

export function assertValidGitHistoryRequest(input: unknown): asserts input is {
  sessionId: string;
  repositoryId: string;
  rootId: string;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Git history request is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    typeof candidate.repositoryId !== "string" ||
    !/^git:[0-9a-f]{24}$/u.test(candidate.repositoryId) ||
    typeof candidate.rootId !== "string" ||
    !candidate.rootId
  ) {
    throw new TypeError("Git history request is invalid.");
  }
}

export function assertValidGitHistoryCommitId(
  commitId: unknown,
): asserts commitId is string {
  if (
    typeof commitId !== "string" ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(commitId)
  ) {
    throw new TypeError("Git history commit id is invalid.");
  }
}

export function assertValidGitHistoryComparisonSelector(
  input: unknown,
): asserts input is FileRootGitHistoryComparisonSelector {
  if (!input || typeof input !== "object") {
    throw new TypeError("Git history comparison selector is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.kind === "head") {
    return;
  }
  if (
    candidate.kind === "branch" ||
    candidate.kind === "remote" ||
    candidate.kind === "tag"
  ) {
    if (
      typeof candidate.name !== "string" ||
      !candidate.name ||
      candidate.name.trim() !== candidate.name ||
      candidate.name.includes("\\") ||
      candidate.name.includes("..") ||
      /[\u0000-\u001f\u007f]/u.test(candidate.name)
    ) {
      throw new TypeError("Git history comparison ref is invalid.");
    }
    return;
  }
  if (candidate.kind === "commit") {
    if (
      typeof candidate.objectId !== "string" ||
      !/^[0-9a-f]{7,64}$/iu.test(candidate.objectId)
    ) {
      throw new TypeError("Git history comparison commit id is invalid.");
    }
    return;
  }
  throw new TypeError("Git history comparison selector is invalid.");
}

export function assertValidGitHistoryComparison(
  input: unknown,
): asserts input is FileRootGitHistoryComparison {
  if (!input || typeof input !== "object") {
    throw new TypeError("Git history comparison is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.mode !== "direct" && candidate.mode !== "branch") {
    throw new TypeError("Git history comparison mode is invalid.");
  }
  assertValidGitHistoryComparisonSelector(candidate.base);
  assertValidGitHistoryComparisonSelector(candidate.target);
  if (
    typeof candidate.baseCommitId !== "string" ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(candidate.baseCommitId) ||
    typeof candidate.targetCommitId !== "string" ||
    !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(candidate.targetCommitId) ||
    (candidate.mergeBaseCommitId !== null &&
      (typeof candidate.mergeBaseCommitId !== "string" ||
        !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(candidate.mergeBaseCommitId)))
  ) {
    throw new TypeError("Git history comparison snapshot is invalid.");
  }
}

export function assertValidGitHistoryDiffRequest(
  input: unknown,
): asserts input is FileRootGitHistoryDiffRequest {
  assertValidGitHistoryRequest(input);
  const candidate = input as FileRootGitHistoryDiffRequest;
  if (isFileRootGitHistoryComparisonDiffRequest(candidate)) {
    assertValidGitHistoryComparison(candidate.comparison);
  } else {
    assertValidGitHistoryCommitId(candidate.commitId);
  }
  assertValidGitHistoryRelativePath(candidate.relativePath);
}

export function assertValidGitHistoryCursor(
  cursor: unknown,
): asserts cursor is string | null | undefined {
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" || !/^(?:0|[1-9][0-9]{0,8})$/u.test(cursor))
  ) {
    throw new TypeError("Git history cursor is invalid.");
  }
}

export function assertValidGitHistoryBranch(
  branch: unknown,
): asserts branch is string | null {
  if (branch === null) {
    return;
  }
  if (
    typeof branch !== "string" ||
    !branch ||
    branch.trim() !== branch ||
    /[\u0000-\u001f\u007f]/u.test(branch)
  ) {
    throw new TypeError("Git history branch is invalid.");
  }
}

export function assertValidGitHistoryCommitsRequest(
  input: unknown,
): asserts input is FileRootGitHistoryCommitsRequest {
  assertValidGitHistoryRequest(input);
  assertValidGitHistoryBranch((input as { branch?: unknown }).branch);
}

export function assertValidGitHistoryRelativePath(
  relativePath: unknown,
): asserts relativePath is string | null | undefined {
  if (relativePath === undefined || relativePath === null) {
    return;
  }
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/u.test(relativePath) ||
    relativePath
      .replaceAll("\\", "/")
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("Git history file path is invalid.");
  }
}

export function parseSessionFilePreviewImageActionRequest(
  input: unknown,
): SessionFilePreviewImageActionRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("Image copy request is invalid.");
  }
  const candidate = input as Partial<SessionFilePreviewImageActionRequest>;
  const point = candidate.point;
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    !point ||
    typeof point !== "object" ||
    !Number.isSafeInteger(point.x) ||
    point.x < 0 ||
    !Number.isSafeInteger(point.y) ||
    point.y < 0
  ) {
    throw new TypeError("Image copy request is invalid.");
  }
  return {
    sessionId: candidate.sessionId,
    point: { x: point.x, y: point.y },
  };
}

export function hasOnlyObjectKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(candidate).every((key) => allowed.has(key));
}

export function assertValidSessionFileResourceRequest(
  input: unknown,
): asserts input is SessionFileResourceRequest {
  assertValidSessionFilePreviewResourceRequest(input);
  if (isSessionFileGitCommitResource(input)) {
    throw new TypeError("Working tree file resource is invalid.");
  }
}

export function assertStrictSessionFileResourceRequest(
  input: unknown,
): asserts input is SessionFileResourceRequest {
  assertValidSessionFileResourceRequest(input);
  const candidate = input as unknown as Record<string, unknown>;
  const allowedKeys = Object.hasOwn(candidate, "absolutePath")
    ? ["sessionId", "absolutePath"]
    : ["sessionId", "rootId", "relativePath"];
  if (!hasOnlyObjectKeys(candidate, allowedKeys)) {
    throw new TypeError("File copy resource is invalid.");
  }
}

export function parseSessionFileObjectCopyRequest(
  input: unknown,
): SessionFileObjectCopyRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("File copy request is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (!hasOnlyObjectKeys(candidate, ["resource"])) {
    throw new TypeError("File copy request is invalid.");
  }
  assertStrictSessionFileResourceRequest(candidate.resource);
  return { resource: candidate.resource };
}

export function parseSessionFileObjectCopyContextMenuRequest(
  input: unknown,
): SessionFileObjectCopyContextMenuRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("File copy context menu request is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (!hasOnlyObjectKeys(candidate, ["resource", "point"])) {
    throw new TypeError("File copy context menu request is invalid.");
  }
  assertStrictSessionFileResourceRequest(candidate.resource);
  const point = candidate.point;
  if (
    !point ||
    typeof point !== "object" ||
    !hasOnlyObjectKeys(point as Record<string, unknown>, ["x", "y"]) ||
    !Number.isSafeInteger((point as Record<string, unknown>).x) ||
    ((point as Record<string, unknown>).x as number) < 0 ||
    !Number.isSafeInteger((point as Record<string, unknown>).y) ||
    ((point as Record<string, unknown>).y as number) < 0
  ) {
    throw new TypeError("File copy context menu request is invalid.");
  }
  return {
    resource: candidate.resource,
    point: {
      x: (point as Record<string, unknown>).x as number,
      y: (point as Record<string, unknown>).y as number,
    },
  };
}

export function parseSessionFileTreeContextMenuRequest(
  input: unknown,
): SessionFileTreePathActionRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("File tree context menu request is invalid.");
  }
  const candidate = input as Record<string, unknown>;
  if (
    !hasOnlyObjectKeys(candidate, [
      "sessionId",
      "rootId",
      "relativePath",
      "nodeKind",
      "point",
      "canInsert",
    ])
  ) {
    throw new TypeError("File tree context menu request is invalid.");
  }
  const point = candidate.point;
  if (
    typeof candidate.sessionId !== "string" ||
    !candidate.sessionId ||
    typeof candidate.rootId !== "string" ||
    !candidate.rootId ||
    typeof candidate.relativePath !== "string" ||
    !["root", "directory", "file"].includes(String(candidate.nodeKind)) ||
    typeof candidate.canInsert !== "boolean" ||
    !point ||
    typeof point !== "object" ||
    !hasOnlyObjectKeys(point as Record<string, unknown>, ["x", "y"]) ||
    !Number.isSafeInteger((point as Record<string, unknown>).x) ||
    ((point as Record<string, unknown>).x as number) < 0 ||
    !Number.isSafeInteger((point as Record<string, unknown>).y) ||
    ((point as Record<string, unknown>).y as number) < 0
  ) {
    throw new TypeError("File tree context menu request is invalid.");
  }
  return {
    sessionId: candidate.sessionId,
    rootId: candidate.rootId,
    relativePath: candidate.relativePath,
    nodeKind:
      candidate.nodeKind as SessionFileTreePathActionRequest["nodeKind"],
    canInsert: candidate.canInsert,
    point: {
      x: (point as Record<string, unknown>).x as number,
      y: (point as Record<string, unknown>).y as number,
    },
  };
}

export function parseMarkdownLinkContextMenuRequest(
  input: unknown,
): MarkdownLinkContextMenuRequest {
  if (!input || typeof input !== "object") {
    throw new TypeError("Markdown link context menu request is invalid.");
  }
  const candidate = input as Partial<MarkdownLinkContextMenuRequest>;
  if (
    !hasOnlyObjectKeys(input as Record<string, unknown>, [
      "target",
      "point",
      "fileContext",
    ])
  ) {
    throw new TypeError("Markdown link context menu request is invalid.");
  }
  const point = candidate.point;
  if (
    typeof candidate.target !== "string" ||
    !candidate.target ||
    !point ||
    typeof point !== "object" ||
    !Number.isSafeInteger(point.x) ||
    point.x < 0 ||
    !Number.isSafeInteger(point.y) ||
    point.y < 0
  ) {
    throw new TypeError("Markdown link context menu request is invalid.");
  }
  let fileContext: MarkdownLinkContextMenuRequest["fileContext"];
  if (candidate.fileContext !== undefined) {
    if (!candidate.fileContext || typeof candidate.fileContext !== "object") {
      throw new TypeError("Markdown link file context is invalid.");
    }
    const rawFileContext = candidate.fileContext as unknown as Record<
      string,
      unknown
    >;
    if (
      !hasOnlyObjectKeys(rawFileContext, ["sessionId", "baseResource"]) ||
      typeof rawFileContext.sessionId !== "string" ||
      !rawFileContext.sessionId
    ) {
      throw new TypeError("Markdown link file context is invalid.");
    }
    if (rawFileContext.baseResource !== undefined) {
      assertValidSessionFilePreviewResourceRequest(rawFileContext.baseResource);
      if (rawFileContext.baseResource.sessionId !== rawFileContext.sessionId) {
        throw new TypeError("Markdown link file context is invalid.");
      }
    }
    fileContext = {
      sessionId: rawFileContext.sessionId,
      ...(rawFileContext.baseResource
        ? {
            baseResource:
              rawFileContext.baseResource as SessionFilePreviewResourceRequest,
          }
        : {}),
    };
  }
  return {
    target: candidate.target,
    point: { x: point.x, y: point.y },
    ...(fileContext ? { fileContext } : {}),
  };
}

type AuxiliaryOwnerWindowKind = "session";

export function resolveAuxiliaryOwnerWindowSender(
  event: IpcMainInvokeEvent,
  parentSessionId: string,
  deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps,
): AuxiliaryOwnerWindowKind {
  const window = deps.resolveEventWindow(event);
  if (!window) {
    throw new Error(
      "Auxiliary session IPC is only available from the target Session window.",
    );
  }
  if (deps.resolveSessionWindow(parentSessionId) === window) {
    return "session";
  }
  throw new Error(
    "Auxiliary session IPC is only available from the target Session window.",
  );
}

export function assertAuxiliaryOwnerWindowSender(
  event: IpcMainInvokeEvent,
  parentSessionId: string,
  deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps,
): void {
  resolveAuxiliaryOwnerWindowSender(event, parentSessionId, deps);
}

export function assertAuxiliaryCreateModeForOwner(
  ownerWindowKind: AuxiliaryOwnerWindowKind,
  input: CreateAuxiliarySessionInput,
): void {
  if (input.runtimeSelection !== "latest-session") {
    throw new Error(
      "Session window Auxiliary creation requires latest-session runtime selection.",
    );
  }
  if (
    Object.hasOwn(input, "model") ||
    Object.hasOwn(input, "reasoningEffort") ||
    Object.hasOwn(input, "approvalMode") ||
    Object.hasOwn(input, "codexSandboxMode") ||
    Object.hasOwn(input, "codexSpeed") ||
    Object.hasOwn(input, "codexReviewer") ||
    Object.hasOwn(input, "customAgentName")
  ) {
    throw new Error(
      "Session window Auxiliary creation cannot specify runtime options directly.",
    );
  }
}

export async function getAuxiliarySessionForMutation(
  auxiliaryDeps: Pick<MainIpcAuxiliaryDepsRequired, "getAuxiliarySession">,
  auxiliarySessionId: string,
): Promise<AuxiliarySession> {
  const session = await auxiliaryDeps.getAuxiliarySession(auxiliarySessionId);
  if (!session) {
    throw new Error("The Auxiliary Session could not be found.");
  }
  return session;
}

export async function resolveWindowAuxiliarySessionId(
  deps: MainIpcAuxiliaryLookupDeps,
  parentSessionId: string,
  value: unknown,
): Promise<string | undefined> {
  const auxiliarySessionId = typeof value === "string" ? value.trim() : "";
  if (!auxiliarySessionId) {
    return undefined;
  }
  if (!deps.getAuxiliarySession) {
    throw new Error("Auxiliary Session navigation is not wired.");
  }
  const auxiliarySession = await deps.getAuxiliarySession(auxiliarySessionId);
  if (!auxiliarySession) {
    throw new Error("The target Auxiliary Session could not be found.");
  }
  if (auxiliarySession.parentSessionId !== parentSessionId) {
    throw new Error("The Auxiliary Session parent does not match.");
  }
  return auxiliarySessionId;
}

import type {
  MainIpcAuxiliaryDepsRequired,
  MainIpcAuxiliaryLookupDeps,
  MainIpcEventWindowDeps,
  MainIpcFilePreviewWindowDeps,
  MainIpcHomeWindowDeps,
  MainIpcMemoryReviewWindowDeps,
  MainIpcSessionMonitorWindowDeps,
  MainIpcSessionWindowDeps,
  MainIpcSettingsWindowDeps,
  MainIpcWorkspaceValidationDeps,
} from "./contracts.js";
