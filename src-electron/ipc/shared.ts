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
} from "../../src-shared/file-explorer/file-explorer-contract.js";

import { resolveWorkspaceDirectoryValidationMessage } from "../../src-shared/window/workspace-directory-validation.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { CancelSessionRunRequest } from "../../src-shared/session/runtime-state.js";

/** キャンセル対象を Session・incarnation・実行の種類と ID に絞って取り出す。空白だけの ID や未対応の実行種別は拒否する。 */
export function readCancelSessionRunRequest(
  value: unknown,
): CancelSessionRunRequest {
  const request = value as Partial<CancelSessionRunRequest> | null | undefined;
  const execution = request?.execution;
  if (
    typeof request?.sessionId !== "string" ||
    !request.sessionId.trim() ||
    typeof request.incarnationId !== "string" ||
    !request.incarnationId.trim() ||
    (execution?.kind !== "turn" && execution?.kind !== "receipt") ||
    typeof execution.id !== "string" ||
    !execution.id.trim()
  ) {
    throw new Error("The cancellation target is invalid.");
  }
  return {
    sessionId: request.sessionId,
    incarnationId: request.incarnationId,
    execution: { kind: execution.kind, id: execution.id },
  };
}

/** Workspace として利用できるパスか検証し、失敗時は結果に対応する利用者向けメッセージを例外にする。 */
export async function assertUsableWorkspaceDirectory(
  targetPath: unknown,
  deps: MainIpcWorkspaceValidationDeps,
): Promise<void> {
  const result = await deps.validateWorkspaceDirectory(targetPath);
  if (!result.valid) {
    throw new Error(resolveWorkspaceDirectoryValidationMessage(result));
  }
}

/** ダイアログの親ウィンドウを送信元、Home の順に探し、どちらもなければ親を指定しない。 */
export function resolveTargetWindow(
  event: IpcMainInvokeEvent,
  deps: MainIpcEventWindowDeps & MainIpcHomeWindowDeps,
): BrowserWindow | undefined {
  return (
    deps.resolveEventWindow(event) ?? deps.resolveHomeWindow() ?? undefined
  );
}

/** 送信元を解決し、Settings ウィンドウ以外なら要求を拒否する。 */
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

/** 送信元が現在の Home ウィンドウと一致しない要求を拒否する。 */
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

/** Monitor のコンテキストメニュー要求を Home または Session Monitor に限る。 */
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

/** 単件削除を Home、Settings、対象 Session のウィンドウからだけ許す。 */
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

/** 送信元ウィンドウを対象 Session に登録されたウィンドウと照合し、一致しなければ拒否する。 */
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

/** 所有 Session からの要求なら `null` を返し、別ウィンドウなら現在表示している Preview リソースを返す。どちらにも該当しない送信元は拒否する。 */
export async function assertSessionFileExplorerSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      /** ファイル操作の対象を所有する Main Session の ID を解決する。 */
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

