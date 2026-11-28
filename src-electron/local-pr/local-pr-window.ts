import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { localPrGuiInput, type LocalPrData, type LocalPrInput, type LocalPrOperation, type LocalPrResult } from "../../src-shared/local-pr/local-pr-contract.js";
import { LOCAL_PR_CHANGED, LOCAL_PR_EXECUTE, LOCAL_PR_INSPECT_IMAGE, LOCAL_PR_OPEN_WINDOW, LOCAL_PR_PICK_ATTACHMENT, LOCAL_PR_READ_IMAGE_CHUNK, LOCAL_PR_SAVE_CLIPBOARD_IMAGE, LOCAL_PR_OPEN_ATTACHMENT, localPrClipboardImageInput, localPrImageChunkInput, localPrImageInput, openLocalPrWindowInput } from "../../src-shared/local-pr/local-pr-ipc.js";
import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";
import type { MainSessionTarget } from "../../src-shared/session/session-target.js";
import { assertNotHtmlPreviewSender } from "../files/html-preview-isolation.js";
import type { SessionFileExplorerService } from "../files/session-file-explorer-service.js";
import type { IpcHandleRegistrar } from "../ipc/contracts.js";
import { failure, type LocalPrApplication } from "./local-pr-application.js";

type Repository = { repositoryId: string; workspacePath: string };
type Source<Repo> = { actor: MainSessionTarget; repository: Repo; generation: object };
type Entry<Repo> = { window: BrowserWindow; source: Source<Repo>; approvalPending: boolean };

/** Main owns PR Window admission; the renderer cannot choose its repository or actor. */
export class LocalPrWindowService<Repo extends Repository> {
  private readonly entries = new Map<number, Entry<Repo>>();

  constructor(private readonly deps: {
    resolveOwner(actor: MainSessionTarget): Promise<Source<Repo> | null>;
    sessionWindow(id: string): BrowserWindow | null;
    createWindow(): BrowserWindow;
    loadWindow(window: BrowserWindow): Promise<void>;
    application: Pick<LocalPrApplication<Repo>, "execute">;
    pickAttachment(window: BrowserWindow, workspacePath: string): Promise<string[]>;
    saveClipboardImage(input: ReturnType<typeof localPrClipboardImageInput.parse>): Promise<string>;
    openAttachment(target: string): Promise<OpenPathResult>;
    imageReader(): Pick<SessionFileExplorerService, "inspectImage" | "readImageChunk">;
  }) {}

