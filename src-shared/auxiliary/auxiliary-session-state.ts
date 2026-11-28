import {
  normalizeApprovalMode,
  type ApprovalMode,
} from "../settings/approval-mode.js";
import {
  normalizeCodexSandboxMode,
  type CodexSandboxMode,
} from "../settings/codex-sandbox-mode.js";
import {
  normalizeCodexSpeed,
  type CodexSpeed,
} from "../settings/codex-speed.js";
import {
  normalizeCodexReviewer,
  type CodexReviewer,
} from "../settings/codex-reviewer.js";
import {
  isModelReasoningEffort,
  resolveModelItemChangeSelection,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogItem,
  type ModelReasoningEffort,
} from "../settings/model-catalog.js";
import { normalizeMessage, type Message } from "../session/session-state.js";
import { createOptimisticRunningSessionState } from "../session/session-run-transition.js";
import { normalizeCharacterRuntimeSnapshot } from "../character/character-runtime-snapshot.js";
import type { CharacterRuntimeSnapshot } from "../character/character-catalog.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** 設定値を明示する作成と、直近のSessionの選択から解決する作成を区別する。 */
export type AuxiliaryRuntimeSelectionMode = "explicit" | "latest-session";

/** 作成の世代と、その時点で所有元だったMainの個体を識別する。 */
export type AuxiliaryCreationContext = {
  generationId: string;
  parentIncarnationId: string;
};

/** 作成時の実行設定と再照合に必要な要求IDを保持する。 */
export type AuxiliaryCreationRequestSnapshot = {
  parentSessionId: string;
  provider: string;
  runtimeSelection?: AuxiliaryRuntimeSelectionMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  customAgentName?: string;
  clientRequestId: string;
};

/** 準備時の世代を使い、どの親のどの作成要求を参照するか指定する。 */
export type AuxiliaryCreationRequest = {
  parentSessionId: string;
  clientRequestId: string;
  creationContext: AuxiliaryCreationContext;
};

/** 作成の進行と終了を区別し、確定したAuxiliaryが判明していればそのIDを返す。 */
export type AuxiliaryCreationResult = {
  status:
    | "preparing"
    | "queued"
    | "committing"
    | "committed"
    | "cancelled"
    | "failed"
    | "unknown"
    | "expired"
    | "not-found";
  auxiliarySessionId?: string;
};

/** Main プロセスの操作診断に使う最小限のライフサイクル情報。 */
export type AuxiliaryCreationStateChange = AuxiliaryCreationResult & {
  clientRequestId: string;
  parentSessionId: string;
  generationId: string;
};

/** 親の配下に作成するAuxiliaryの実行条件と、任意の要求照合情報。 */
export type CreateAuxiliarySessionInput = {
  parentSessionId: string;
  provider: string;
  runtimeSelection?: AuxiliaryRuntimeSelectionMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  customAgentName?: string;
  /** 作成操作を再試行しても同じ行を返すための固定キー。 */
  clientRequestId?: string;
  creationContext?: AuxiliaryCreationContext;
};

/** Auxiliaryの所属、独立した実行・下書き・会話、作成時のCharacterを保持する。 */
export type AuxiliarySession = {
  id: string;
  parentSessionId: string;
  runState: "idle" | "running" | "error";
  title: string;
  description?: string;
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  codexSpeed: CodexSpeed;
  codexReviewer: CodexReviewer;
  withMateReviewerExplicit?: true;
  customAgentName: string;
  threadId: string;
  composerDraft: string;
  messages: Message[];
  messageCount?: number;
  displayAfterMessageIndex: number | null;
  createdAt: string;
  updatedAt: string;
  /** Character の識別情報は Auxiliary の作成時に固定する。旧形式の行には含まれない。 */
  characterId?: string;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
  /** 移行用の内部マーカー。不正な新形式のスナップショットが存在する場合は親の識別情報に戻さない。 */
  characterRuntimeSnapshotInvalid?: boolean;
  characterIconPath?: string;
  /** 簡易一覧で使う、AI を介さない決定的な表示データ。 */
  preview?: string;
  clientRequestId?: string;
  creationContext?: AuxiliaryCreationContext;
  creationRequest?: AuxiliaryCreationRequestSnapshot;
};