/** 独立した Preview ウィンドウには許可せず、対象ファイルを所有する Session ウィンドウに限定する。 */
export async function assertOwningSessionFileExplorerSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps & {
      /** ファイル操作の対象を所有する Main Session の ID を解決する。 */
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

/** 作業ツリーのリソースは所有 Session からも操作できる。ほかは、要求されたリソースと現在の Preview が一致する場合だけ許す。 */
export async function assertSessionFileResourceSender(
  event: IpcMainInvokeEvent,
  resource: SessionFilePreviewResourceRequest,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      /** 要求リソースの Session ID から、ファイル操作の所有元を解決する。 */
      getSessionFileExplorerOwnerSessionId(
        sessionId: string,
      ): Awaitable<string | null>;
    },
  representation: "source" | "absolute" = isSessionFileGitCommitResource(
    resource,
  )
    ? "source"
    : "absolute",
): Promise<void> {
  const ownerSessionId = await deps.getSessionFileExplorerOwnerSessionId(
    resource.sessionId,
  );
  const window = deps.resolveEventWindow(event);
  if (
    ownerSessionId &&
    window &&
    deps.resolveSessionWindow(ownerSessionId) === window &&
    !isSessionFileGitCommitResource(resource)
  ) {
    return;
  }
  const currentResource = window
    ? deps.getFilePreviewWindowResource(
        window,
        resource.sessionId,
        representation,
      )
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

/** 所有 Session からのリンクを許し、独立したプレビューからは、現在表示中のリソースと一致する解決起点を要求する。 */
export async function assertSessionFileLinkSender(
  event: IpcMainInvokeEvent,
  sessionId: string,
  baseResource: SessionFilePreviewResourceRequest | undefined,
  deps: MainIpcEventWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcFilePreviewWindowDeps & {
      /** リンクの対象を所有する Main Session の ID を解決する。 */
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
    ? deps.getFilePreviewWindowResource(
        window,
        sessionId,
        baseResource && isSessionFileGitCommitResource(baseResource)
          ? "source"
          : "absolute",
      )
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

/** 指定された Session に対する Preview リソースの入力形式を検証する。絶対パス、ルート相対、コミット内ファイルを区別する。 */
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

/** Git 履歴の照会対象となる Session・ルート・リポジトリ ID の形式を検証する。 */
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

/** Git 履歴の特定コミットを、小文字の 40 桁または 64 桁の十六進 ID に限る。 */
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

/** 比較元・比較先を表す HEAD、参照名、コミット ID を種類ごとに検証する。 */
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

/** Git 比較の方式、元と先の参照、解決済みコミット ID、および任意ではなく `null` で表す比較基点の欠如を検証する。 */
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

/** Git 履歴の差分要求を検証する。比較指定と単独コミット指定を分け、ファイル指定があれば相対パスとして検査する。 */
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

/** 省略・`null` または先頭ゼロのない 9 桁以下の十進カーソルを認める。 */
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

/** ブランチ絞り込みを表す `null` または前後の空白や制御文字を含まない非空文字列を検証する。 */
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

/** Git 履歴のコミット一覧要求を共通の照会対象とブランチ絞り込みの規則に照らして検証する。 */
export function assertValidGitHistoryCommitsRequest(
  input: unknown,
): asserts input is FileRootGitHistoryCommitsRequest {
  assertValidGitHistoryRequest(input);
  assertValidGitHistoryBranch((input as { branch?: unknown }).branch);
}

/** 省略可能な Git 履歴の相対パスを検査し、絶対パスや空・`.`・`..` の要素を拒否する。 */
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

/** 画像アクションの Session と非負の整数座標を取り出し、リンク指定があれば同じ Session の基点リソースを検証する。 */
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
  const image = candidate.image;
  if (image !== undefined) {
    if (
      !image ||
      typeof image !== "object" ||
      typeof image.target !== "string" ||
      !image.target.trim()
    ) {
      throw new TypeError("Image copy source is invalid.");
    }
    if (image.baseResource !== undefined) {
      assertValidSessionFilePreviewResourceRequest(
        image.baseResource,
        candidate.sessionId,
      );
    }
  }
  return {
    sessionId: candidate.sessionId,
    point: { x: point.x, y: point.y },
    ...(image
      ? {
          image: {
            target: image.target,
            ...(image.baseResource ? { baseResource: image.baseResource } : {}),
          },
        }
      : {}),
  };
}

/** 対象の列挙可能な自身の文字列キーが、許可一覧に収まるかを判定する。 */
export function hasOnlyObjectKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(candidate).every((key) => allowed.has(key));
}

/** 作業ツリーのファイル用入力を検証し、コミット内のリソースは拒否する。 */
export function assertValidSessionFileResourceRequest(
  input: unknown,
): asserts input is SessionFileResourceRequest {
  assertValidSessionFilePreviewResourceRequest(input);
  if (isSessionFileGitCommitResource(input)) {
    throw new TypeError("Working tree file resource is invalid.");
  }
}

/** 作業ツリーのファイル入力に対して、絶対パス形式とルート相対形式それぞれの許可キーだけを認める。 */
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

/** ファイル実体をコピーする要求から、余分なキーを拒否して作業ツリーのリソースを取り出す。 */
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

/** ファイル実体コピー用のリソースとメニュー位置を検証する。余分なキーと負数・小数の座標は拒否する。 */
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

/** ファイルツリーのメニュー要求を検証し、対象ノードと座標、挿入可否を取り出す。 */
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

/** Markdown リンクのターゲットと座標を保って取り出し、ファイル文脈があれば Session と基点の整合を検査する。 */
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

/** Auxiliary の操作元として認める親 Session ウィンドウの区分。 */
type AuxiliaryOwnerWindowKind = "session";

/** 送信元と指定された親 Session のウィンドウが一致した場合に限り、所有元の区分を返す。 */
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

/** Auxiliary を所有する親 Session のウィンドウ以外を拒否する。 */
export function assertAuxiliaryOwnerWindowSender(
  event: IpcMainInvokeEvent,
  parentSessionId: string,
  deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps,
): void {
  resolveAuxiliaryOwnerWindowSender(event, parentSessionId, deps);
}

/** Session ウィンドウからの Auxiliary 作成は最新 Session に基づく実行設定だけを許し、モデルなどの直接指定を拒否する。 */
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
    Object.hasOwn(input, "withMateReviewerExplicit") ||
    Object.hasOwn(input, "customAgentName")
  ) {
    throw new Error(
      "Session window Auxiliary creation cannot specify runtime options directly.",
    );
  }
}

/** 変更対象の保存済み Auxiliary を取得し、見つからなければ例外にする。所有元の照合は呼び出し側で行う。 */
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

/** ウィンドウ遷移に使う Auxiliary ID を解決し、指定がなければ省略する。指定があれば実在と親 Session の一致を確認する。 */
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
  MainIpcSessionMonitorWindowDeps,
  MainIpcSessionWindowDeps,
  MainIpcSettingsWindowDeps,
  MainIpcWorkspaceValidationDeps,
} from "./contracts.js";