  /** Register only narrow IPC with a separate renderer and explicit main-frame checks. */
  register(ipc: IpcHandleRegistrar): void {
    ipc.handle(LOCAL_PR_OPEN_WINDOW, (event, raw) => this.open(event, openLocalPrWindowInput.parse(raw)));
    ipc.handle(LOCAL_PR_PICK_ATTACHMENT, async (event) => {
      const { entry, assertCurrent } = this.requirePrWindow(event);
      await assertCurrent();
      const paths = await this.deps.pickAttachment(entry.window, entry.source.repository.workspacePath);
      await assertCurrent();
      return paths;
    });
    ipc.handle(LOCAL_PR_SAVE_CLIPBOARD_IMAGE, async (event, raw) => {
      const { assertCurrent } = this.requirePrWindow(event);
      const input = localPrClipboardImageInput.parse(raw);
      await assertCurrent();
      return this.deps.saveClipboardImage(input);
    });
    ipc.handle(LOCAL_PR_OPEN_ATTACHMENT, async (event, raw) => {
      const { assertCurrent } = this.requirePrWindow(event);
      const target = localPrImageInput.parse({ target: raw }).target;
      await assertCurrent();
      return this.deps.openAttachment(target);
    });
    ipc.handle(LOCAL_PR_INSPECT_IMAGE, async (event, raw) => {
      const { entry, assertCurrent } = this.requirePrWindow(event);
      const { target } = localPrImageInput.parse(raw);
      this.assertAbsoluteImage(target);
      await assertCurrent();
      const result = await this.deps.imageReader().inspectImage({ target, sessionId: entry.source.actor.sessionId });
      await assertCurrent();
      return result;
    });
    ipc.handle(LOCAL_PR_READ_IMAGE_CHUNK, async (event, raw) => {
      const { entry, assertCurrent } = this.requirePrWindow(event);
      const input = localPrImageChunkInput.parse(raw);
      this.assertAbsoluteImage(input.target);
      await assertCurrent();
      const result = await this.deps.imageReader().readImageChunk({ ...input, sessionId: entry.source.actor.sessionId });
      await assertCurrent();
      return result;
    });
    ipc.handle(LOCAL_PR_EXECUTE, async (event, operation: unknown, input: unknown) => {
      if (typeof operation !== "string" || !Object.hasOwn(localPrGuiInput, operation)) return failure("PR_INVALID_REQUEST", "Unknown Pull Request operation.");
      let owner: ReturnType<LocalPrWindowService<Repo>["requirePrWindow"]>;
      try { owner = this.requirePrWindow(event); }
      catch { return failure("PR_FORBIDDEN", "Use the owning Pull Requests window."); }
      const { entry, assertCurrent } = owner;

      // Approval is made in an app-owned native confirmation, and rechecked in the common PR service.
      if (operation === "approve") return this.approve(entry, input, assertCurrent);
      try {
        return await this.deps.application.execute(entry.source.repository, entry.source.actor, "gui", operation as LocalPrOperation, input, assertCurrent);
      } catch (error) {
        return failure("PR_OPERATION_FAILED", error instanceof Error ? error.message : String(error), "unknown");
      }
    });
  }

  private assertAbsoluteImage(target: string): void {
    if (!/^file:/i.test(target) && !path.isAbsolute(target)) {
      throw new Error("Pull Request images require an absolute path.");
    }
  }

  private requirePrWindow(event: IpcMainInvokeEvent) {
    const frame = event.senderFrame;
    const window = this.mainFrameWindow(event);
    const entry = this.entries.get(window.id);
    if (!entry || entry.window !== window || !frame || !this.isPrDocument(frame.url)) throw new Error("Use the owning Pull Requests window.");
    const assertCurrent = async () => {
      const checkWindow = () => {
        if (window.isDestroyed() || this.entries.get(window.id) !== entry || event.sender.isDestroyed()
          || event.sender.mainFrame !== frame || !this.isPrDocument(frame.url)) throw new Error("The Pull Requests window is no longer current.");
      };
      checkWindow();
      const current = await this.deps.resolveOwner(entry.source.actor);
      checkWindow();
      if (!current || current.generation !== entry.source.generation || !isDeepStrictEqual(current.actor, entry.source.actor)
        || current.repository.repositoryId !== entry.source.repository.repositoryId || current.repository.workspacePath !== entry.source.repository.workspacePath) {
        throw new Error("The Pull Requests window's Session or repository changed. Reopen it from the Session.");
      }
    };
    return { entry, assertCurrent };
  }

  /** Broadcast invalidation only; each open Window still reads its authorized repository. */
  notify(repositoryId: string): void {
    for (const { window, source } of this.entries.values()) {
      if (source.repository.repositoryId !== repositoryId || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) continue;
      try { window.webContents.send(LOCAL_PR_CHANGED); }
      catch { /* A renderer closing during notification can reload from the source of truth. */ }
    }
  }