/** 一覧向けに会話本文・下書き・内部作成情報を外し、表示名や未読などを添える。 */
export type AuxiliarySessionSummary = Omit<
  AuxiliarySession,
  | "messages"
  | "composerDraft"
  | "characterRuntimeSnapshot"
  | "characterRuntimeSnapshotInvalid"
  | "creationContext"
  | "creationRequest"
> & {
  character?: string;
  characterDescription?: string;
  cancellationState?: "requested" | "terminating";
  approvalPending?: boolean;
  hasUnreadResult?: boolean;
};

/** 識別情報と作成時刻を維持する型の部分更新を適用し、更新時刻を設定する。 */
export function applyAuxiliarySessionPatch(
  session: AuxiliarySession,
  patch: Partial<
    Omit<AuxiliarySession, "id" | "parentSessionId" | "createdAt" | "updatedAt">
  >,
  updatedAt: string,
): AuxiliarySession {
  return {
    ...session,
    ...patch,
    updatedAt,
  };
}

/** 指定された承認・Sandbox・速度・判断役のフィールドだけを反映する。 */
export function applyAuxiliarySessionRuntimeOptionsPatch(
  session: AuxiliarySession,
  patch: Partial<
    Pick<
      AuxiliarySession,
      | "approvalMode"
      | "codexSandboxMode"
      | "codexSpeed"
      | "codexReviewer"
      | "withMateReviewerExplicit"
    >
  >,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, patch, updatedAt);
}

/** Auxiliary自身の承認方式だけを更新し、他の実行設定を保つ。 */
export function applyAuxiliarySessionApprovalModeChange(
  session: AuxiliarySession,
  approvalMode: ApprovalMode,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(
    session,
    { approvalMode },
    updatedAt,
  );
}

/** AuxiliaryのCodex Sandbox設定と更新時刻を反映する。 */
export function applyAuxiliarySessionCodexSandboxModeChange(
  session: AuxiliarySession,
  codexSandboxMode: CodexSandboxMode,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(
    session,
    { codexSandboxMode },
    updatedAt,
  );
}

/** 既存のモデルと承認設定を維持したまま、実行速度を更新する。 */
export function applyAuxiliarySessionCodexSpeedChange(
  session: AuxiliarySession,
  codexSpeed: CodexSpeed,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(
    session,
    { codexSpeed },
    updatedAt,
  );
}

/** Codexの判断役を置き換え、承認モードや明示指定の状態には触れない。 */
export function applyAuxiliarySessionCodexReviewerChange(
  session: AuxiliarySession,
  codexReviewer: CodexReviewer,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionRuntimeOptionsPatch(
    session,
    { codexReviewer },
    updatedAt,
  );
}

/** 解決済みのモデルと推論レベルを一つの組として反映する。 */
export function applyAuxiliarySessionModelSelectionPatch(
  session: AuxiliarySession,
  patch: Pick<AuxiliarySession, "model" | "reasoningEffort">,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, patch, updatedAt);
}

/** 新しいモデルが受け付ける推論レベルを解決してから、選択の組を更新する。 */
export function applyAuxiliarySessionModelChange(
  session: AuxiliarySession,
  model: ModelCatalogItem,
  updatedAt: string,
): AuxiliarySession {
  const selection = resolveModelItemChangeSelection(
    model,
    session.reasoningEffort,
  );
  return applyAuxiliarySessionModelSelectionPatch(
    session,
    {
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
    updatedAt,
  );
}

/** 現在のモデルと新しい推論指定をカタログで解決し、両方を反映する。 */
export function applyAuxiliarySessionReasoningEffortChange(
  session: AuxiliarySession,
  providerCatalog: ModelCatalogProvider,
  reasoningEffort: ModelReasoningEffort,
  updatedAt: string,
): AuxiliarySession {
  const selection = resolveModelSelection(
    providerCatalog,
    session.model,
    reasoningEffort,
  );
  return applyAuxiliarySessionModelSelectionPatch(
    session,
    {
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
    },
    updatedAt,
  );
}

/** 会話本文とは別の、未送信の入力欄の内容を差し替える。 */
export function applyAuxiliarySessionComposerDraftPatch(
  session: AuxiliarySession,
  composerDraft: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, { composerDraft }, updatedAt);
}

