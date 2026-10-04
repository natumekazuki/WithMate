import type {
  FileRootGitHistoryDiffRequest,
  SessionFilePreviewResourceRequest,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
  SessionFilePreviewWindowPayload,
  SessionFilePreviewWindowView,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileGitCommitResource,
  resolveSessionFileGitCommitPreviewWindowTitle,
  resolveSessionFilePreviewWindowTitle,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";
import type { FileRootGitChangesService } from "./file-root-git-changes-service.js";
import type { SessionFileExplorerService } from "./session-file-explorer-service.js";

export type SessionFilePreviewServiceDeps = {
  explorer: Pick<SessionFileExplorerService, "resolvePreviewTarget" | "inspectFile">;
  gitChanges: Pick<FileRootGitChangesService, "getHistoryDiff" | "resolveHistoryFilePreview">;
  getOwnerSessionId(sessionId: string): Promise<string | null>;
  openPreviewWindow(payload: SessionFilePreviewWindowPayload): Promise<{ disposition: "created" | "focused" }>;
  openExternalUrl(target: string): Promise<OpenPathResult>;
  openDirectory(targetPath: string, assertSender: () => Promise<void>): Promise<OpenPathResult>;
};

/** Owns detached preview navigation; filesystem authorization and window identity keep their existing owners. */
export class SessionFilePreviewService {
  constructor(private readonly deps: SessionFilePreviewServiceDeps) {}

  async open(
    request: SessionFilePreviewWindowOpenRequest,
    assertLinkSender: () => Promise<void>,
  ): Promise<SessionFilePreviewWindowOpenResult> {
    if (request.kind === "history-diff") {
      return this.openHistoryDiff(request.request);
    }
    if (request.kind === "link") {
      return this.openLink(request, assertLinkSender);
    }
    return this.openResource(request.resource, request.view ?? { kind: "preview" });
  }

  private async requireOwnerSessionId(sessionId: string): Promise<string> {
    const ownerSessionId = await this.deps.getOwnerSessionId(sessionId);
    if (!ownerSessionId) {
      throw new Error("The owning Session could not be resolved.");
    }
    return ownerSessionId;
  }

  private async openHistoryDiff(request: FileRootGitHistoryDiffRequest): Promise<SessionFilePreviewWindowOpenResult> {
    const result = await this.deps.gitChanges.getHistoryDiff(request);
    const target = request.relativePath ?? "Git history diff";
    if (result.status !== "ok") {
      return { status: "failed", targetType: "local-file", target, message: result.message };
    }
    try {
      const ownerSessionId = await this.requireOwnerSessionId(request.sessionId);
      const { disposition } = await this.deps.openPreviewWindow({
        historyDiff: {
          request,
          patch: result.patch,
          previewResource: "previewResource" in result ? result.previewResource : null,
          previewBeforeResource: "previewBeforeResource" in result ? result.previewBeforeResource : null,
          previewAfterResource: "previewAfterResource" in result ? result.previewAfterResource : null,
        },
        ownerSessionId,
        windowTitle: resolveSessionFilePreviewWindowTitle(request.relativePath ?? "Git Diff"),
      });
      return { status: "opened", targetType: "preview-window", disposition, historyDiff: request };
    } catch (error) {
      return {
        status: "failed", targetType: "local-file", target,
        message: error instanceof Error ? error.message : "The Git history diff could not be opened.",
      };
    }
  }

  private async openLink(
    request: Extract<SessionFilePreviewWindowOpenRequest, { kind: "link" }>,
    assertLinkSender: () => Promise<void>,
  ): Promise<SessionFilePreviewWindowOpenResult> {
    const resolution = await this.deps.explorer.resolvePreviewTarget(request.sessionId, request.target, request.baseResource);
    if (resolution.type === "external-url") {
      const opened = await this.deps.openExternalUrl(resolution.target);
      return opened.status === "opened"
        ? { status: "opened", targetType: "external-url", target: opened.target }
        : {
            status: "failed", targetType: "unknown", target: opened.target,
            message: opened.message ?? "The external URL could not be opened.",
          };
    }
    if (resolution.type === "directory") {
      const opened = await this.deps.openDirectory(resolution.targetPath, assertLinkSender);
      return opened.status === "opened"
        ? { status: "opened", targetType: "local-directory", target: opened.target }
        : {
            status: opened.status === "not-found" ? "not-found" : "failed",
            targetType: "local-path", target: opened.target,
            message: opened.message ?? "The directory could not be opened.",
          };
    }
    if (resolution.type !== "file") {
      return {
        status: resolution.type,
        targetType: resolution.type === "not-previewable" ? "local-file" : "local-path",
        target: resolution.targetPath,
        message: resolution.message,
      };
    }
    return this.openResource(resolution.resource, { kind: "preview" });
  }

  private async openResource(
    resource: SessionFilePreviewResourceRequest,
    view: SessionFilePreviewWindowView,
  ): Promise<SessionFilePreviewWindowOpenResult> {
    if (!resource) {
      return {
        status: "failed", targetType: "unknown", target: "",
        message: "The preview resource could not be resolved.",
      };
    }
    try {
      const fileName = isSessionFileGitCommitResource(resource)
        ? (await this.deps.gitChanges.resolveHistoryFilePreview(resource)).name
        : (await this.deps.explorer.inspectFile(resource)).name;
      const ownerSessionId = await this.requireOwnerSessionId(resource.sessionId);
      const { disposition } = await this.deps.openPreviewWindow({
        resource,
        ownerSessionId,
        windowTitle: isSessionFileGitCommitResource(resource)
          ? resolveSessionFileGitCommitPreviewWindowTitle(fileName, resource.commitId)
          : resolveSessionFilePreviewWindowTitle(fileName),
        view,
      });
      return { status: "opened", targetType: "preview-window", disposition, resource };
    } catch (error) {
      return {
        status: "failed", targetType: "local-file",
        target: "absolutePath" in resource ? resource.absolutePath : resource.relativePath,
        message: error instanceof Error ? error.message : "The file preview could not be opened.",
      };
    }
  }
}
