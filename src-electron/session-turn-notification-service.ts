import { createHash } from "node:crypto";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

import type { Session } from "../src/session-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

const RESPONSE_PREVIEW_MAX_GRAPHEMES = 40;
const RESPONSE_PREVIEW_MAX_SOURCE_CODE_UNITS = 65_536;
const RESPONSE_PREVIEW_SENTENCE_ENDINGS = new Set(["。", "！", "？", "!", "?"]);
const MARKDOWN_BLOCK_NODE_TYPES = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
]);
const MARKDOWN_HIDDEN_NODE_TYPES = new Set([
  "definition",
  "footnoteDefinition",
  "html",
  "inlineMath",
  "math",
]);
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  lang?: string | null;
  children?: MarkdownNode[];
};

function projectMarkdownVisibleText(node: MarkdownNode): string {
  if (MARKDOWN_HIDDEN_NODE_TYPES.has(node.type)) {
    return "";
  }
  if (node.type === "text" || node.type === "inlineCode") {
    return node.value ?? "";
  }
  if (node.type === "code") {
    return node.lang?.trim().toLowerCase() === "mermaid"
      ? ""
      : node.value ?? "";
  }
  if (node.type === "image" || node.type === "imageReference") {
    return "";
  }
  if (node.type === "break") {
    return " ";
  }

  const childText = (node.children ?? [])
    .map(projectMarkdownVisibleText)
    .filter(Boolean);
  return childText.join(MARKDOWN_BLOCK_NODE_TYPES.has(node.type) ? " " : "");
}