/** 次回の実行に使うCustom Agentの名前と更新時刻だけを指定する。 */
export function applyAuxiliarySessionCustomAgentPatch(
  session: AuxiliarySession,
  customAgentName: string,
  updatedAt: string,
): AuxiliarySession {
  return applyAuxiliarySessionPatch(session, { customAgentName }, updatedAt);
}

/** 対象IDと入力内容が現在値と一致する場合だけ、遅延保存用の状態を作る。 */
export function buildAuxiliaryDraftSaveRequest(input: {
  currentSession: AuxiliarySession | null;
  targetSessionId: string;
  draft: string;
  updatedAt: string;
}): AuxiliarySession | null {
  if (
    !input.currentSession ||
    input.currentSession.id !== input.targetSessionId ||
    input.currentSession.composerDraft !== input.draft
  ) {
    return null;
  }

  return applyAuxiliarySessionComposerDraftPatch(
    input.currentSession,
    input.draft,
    input.updatedAt,
  );
}

/** 現在の送信先、または選択変更や実行中で送信できない理由。 */
export type AuxiliarySessionSendTargetResolution = {
  blockedReason: "session-changed" | "running" | null;
  session: AuxiliarySession | null;
};

/** 前後の空白を除いた本文と、送信不可ならその種別および表示文言。 */
export type AuxiliarySessionSendPreflightResult = {
  blockedReason: "empty-message" | "running" | "composer-blocked" | null;
  blockedMessage: string;
  userMessage: string;
};

/** 空の本文、実行中、入力欄側の制約の順に、送信してよいか確かめる。 */
export function resolveAuxiliarySessionSendPreflight(input: {
  activeSession: AuxiliarySession;
  composerBlockedReason?: string | null;
  messageText: string;
}): AuxiliarySessionSendPreflightResult {
  const userMessage = input.messageText.trim();
  if (!userMessage) {
    return {
      blockedReason: "empty-message",
      blockedMessage: "Enter a message before sending.",
      userMessage,
    };
  }
  if (input.activeSession.runState === "running") {
    return {
      blockedReason: "running",
      blockedMessage: "This Auxiliary Session is still running.",
      userMessage,
    };
  }
  if (input.composerBlockedReason) {
    return {
      blockedReason: "composer-blocked",
      blockedMessage: input.composerBlockedReason,
      userMessage,
    };
  }

  return {
    blockedReason: null,
    blockedMessage: "",
    userMessage,
  };
}

/** 選択されていたIDと現在のIDを照合し、実行中でない同じ対象だけを返す。 */
export function resolveAuxiliarySessionSendTarget(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
}): AuxiliarySessionSendTargetResolution {
  const currentSession = input.currentSession ?? input.activeSession;
  if (currentSession.id !== input.activeSession.id) {
    return {
      blockedReason: "session-changed",
      session: null,
    };
  }
  if (currentSession.runState === "running") {
    return {
      blockedReason: "running",
      session: null,
    };
  }

  return {
    blockedReason: null,
    session: currentSession,
  };
}

/** 選択時と現在のID・親・作成時刻が同じ場合だけ、編集対象になる現在値を返す。 */
export function resolveEditableActiveAuxiliarySession(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
}): AuxiliarySession | null {
  const currentSession = input.currentSession ?? input.activeSession;
  if (
    currentSession.id !== input.activeSession.id ||
    currentSession.parentSessionId !== input.activeSession.parentSessionId ||
    currentSession.createdAt !== input.activeSession.createdAt
  ) {
    return null;
  }

  return currentSession;
}