  /** Close a removed Session's view, or all views on storage-generation changes. */
  close(sessionId?: string): void {
    for (const [id, { window, source }] of this.entries) {
      if (sessionId && source.actor.sessionId !== sessionId) continue;
      this.entries.delete(id);
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /** Resolve the owning saved Session before opening a repository view. */
  private async open(event: IpcMainInvokeEvent, actor: MainSessionTarget): Promise<void> {
    const senderWindow = this.mainFrameWindow(event);
    const frame = event.senderFrame;
    if (this.deps.sessionWindow(actor.sessionId) !== senderWindow) throw new Error("Only the owning Session can open Pull Requests.");
    const source = await this.deps.resolveOwner(actor);
    if (!source || senderWindow.isDestroyed() || this.deps.sessionWindow(actor.sessionId) !== senderWindow || event.sender.mainFrame !== frame) {
      throw new Error("The Session's Git repository is unavailable.");
    }

    // Reuse only an exact source; another Session in the same repo can have its own review position.
    for (const entry of this.entries.values()) {
      if (!entry.window.isDestroyed() && entry.source.generation === source.generation && isDeepStrictEqual(entry.source.actor, actor)
        && entry.source.repository.repositoryId === source.repository.repositoryId && entry.source.repository.workspacePath === source.repository.workspacePath) {
        entry.window.show();
        entry.window.focus();
        return;
      }
    }
    const window = this.deps.createWindow();
    const entry: Entry<Repo> = { window, source, approvalPending: false };
    this.entries.set(window.id, entry);
    window.once("closed", () => { this.entries.delete(window.id); });
    window.webContents.on("will-navigate", (navigation) => navigation.preventDefault());
    window.webContents.on("will-redirect", (navigation) => navigation.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await this.deps.loadWindow(window);
      if (!window.isDestroyed()) window.show();
    } catch (error) {
      this.entries.delete(window.id);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  /** Only this native interaction can create the GUI approval for the displayed pair. */
  private async approve(entry: Entry<Repo>, raw: unknown, assertCurrent: () => Promise<void>): Promise<LocalPrResult<"approve">> {
    const parsed = localPrGuiInput.approve.safeParse(raw);
    if (!parsed.success) return failure("PR_INVALID_REQUEST", "Select the submission and target to approve.");
    if (entry.approvalPending) return failure("PR_APPROVAL_PENDING", "An approval confirmation is already open.");
    entry.approvalPending = true;
    const { actor, repository } = entry.source;
    const input: LocalPrInput<"approve"> = parsed.data;
    let confirmed = false;
    try {
      const read = await this.deps.application.execute(repository, actor, "gui", "pr_get", { prId: input.prId }, assertCurrent);
      if (!read.ok) return read;
      const pr: LocalPrData<"pr_get"> = read.data;
      const version = pr.versions.find((item) => item.version === input.version);
      if (pr.state !== "open" || pr.latestVersion !== input.version || pr.currentTargetCommit !== input.targetCommit
        || version?.targetCommit !== input.targetCommit || version.headCommit !== input.headCommit) {
        return failure("PR_APPROVAL_STALE", "The submission or target changed. Review the current diff before approving.");
      }
      await assertCurrent();
      const response = await dialog.showMessageBox(entry.window, {
        type: "question", title: "Approve Pull Request", message: "Approve This Submission?",
        detail: `${pr.title}\nSubmission ${input.version}: ${input.headCommit}\n${pr.targetBranch}: ${input.targetCommit}`,
        buttons: ["Cancel", "Approve"], cancelId: 0, defaultId: 0, noLink: true,
      });
      if (response.response !== 1) return failure("PR_APPROVAL_CANCELED", "Approval was canceled.");
      confirmed = true;
      return await this.deps.application.execute(repository, actor, "gui", "approve", input, assertCurrent);
    } catch (error) {
      return failure("PR_APPROVAL_FAILED", error instanceof Error ? error.message : String(error), confirmed ? "unknown" : "none");
    } finally {
      entry.approvalPending = false;
    }
  }

  /** Top-level app sender only, not a subframe or an HTML preview guest. */
  private mainFrameWindow(event: IpcMainInvokeEvent): BrowserWindow {
    assertNotHtmlPreviewSender(event);
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error("Invalid Pull Requests window sender.");
    return wnd;
  }

  /** The locked dedicated Window loads only the packaged or development PR document. */
  private isPrDocument(value: string): boolean {
    const url = URL.parse(value);
    return !!url && ["file:", "http:"].includes(url.protocol) && url.pathname.endsWith("/local-pr.html");
  }
}