function toNotificationPlainText(value: string): string {
  const syntaxTree = fromMarkdown(value, {
    extensions: [gfm(), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  return projectMarkdownVisibleText(syntaxTree as MarkdownNode)
    .replace(/\s+/g, " ")
    .trim();
}

function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function buildResponsePreview(assistantText: string): string | null {
  if (assistantText.length > RESPONSE_PREVIEW_MAX_SOURCE_CODE_UNITS) {
    return null;
  }

  const plainText = toNotificationPlainText(assistantText);
  if (!plainText) {
    return null;
  }

  const graphemes = splitGraphemes(plainText);
  if (graphemes.length <= RESPONSE_PREVIEW_MAX_GRAPHEMES) {
    return plainText;
  }

  const candidate = graphemes.slice(0, RESPONSE_PREVIEW_MAX_GRAPHEMES);
  let sentenceEndIndex = -1;
  for (let index = 0; index < candidate.length; index += 1) {
    if (RESPONSE_PREVIEW_SENTENCE_ENDINGS.has(candidate[index] ?? "")) {
      sentenceEndIndex = index;
    }
  }

  const truncated = sentenceEndIndex >= 0
    ? candidate.slice(0, sentenceEndIndex + 1)
    : candidate;
  return `${truncated.join("").trimEnd()}…`;
}

export type SessionTurnNotificationOptions<TIcon> = {
  id: string;
  groupId: string;
  title: string;
  body: string;
  icon?: TIcon;
};

export type SessionTurnNotificationCloseReason =
  | "userCanceled"
  | "applicationHidden"
  | "timedOut";

export type SessionTurnNotificationHandle = {
  show(): void;
  close(): void;
  onClick(listener: () => void): void;
  onClose(listener: (reason?: SessionTurnNotificationCloseReason) => void): void;
  onFailed(listener: (error: unknown) => void): void;
};

export type SessionTurnNotificationServiceDeps<TIcon> = {
  platform: NodeJS.Platform;
  isNotificationSupported(): boolean;
  isNotificationEnabled(): boolean;
  isResponsePreviewEnabled(): boolean;
  isSessionWindowFocused(sessionId: string): boolean;
  loadCharacterIcon(iconPath: string): TIcon | null;
  createNotification(options: SessionTurnNotificationOptions<TIcon>): SessionTurnNotificationHandle;
  getSession(sessionId: string): Awaitable<Session | null>;
  openSessionWindow(sessionId: string): Awaitable<void>;
  openHomeWindow(): Awaitable<void>;
  logWarning(event: string, sessionId: string, error?: unknown): void;
};

export class SessionTurnNotificationService<TIcon> {
  private static readonly notificationGroupId = "WithMateSessions";
  private readonly trackedNotifications = new Map<string, SessionTurnNotificationHandle>();

  constructor(private readonly deps: SessionTurnNotificationServiceDeps<TIcon>) {}

  notifyTurnCompleted(session: Session, lastNonEmptyAssistantMessageText = ""): boolean {
    const sessionId = session.id;
    if (!this.isEligible(sessionId)) {
      return false;
    }

    const content = this.buildNotificationContent(session, lastNonEmptyAssistantMessageText);
    const options: SessionTurnNotificationOptions<TIcon> = {
      id: this.buildNotificationId(sessionId),
      groupId: SessionTurnNotificationService.notificationGroupId,
      ...content,
    };
    const icon = this.loadCharacterIcon(session);
    if (icon !== null) {
      options.icon = icon;
    }

    this.closePreviousNotification(sessionId);

    let notification: SessionTurnNotificationHandle;
    try {
      notification = this.deps.createNotification(options);
    } catch (error) {
      this.deps.logWarning("create-failed", sessionId, error);
      return false;
    }

    this.trackNotification(sessionId, notification);

    try {
      notification.show();
      return true;
    } catch (error) {
      this.clearIfCurrent(sessionId, notification);
      this.deps.logWarning("show-failed", sessionId, error);
      return false;
    }
  }

  private trackNotification(
    sessionId: string,
    notification: SessionTurnNotificationHandle,
  ): void {
    notification.onClick(() => {
      this.clearIfCurrent(sessionId, notification);
      void this.openNotificationTarget(sessionId);
    });
    notification.onClose((reason) => {
      if (reason === "userCanceled" || reason === "applicationHidden") {
        this.clearIfCurrent(sessionId, notification);
      }
    });
    notification.onFailed((error) => {
      this.clearIfCurrent(sessionId, notification);
      this.deps.logWarning("delivery-failed", sessionId, error);
    });
    this.trackedNotifications.set(sessionId, notification);
  }

  private isEligible(sessionId: string): boolean {
    try {
      return this.deps.platform === "win32"
        && this.deps.isNotificationSupported()
        && this.deps.isNotificationEnabled()
        && !this.deps.isSessionWindowFocused(sessionId);
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", sessionId, error);
      return false;
    }
  }

  dismissSessionNotification(sessionId: string): void {
    this.closeTrackedNotification(sessionId, "dismiss-close-failed");
  }

  private buildNotificationContent(
    session: Session,
    lastNonEmptyAssistantMessageText: string,
  ): Pick<SessionTurnNotificationOptions<TIcon>, "title" | "body"> {
    const genericContent = {
      title: "WithMate",
      body: `「${session.taskTitle.trim() || "Session"}」のターンが完了しました`,
    };
    try {
      if (!this.deps.isResponsePreviewEnabled()) {
        return genericContent;
      }
    } catch (error) {
      this.deps.logWarning("preview-setting-check-failed", session.id, error);
      return genericContent;
    }

    try {
      const preview = buildResponsePreview(lastNonEmptyAssistantMessageText);
      if (!preview) {
        return genericContent;
      }
      return {
        title: session.taskTitle.trim() || "Session",
        body: preview,
      };
    } catch (error) {
      this.deps.logWarning("preview-build-failed", session.id, error);
      return genericContent;
    }
  }

  private loadCharacterIcon(session: Session): TIcon | null {
    const iconPath = session.characterIconPath.trim();
    if (!iconPath) {
      return null;
    }

    try {
      return this.deps.loadCharacterIcon(iconPath);
    } catch (error) {
      this.deps.logWarning("icon-load-failed", session.id, error);
      return null;
    }
  }

  private buildNotificationId(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("hex");
  }

  private closePreviousNotification(sessionId: string): void {
    this.closeTrackedNotification(sessionId, "replace-close-failed");
  }

  private closeTrackedNotification(sessionId: string, failureEvent: string): void {
    const previousNotification = this.trackedNotifications.get(sessionId);
    if (!previousNotification) {
      return;
    }

    this.trackedNotifications.delete(sessionId);
    try {
      previousNotification.close();
    } catch (error) {
      this.deps.logWarning(failureEvent, sessionId, error);
    }
  }

  private clearIfCurrent(sessionId: string, notification: SessionTurnNotificationHandle): void {
    if (this.trackedNotifications.get(sessionId) === notification) {
      this.trackedNotifications.delete(sessionId);
    }
  }

  private async openNotificationTarget(sessionId: string): Promise<void> {
    try {
      const session = await this.deps.getSession(sessionId);
      if (session) {
        await this.deps.openSessionWindow(sessionId);
        return;
      }
    } catch (error) {
      this.deps.logWarning("target-open-failed", sessionId, error);
    }

    try {
      await this.deps.openHomeWindow();
    } catch (error) {
      this.deps.logWarning("home-open-failed", sessionId, error);
    }
  }
}