/** 選択時と同じ個体を編集できるときだけ、現在値に更新処理を適用する。 */
export function buildEditableActiveAuxiliarySessionPatch(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
  recipe: (current: AuxiliarySession) => AuxiliarySession;
}): AuxiliarySession | null {
  const currentSession = resolveEditableActiveAuxiliarySession({
    activeSession: input.activeSession,
    currentSession: input.currentSession,
  });
  if (!currentSession) {
    return null;
  }

  return input.recipe(currentSession);
}

/** 最初の送信で親の履歴末尾が分かる場合だけ、親会話に表示する位置を決める。 */
export function resolveAuxiliarySessionDisplayAfterMessageIndex(input: {
  auxiliaryMessageCount: number;
  currentDisplayAfterMessageIndex: number | null;
  parentMessageCount: number | null;
}): number | null {
  return input.auxiliaryMessageCount === 0 && input.parentMessageCount !== null
    ? input.parentMessageCount - 1
    : input.currentDisplayAfterMessageIndex;
}

/** 送信内容を実行中の暫定履歴に加え、入力欄を空にして親履歴に対する位置を保持する。 */
export function buildRunningAuxiliarySessionTurn(input: {
  session: AuxiliarySession;
  userMessage: string;
  displayAfterMessageIndex: number | null;
  updatedAt: string;
}): AuxiliarySession {
  return {
    ...createOptimisticRunningSessionState(
      input.session,
      input.userMessage,
      input.updatedAt,
    ),
    composerDraft: "",
    displayAfterMessageIndex: input.displayAfterMessageIndex,
  };
}

/** ページ式では総履歴件数を使って親履歴との位置を解決し、送信後の暫定状態を返す。 */
export function buildAuxiliarySessionRunningTransition(input: {
  session: AuxiliarySession;
  userMessage: string;
  parentMessageCount: number | null;
  updatedAt: string;
}): {
  runningSession: AuxiliarySession;
} {
  const displayAfterMessageIndex =
    resolveAuxiliarySessionDisplayAfterMessageIndex({
      auxiliaryMessageCount:
        input.session.messageCount ?? input.session.messages.length,
      currentDisplayAfterMessageIndex: input.session.displayAfterMessageIndex,
      parentMessageCount: input.parentMessageCount,
    });

  return {
    runningSession: buildRunningAuxiliarySessionTurn({
      session: input.session,
      userMessage: input.userMessage,
      displayAfterMessageIndex,
      updatedAt: input.updatedAt,
    }),
  };
}

