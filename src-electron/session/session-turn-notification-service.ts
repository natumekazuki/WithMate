import { createHash } from "node:crypto";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

import type { Session } from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

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
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** 通知用の平文に投影する際に参照する Markdown 構文木の部分形式。 */
type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  lang?: string | null;
  children?: MarkdownNode[];
};

/** Markdown から表示用の文字を取り出し、画像・HTML・数式・Mermaid 等は通知本文に出さない。 */
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
      : (node.value ?? "");
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

/** GFM と数式を認識して Markdown を解析し、表示できるテキストを空白一つずつで整形する。 */
function toNotificationPlainText(value: string): string {
  const syntaxTree = fromMarkdown(value, {
    extensions: [gfm(), math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  return projectMarkdownVisibleText(syntaxTree as MarkdownNode)
    .replace(/\s+/g, " ")
    .trim();
}

/** 絵文字や結合文字を分断しないよう、文字列を表示上の書記素に分割する。 */
function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/** 大き過ぎる入力は解析せず、プレビューは文末を優先して最大 40 書記素まで切り出す。表示する内容がなければ null。 */
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

  const truncated =
    sentenceEndIndex >= 0
      ? candidate.slice(0, sentenceEndIndex + 1)
      : candidate;
  return `${truncated.join("").trimEnd()}…`;
}

/** 通知を一意に識別して同種のグループにまとめるための ID と、表示する本文・アイコン。 */
export type SessionTurnNotificationOptions<TIcon> = {
  id: string;
  groupId: string;
  title: string;
  body: string;
  icon?: TIcon;
};

/** 終了通知に必要な入力。成功時だけ、回答プレビューに使う元の本文を持つ。 */
export type SessionTurnTerminalNotification =
  | {
      outcome: "completed";
      session: Session;
      lastNonEmptyAssistantMessageText: string;
    }
  | {
      outcome: "failed";
      session: Session;
    };

/** 通知クリック時に開く Main、または所属 Main を明示した Auxiliary を指す。 */
export type SessionTurnNotificationTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "auxiliary"; parentSessionId: string; auxiliarySessionId: string };

/** 通知を閉じた理由。画面上のタイムアウトと、次のクリックを無効にする終了を区別できる。 */
export type SessionTurnNotificationCloseReason =
  "userCanceled" | "applicationHidden" | "timedOut";

/** 通知表示と結果イベントに必要なネイティブ通知の部分契約。 */
export type SessionTurnNotificationHandle = {
  /** 用意したネイティブ通知を表示する。 */
  show(): void;
  /** 追跡しているネイティブ通知を閉じる。 */
  close(): void;
  /** 通知を利用者がクリックしたときの処理を登録する。 */
  onClick(listener: () => void): void;
  /** 通知が閉じたときの処理を、判別できる場合は閉じた理由とともに呼ぶ。 */
  onClose(
    listener: (reason?: SessionTurnNotificationCloseReason) => void,
  ): void;
  /** 配信に失敗した場合のエラーを受け取る処理を登録する。 */
  onFailed(listener: (error: unknown) => void): void;
};

/** Windows 通知を表示して対象 Window へ移動するため、設定・保存データ・ネイティブ機能を供給する。 */
export type SessionTurnNotificationServiceDeps<TIcon> = {
  platform: NodeJS.Platform;
  /** 現在の OS とネイティブ通知基盤が通知を表示できるかを返す。 */
  isNotificationSupported(): boolean;
  /** 質問・終了通知を許可する現在の設定を取得する。 */
  isNotificationEnabled(): Awaitable<boolean>;
  /** 処理の承認待ちを通知してよいか、専用の設定を取得する。 */
  isApprovalNotificationEnabled(): Awaitable<boolean>;
  /** 成功通知に回答の一部を表示してよいかを取得する。 */
  isResponsePreviewEnabled(): Awaitable<boolean>;
  /** 指定の親または Main Window が存在し、承認を確認しに戻れるかを判定する。 */
  isSessionWindowOpen(sessionId: string): boolean;
  /** 既に対象 Window を見ている場合の通知を抑止するため、フォーカスを確認する。 */
  isSessionWindowFocused(sessionId: string): boolean;
  /** 指定されたキャラクター画像を通知に使える形式で読み、使用できなければ null を返す。 */
  loadCharacterIcon(iconPath: string): TIcon | null;
  /** 表示条件を受け取って、追跡可能なネイティブ通知を作る。 */
  createNotification(
    options: SessionTurnNotificationOptions<TIcon>,
  ): SessionTurnNotificationHandle;
  /** 通知の対象となった Main がまだ保存されているかを取得する。 */
  getSession(sessionId: string): Awaitable<Session | null>;
  /** 通知の対象だった Main の Window を開く。 */
  openSessionWindow(sessionId: string): Awaitable<void>;
  /** 指定の親 Window 内で対象の Auxiliary を開く。 */
  openAuxiliarySessionWindow(
    parentSessionId: string,
    auxiliarySessionId: string,
  ): Awaitable<void>;
  /** 元の宛先を開けない場合に、代わりに Home を開く。 */
  openHomeWindow(): Awaitable<void>;
  /** 通知の判断・作成・配信に失敗した際に、イベントと対象を診断へ渡す。 */
  logWarning(event: string, sessionId: string, error?: unknown): void;
};

/** 一件の承認通知を、要求を参照する複数の中断シグナルと結び付けた状態。 */
type ApprovalNotificationRequest = {
  controller: AbortController;
  signals: Set<AbortSignal>;
  /** 承認通知を中断し、同じ要求を待つシグナルの監視登録を解放する。 */
  resolve(): void;
};

/** 承認・質問・Turn 終了通知を宛先ごとに管理し、有効な通知からだけ対象 Window を開く。 */
export class SessionTurnNotificationService<TIcon> {
  private static readonly notificationGroupId = "WithMateSessions";
  private readonly trackedNotifications = new Map<
    string,
    SessionTurnNotificationHandle
  >();
  private readonly approvalRequests = new Map<
    string,
    Map<string, ApprovalNotificationRequest>
  >();

  /** 通知設定、Window 状態、ネイティブ通知と診断先への依存を受け取る。 */
  constructor(
    private readonly deps: SessionTurnNotificationServiceDeps<TIcon>,
  ) {}

  /** 要求 ID ごとに重複を除き、開いているがフォーカス外の Window にだけ承認待ちを知らせる。 */
  async notifyApproval(
    session: Session,
    requestId: string,
    signal: AbortSignal,
    target: SessionTurnNotificationTarget = {
      kind: "session",
      sessionId: session.id,
    },
  ): Promise<boolean> {
    const notificationKey = this.getNotificationKey(target);
    if (signal.aborted) return false;
    const requests =
      this.approvalRequests.get(notificationKey) ??
      new Map<string, ApprovalNotificationRequest>();
    const existing = requests.get(requestId);
    if (existing) {
      existing.signals.add(signal);
      signal.addEventListener("abort", existing.resolve, { once: true });
      return false;
    }
    const request: ApprovalNotificationRequest = {
      controller: new AbortController(),
      signals: new Set([signal]),
      /** 承認待ちが終わったら通知を停止し、要求の追跡とすべての中断リスナーを取り除く。 */
      resolve: () => {
        request.controller.abort();
        for (const trackedSignal of request.signals) {
          trackedSignal.removeEventListener("abort", request.resolve);
        }
        requests.delete(requestId);
        if (
          requests.size === 0 &&
          this.approvalRequests.get(notificationKey) === requests
        ) {
          this.approvalRequests.delete(notificationKey);
        }
      },
    };
    requests.set(requestId, request);
    this.approvalRequests.set(notificationKey, requests);
    signal.addEventListener("abort", request.resolve, { once: true });

    try {
      const enabled = await this.deps.isApprovalNotificationEnabled();
      const focusSessionId = this.getFocusSessionId(target);
      if (
        request.controller.signal.aborted ||
        !this.deps.isSessionWindowOpen(focusSessionId) ||
        !this.isEligibleSync(focusSessionId, notificationKey, enabled)
      ) {
        return false;
      }
      return this.showNotification(
        { session },
        target,
        notificationKey,
        {
          title: "WithMate",
          body: `${session.taskTitle.trim() || "Session"}: approval required.`,
        },
        request.controller.signal,
      );
    } catch (error) {
      this.deps.logWarning(
        "approval-notification-failed",
        notificationKey,
        error,
      );
      return false;
    }
  }

  /** 入力がまだ有効で通知可能な場合に、Codex の質問を本文を載せずに知らせる。 */
  async notifyQuestion(
    session: Session,
    signal: AbortSignal,
    target: SessionTurnNotificationTarget = {
      kind: "session",
      sessionId: session.id,
    },
  ): Promise<boolean> {
    const notificationKey = this.getNotificationKey(target);
    if (signal.aborted) return false;
    let enabled: boolean;
    try {
      enabled = await this.deps.isNotificationEnabled();
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", notificationKey, error);
      return false;
    }
    if (
      signal.aborted ||
      !this.isEligibleSync(
        this.getFocusSessionId(target),
        notificationKey,
        enabled,
      )
    ) {
      return false;
    }
    return this.showNotification(
      { session },
      target,
      notificationKey,
      {
        title: "WithMate",
        body: `${session.taskTitle.trim() || "Session"}: Codex has a question.`,
      },
      signal,
    );
  }

  /** Turn の終了通知を設定に従って表示する。同期設定なら同期で返し、非同期設定はそれぞれ失敗を観測する。 */
  notifyTurnTerminal(
    notificationInput: SessionTurnTerminalNotification,
    target: SessionTurnNotificationTarget = {
      kind: "session",
      sessionId: notificationInput.session.id,
    },
  ): boolean | Promise<boolean> {
    const notificationKey = this.getNotificationKey(target);
    let enabled: Awaitable<boolean>;
    try {
      enabled = this.deps.isNotificationEnabled();
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", notificationKey, error);
      return false;
    }
    let previewEnabled: Awaitable<boolean>;
    try {
      previewEnabled = this.deps.isResponsePreviewEnabled();
    } catch (error) {
      this.deps.logWarning(
        "preview-setting-check-failed",
        notificationInput.session.id,
        error,
      );
      previewEnabled = false;
    }
    if (this.isPromiseLike(enabled) || this.isPromiseLike(previewEnabled)) {
      return this.notifyTurnTerminalAsync(
        notificationInput,
        target,
        Promise.resolve(enabled),
        Promise.resolve(previewEnabled),
      );
    }
    return this.notifyTurnTerminalSync(
      notificationInput,
      target,
      enabled,
      previewEnabled,
    );
  }

  /** 通知可否とプレビュー設定を待ち、プレビュー設定だけの失敗では通常の通知へフォールバックする。 */
  private async notifyTurnTerminalAsync(
    notificationInput: SessionTurnTerminalNotification,
    target: SessionTurnNotificationTarget,
    enabled: Promise<boolean>,
    previewEnabled: Promise<boolean>,
  ): Promise<boolean> {
    const notificationKey = this.getNotificationKey(target);
    // 対象可否の確認が先に失敗した場合も含め、両方のリクエストの結果をすぐに監視する。
    const safePreviewEnabled = previewEnabled.catch((error: unknown) => {
      this.deps.logWarning(
        "preview-setting-check-failed",
        notificationInput.session.id,
        error,
      );
      return false;
    });
    let resolvedEnabled: boolean;
    try {
      resolvedEnabled = await enabled;
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", notificationKey, error);
      return false;
    }
    const resolvedPreviewEnabled = await safePreviewEnabled;
    if (
      !(await this.isEligible(
        this.getFocusSessionId(target),
        notificationKey,
        resolvedEnabled,
      ))
    ) {
      return false;
    }

    const content = this.buildNotificationContentSync(
      notificationInput,
      resolvedPreviewEnabled,
    );
    return this.showNotification(
      notificationInput,
      target,
      notificationKey,
      content,
    );
  }

  /** 取得済み設定と現在のフォーカスを使い、その場で終了通知を表示する。 */
  private notifyTurnTerminalSync(
    notificationInput: SessionTurnTerminalNotification,
    target: SessionTurnNotificationTarget,
    enabled: boolean,
    previewEnabled: boolean,
  ): boolean {
    const notificationKey = this.getNotificationKey(target);
    if (
      !this.isEligibleSync(
        this.getFocusSessionId(target),
        notificationKey,
        enabled,
      )
    ) {
      return false;
    }
    return this.showNotification(
      notificationInput,
      target,
      notificationKey,
      this.buildNotificationContentSync(notificationInput, previewEnabled),
    );
  }

  /** 同じ宛先の前の通知を閉じ、現在の通知を追跡して表示する。作成・表示失敗は false で返す。 */
  private showNotification(
    notificationInput: { session: Session },
    target: SessionTurnNotificationTarget,
    notificationKey: string,
    content: Pick<SessionTurnNotificationOptions<TIcon>, "title" | "body">,
    signal?: AbortSignal,
  ): boolean {
    const { session } = notificationInput;
    const options: SessionTurnNotificationOptions<TIcon> = {
      id: this.buildNotificationId(notificationKey),
      groupId: SessionTurnNotificationService.notificationGroupId,
      ...content,
    };
    const icon = this.loadCharacterIcon(session);
    if (icon !== null) {
      options.icon = icon;
    }

    this.closePreviousNotification(notificationKey);

    let notification: SessionTurnNotificationHandle;
    try {
      notification = this.deps.createNotification(options);
    } catch (error) {
      this.deps.logWarning("create-failed", notificationKey, error);
      return false;
    }

    const stopTrackingSignal = this.trackNotification(
      notificationKey,
      target,
      notification,
      signal,
    );

    try {
      notification.show();
      return true;
    } catch (error) {
      this.clearIfCurrent(notificationKey, notification);
      stopTrackingSignal();
      this.deps.logWarning("show-failed", notificationKey, error);
      return false;
    }
  }

  /** クリック・終了・配信失敗・中断を同じ通知の実体にひも付け、置き換わった通知を新しい通知のイベントとして扱わない。 */
  private trackNotification(
    notificationKey: string,
    target: SessionTurnNotificationTarget,
    notification: SessionTurnNotificationHandle,
    signal?: AbortSignal,
  ): () => void {
    /** 中断時は同じ通知がまだ追跡されている場合だけ閉じ、登録した監視を外す。 */
    const dismiss = () => {
      if (this.trackedNotifications.get(notificationKey) === notification) {
        this.closeTrackedNotification(notificationKey, "dismiss-close-failed");
      }
      signal?.removeEventListener("abort", dismiss);
    };
    signal?.addEventListener("abort", dismiss, { once: true });
    notification.onClick(() => {
      if (!this.clearIfCurrent(notificationKey, notification)) {
        return;
      }
      signal?.removeEventListener("abort", dismiss);
      void this.openNotificationTarget(target, notificationKey);
    });
    notification.onClose((reason) => {
      if (reason !== "timedOut") {
        this.clearIfCurrent(notificationKey, notification);
        signal?.removeEventListener("abort", dismiss);
      }
    });
    notification.onFailed((error) => {
      this.clearIfCurrent(notificationKey, notification);
      signal?.removeEventListener("abort", dismiss);
      this.deps.logWarning("delivery-failed", notificationKey, error);
    });
    this.trackedNotifications.set(notificationKey, notification);
    return () => signal?.removeEventListener("abort", dismiss);
  }

  /** Windows で通知がサポートされ、有効で、対象 Window がフォーカス外の場合だけ表示を許可する。 */
  private isEligibleSync(
    focusSessionId: string,
    notificationKey: string,
    enabled: boolean,
  ): boolean {
    try {
      return (
        this.deps.platform === "win32" &&
        this.deps.isNotificationSupported() &&
        enabled &&
        !this.deps.isSessionWindowFocused(focusSessionId)
      );
    } catch (error) {
      this.deps.logWarning("eligibility-check-failed", notificationKey, error);
      return false;
    }
  }

  /** 非同期の設定取得後にも、現在の OS とフォーカス条件を同期経路と同じ規則で確認する。 */
  private async isEligible(
    focusSessionId: string,
    notificationKey: string,
    enabled: boolean,
  ): Promise<boolean> {
    return this.isEligibleSync(focusSessionId, notificationKey, enabled);
  }

  /** 指定 Session に紐づいて現在表示中の通知を閉じる。 */
  dismissSessionNotification(sessionId: string): void {
    this.closeTrackedNotification(sessionId, "dismiss-close-failed");
  }

  /** 失敗通知には回答を載せず、成功時も許可済みで有用なプレビューが作れる場合だけ表示する。 */
  private buildNotificationContentSync(
    notificationInput: SessionTurnTerminalNotification,
    previewEnabled: boolean,
  ): Pick<SessionTurnNotificationOptions<TIcon>, "title" | "body"> {
    const { session } = notificationInput;
    if (notificationInput.outcome === "failed") {
      return {
        title: "WithMate",
        body: `${session.taskTitle.trim() || "Session"}: turn failed.`,
      };
    }

    const genericContent = {
      title: "WithMate",
      body: `${session.taskTitle.trim() || "Session"}: turn completed.`,
    };
    try {
      if (!previewEnabled) {
        return genericContent;
      }
    } catch (error) {
      this.deps.logWarning("preview-setting-check-failed", session.id, error);
      return genericContent;
    }

    try {
      const preview = buildResponsePreview(
        notificationInput.lastNonEmptyAssistantMessageText,
      );
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

  /** 設定の値を待機すべきかを、null でなく then を持つオブジェクトかどうかで判定する。 */
  private isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof value === "object" && value !== null && "then" in value;
  }

  /** キャラクターのアイコンパスが指定されていれば読み込む。失敗時もアイコンなしで通知を続ける。 */
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

  /** 通知対象の識別子から、ネイティブ通知で再利用できる固定 ID を作る。 */
  private buildNotificationId(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("hex");
  }

  /** 同じ宛先の通知を入れ替えるため、いま追跡している通知を閉じる。 */
  private closePreviousNotification(sessionId: string): void {
    this.closeTrackedNotification(sessionId, "replace-close-failed");
  }

  /** 現在の追跡から通知を外して閉じる。ネイティブ側の例外は診断だけに記録する。 */
  private closeTrackedNotification(
    sessionId: string,
    failureEvent: string,
  ): void {
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

  /** イベント元がいま追跡中の通知だった場合に限り、追跡を解除する。 */
  private clearIfCurrent(
    sessionId: string,
    notification: SessionTurnNotificationHandle,
  ): boolean {
    if (this.trackedNotifications.get(sessionId) !== notification) {
      return false;
    }

    this.trackedNotifications.delete(sessionId);
    return true;
  }

  /** クリックされた通知の Main または Auxiliary を開く。見つからないか起動に失敗した場合は Home を試す。 */
  private async openNotificationTarget(
    target: SessionTurnNotificationTarget,
    notificationKey: string,
  ): Promise<void> {
    try {
      if (target.kind === "auxiliary") {
        await this.deps.openAuxiliarySessionWindow(
          target.parentSessionId,
          target.auxiliarySessionId,
        );
        return;
      }

      const session = await this.deps.getSession(target.sessionId);
      if (session) {
        await this.deps.openSessionWindow(target.sessionId);
        return;
      }
    } catch (error) {
      this.deps.logWarning("target-open-failed", notificationKey, error);
    }

    try {
      await this.deps.openHomeWindow();
    } catch (error) {
      this.deps.logWarning("home-open-failed", notificationKey, error);
    }
  }

  /** 追跡と置き換えに使うキーとして、実際の通知宛先の Session ID を返す。 */
  private getNotificationKey(target: SessionTurnNotificationTarget): string {
    return target.kind === "auxiliary"
      ? target.auxiliarySessionId
      : target.sessionId;
  }

  /** フォーカス確認のために、Auxiliary では自身を表示する親の Window の Session ID を返す。 */
  private getFocusSessionId(target: SessionTurnNotificationTarget): string {
    return target.kind === "auxiliary"
      ? target.parentSessionId
      : target.sessionId;
  }
}