/** 保存値のIDを検証して旧形式の既定値を補い、不整合なCharacter情報は別途記録する。 */
export function normalizeAuxiliarySession(
  value: unknown,
): AuxiliarySession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AuxiliarySession>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }
  if (
    typeof candidate.parentSessionId !== "string" ||
    !candidate.parentSessionId.trim()
  ) {
    return null;
  }

  const hasStoredSnapshot = Object.prototype.hasOwnProperty.call(
    candidate,
    "characterRuntimeSnapshot",
  );
  const normalizedCharacterRuntimeSnapshot = normalizeCharacterRuntimeSnapshot(
    candidate.characterRuntimeSnapshot,
  );
  const normalizedCharacterId =
    typeof candidate.characterId === "string"
      ? candidate.characterId.trim()
      : undefined;
  const characterRuntimeSnapshotInvalid =
    candidate.characterRuntimeSnapshotInvalid === true ||
    (candidate.characterRuntimeSnapshot == null &&
      Boolean(normalizedCharacterId)) ||
    (hasStoredSnapshot &&
      candidate.characterRuntimeSnapshot != null &&
      (!normalizedCharacterRuntimeSnapshot ||
        !normalizedCharacterId ||
        normalizedCharacterId !==
          normalizedCharacterRuntimeSnapshot.characterId));
  return {
    id: candidate.id.trim(),
    parentSessionId: candidate.parentSessionId.trim(),
    runState:
      candidate.runState === "running" || candidate.runState === "error"
        ? candidate.runState
        : "idle",
    title: typeof candidate.title === "string" ? candidate.title : "",
    description:
      typeof candidate.description === "string" ? candidate.description : "",
    provider:
      typeof candidate.provider === "string" ? candidate.provider : "codex",
    catalogRevision:
      typeof candidate.catalogRevision === "number"
        ? candidate.catalogRevision
        : 1,
    model: typeof candidate.model === "string" ? candidate.model : "",
    reasoningEffort: isModelReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : "medium",
    approvalMode: normalizeApprovalMode(candidate.approvalMode),
    codexSandboxMode: normalizeCodexSandboxMode(candidate.codexSandboxMode),
    codexSpeed: normalizeCodexSpeed(candidate.codexSpeed),
    codexReviewer: normalizeCodexReviewer(candidate.codexReviewer),
    ...(candidate.withMateReviewerExplicit === true
      ? { withMateReviewerExplicit: true }
      : {}),
    customAgentName:
      typeof candidate.customAgentName === "string"
        ? candidate.customAgentName
        : "",
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    composerDraft:
      typeof candidate.composerDraft === "string"
        ? candidate.composerDraft
        : "",
    messages: Array.isArray(candidate.messages)
      ? candidate.messages
          .map((message) => normalizeMessage(message))
          .filter((message): message is Message => message !== null)
      : [],
    displayAfterMessageIndex:
      typeof candidate.displayAfterMessageIndex === "number" &&
      Number.isInteger(candidate.displayAfterMessageIndex)
        ? candidate.displayAfterMessageIndex
        : null,
    createdAt:
      typeof candidate.createdAt === "string" ? candidate.createdAt : "",
    updatedAt:
      typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    characterId: normalizedCharacterId,
    characterRuntimeSnapshot: normalizedCharacterRuntimeSnapshot,
    characterRuntimeSnapshotInvalid,
    characterIconPath:
      typeof candidate.characterIconPath === "string"
        ? candidate.characterIconPath
        : undefined,
    preview:
      typeof candidate.preview === "string" ? candidate.preview : undefined,
    clientRequestId:
      typeof candidate.clientRequestId === "string"
        ? candidate.clientRequestId.trim()
        : typeof (candidate as { requestId?: unknown }).requestId === "string"
          ? (candidate as { requestId: string }).requestId.trim()
          : undefined,
    creationContext: isAuxiliaryCreationContext(candidate.creationContext)
      ? candidate.creationContext
      : undefined,
    creationRequest: isAuxiliaryCreationRequestSnapshot(
      candidate.creationRequest,
    )
      ? candidate.creationRequest
      : undefined,
  };
}

/** 保存済みの作成情報に、世代と親の個体を示す文字列があるか調べる。 */
function isAuxiliaryCreationContext(
  value: unknown,
): value is AuxiliaryCreationContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AuxiliaryCreationContext).generationId === "string" &&
    typeof (value as AuxiliaryCreationContext).parentIncarnationId === "string"
  );
}

/** 旧データの作成スナップショットから、親・Provider・要求IDを読み取れるか調べる。 */
function isAuxiliaryCreationRequestSnapshot(
  value: unknown,
): value is AuxiliaryCreationRequestSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AuxiliaryCreationRequestSnapshot).parentSessionId ===
      "string" &&
    typeof (value as AuxiliaryCreationRequestSnapshot).provider === "string" &&
    typeof (value as AuxiliaryCreationRequestSnapshot).clientRequestId ===
      "string"
  );
}

/** 一覧で不要な会話本文などを省き、保存済みCharacterの表示情報とプレビューを取り出す。 */
export function projectAuxiliarySessionSummary(
  session: AuxiliarySession,
): AuxiliarySessionSummary {
  const {
    messages: _messages,
    composerDraft: _composerDraft,
    characterRuntimeSnapshot: _characterRuntimeSnapshot,
    characterRuntimeSnapshotInvalid: _characterRuntimeSnapshotInvalid,
    creationContext: _creationContext,
    creationRequest: _creationRequest,
    ...summary
  } = session;
  return {
    ...summary,
    characterDescription: session.characterRuntimeSnapshot?.description ?? "",
    character: session.characterRuntimeSnapshot?.name ?? "",
    characterIconPath:
      session.characterIconPath ??
      session.characterRuntimeSnapshot?.iconFilePath ??
      "",
    preview: session.preview ?? buildAuxiliaryPreview(session.messages),
  };
}

/** 一覧に表示できる本文がない場合の値。 */
export const AUXILIARY_PREVIEW_DEFAULT = "";
/** 一覧プレビューのコードポイント数の上限。 */
export const AUXILIARY_PREVIEW_MAX_LENGTH = 240;

/** Markdownを解析し、一覧用に画像の代替文と本文を集めて空白を整える。 */
function flattenAuxiliaryPreviewMarkdown(value: string): string {
  const tree = fromMarkdown(value, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  /** プレビュー抽出で参照するMarkdown構文ノードの部分形。 */
  type PreviewNode = {
    type: string;
    value?: string;
    alt?: string | null;
    children?: PreviewNode[];
  };
  /** 定義を除外し、ブロックや改行の境界を空白で区切って表示用の文字列にする。 */
  const plainText = (node: PreviewNode): string => {
    if (node.type === "definition") return "";
    if (node.type === "break") return " ";
    if (node.type === "image") return node.alt ?? "";
    if (typeof node.value === "string") return node.value;
    const separator = [
      "root",
      "blockquote",
      "list",
      "listItem",
      "table",
      "tableRow",
    ].includes(node.type)
      ? " "
      : "";
    return node.children?.map(plainText).join(separator) ?? "";
  };
  return plainText(tree).replace(/\s+/g, " ").trim();
}

/** 平文が残る場合だけ、サロゲートペアの途中で切らずにプレビュー上限まで返す。 */
function clipAuxiliaryPreview(value: string): string {
  const normalized = flattenAuxiliaryPreviewMarkdown(value);
  if (!normalized) {
    return "";
  }
  return Array.from(normalized).slice(0, AUXILIARY_PREVIEW_MAX_LENGTH).join("");
}

/**
 * Provider を呼ばずに一覧用の表示データを組み立てる。現在のメッセージ契約では、
 * アクセント付きの assistant メッセージは状態・ツール・エラーのブロックなので除外する。
 */
export function buildAuxiliaryPreview(
  messages: readonly Message[],
  confirmedFinalAssistantText?: string | null,
): string {
  const confirmedPreview =
    confirmedFinalAssistantText == null
      ? ""
      : clipAuxiliaryPreview(confirmedFinalAssistantText);
  if (confirmedPreview) {
    return confirmedPreview;
  }
  const latestUser = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" && clipAuxiliaryPreview(message.text),
    );
  return latestUser
    ? clipAuxiliaryPreview(latestUser.text) || AUXILIARY_PREVIEW_DEFAULT
    : AUXILIARY_PREVIEW_DEFAULT;
}

/** 新しい Turn のストリーミング中や失敗時には、直近の確定済み表示データを保持する。 */
export function resolveAuxiliaryPreview(
  messages: readonly Message[],
  previousPreview?: string | null,
  confirmedFinalAssistantText?: string | null,
): string {
  if (confirmedFinalAssistantText?.trim()) {
    return buildAuxiliaryPreview(messages, confirmedFinalAssistantText);
  }
  if (
    previousPreview?.trim() &&
    previousPreview !== AUXILIARY_PREVIEW_DEFAULT
  ) {
    return previousPreview;
  }
  return buildAuxiliaryPreview(messages);
}
