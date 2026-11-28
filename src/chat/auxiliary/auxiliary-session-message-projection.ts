import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import { getMessageHistoryIndex } from "../../../src-shared/session/conversation-page.js";

/** 表示行の由来。履歴の詳細取得では一覧内の位置ではなく、元の会話と履歴位置を参照する。 */
export type MessageListSource =
  | { kind: "turn-submission"; requestId: string }
  | {
      kind: "turn-queue";
      receipt: import("../../../src-shared/session/session-turn-queue.js").SessionTurnQueueReceipt;
    }
  | {
      kind: "session";
      messageIndex: number;
    }
  | {
      kind: "auxiliary";
      sessionId: string;
      messageIndex: number;
      artifact: Message["artifact"];
    }
  | {
      kind: "live-assistant";
      sessionId: string;
      threadId: string | null;
      withMateTurnId?: string;
    };

/** 各行の本文・由来・表示キー・所属グループを同じ添字で参照できる一覧。 */
export type MessageListProjection = {
  messages: Message[];
  sources: MessageListSource[];
  keys: string[];
  groups: Array<MessageListGroup | null>;
};

/** 同じ補助会話の行をまとめて表示するための識別子とラベル。 */
export type MessageListGroup = {
  id: string;
  label: string;
};

/** 履歴行から表示に渡せる成果物データ。欠落時の null は取得結果側で扱う。 */
type ProjectedMessageArtifact = NonNullable<Message["artifact"]>;

/** 実行中の表示をどの補助会話グループに付けるかを判定する情報。 */
type PendingAuxiliaryMessageGroupSession = Pick<
  AuxiliarySession,
  "id" | "runState"
>;

/** 親の履歴へ補助会話の行を差し込むための内容と挿入・整列用情報。 */
export type MessageListAuxiliarySession = Pick<
  AuxiliarySession,
  "id" | "messages" | "displayAfterMessageIndex" | "createdAt"
>;

/** 指定した補助会話の履歴から応答の位置を調べるための最小入力。 */
type AuxiliaryMessageLookupSession = Pick<AuxiliarySession, "id" | "messages">;

/** 未確定の応答本文と、保存済みの応答に表示を引き継ぐための会話・履歴位置。 */
export type LiveAssistantProjection = {
  sessionId: string;
  threadId: string | null;
  withMateTurnId?: string;
  messageIndex: number;
  text: string;
};

/** 未確定応答の重ね合わせと、一覧の基準となる履歴の由来を指定する。 */
export type MessageListProjectionOptions = {
  liveAssistant?: LiveAssistantProjection | null;
  primaryMessageSourceKind?: "session" | "auxiliary";
};

/** 保存反映まで応答を表示し続けるかを決める、対象会話と実行・保存の状態。 */
export type LiveAssistantBridgeProjectionInput = {
  bridge: LiveAssistantProjection | null | undefined;
  activeSessionId: string | null | undefined;
  hasLiveRun: boolean;
  hasPersistedAssistant: boolean;
  isSettling?: boolean;
};

/** 表示行の由来と、通常会話・補助会話それぞれの成果物の取得経路。 */
export type LoadProjectedMessageArtifactOptions = {
  source: MessageListSource | undefined;
  loadSessionArtifact: (
    messageIndex: number,
  ) =>
    | ProjectedMessageArtifact
    | null
    | undefined
    | Promise<ProjectedMessageArtifact | null | undefined>;
  loadAuxiliaryArtifact?: (
    sessionId: string,
    messageIndex: number,
  ) =>
    | ProjectedMessageArtifact
    | null
    | undefined
    | Promise<ProjectedMessageArtifact | null | undefined>;
};

/** 行の由来から成果物を解決する。補助会話の詳細は元の会話と履歴位置で取得し、仮の行では取得しない。 */
export function loadProjectedMessageArtifact({
  source,
  loadSessionArtifact,
  loadAuxiliaryArtifact,
}: LoadProjectedMessageArtifactOptions): Promise<ProjectedMessageArtifact | null> {
  if (!source) {
    return Promise.resolve(null);
  }

  if (source.kind === "auxiliary") {
    if (source.artifact?.detailAvailable) {
      return loadAuxiliaryArtifact
        ? Promise.resolve(
            loadAuxiliaryArtifact(source.sessionId, source.messageIndex),
          ).then((artifact) => artifact ?? null)
        : Promise.resolve(null);
    }
    return Promise.resolve(source.artifact ?? null);
  }

  if (
    source.kind === "live-assistant" ||
    source.kind === "turn-queue" ||
    source.kind === "turn-submission"
  ) {
    return Promise.resolve(null);
  }

  return Promise.resolve(loadSessionArtifact(source.messageIndex)).then(
    (artifact) => artifact ?? null,
  );
}

/** 補助会話の履歴に属する位置だけを詳細取得し、取得中に同じ会話でなくなった場合は結果を破棄する。 */
export async function loadOwnedAuxiliaryMessageArtifact(input: {
  owner:
    | (Pick<
        AuxiliarySession,
        "id" | "parentSessionId" | "createdAt" | "messages"
      > & { messageCount?: number })
    | null;
  getCurrentOwner: () => Pick<
    AuxiliarySession,
    "id" | "parentSessionId" | "createdAt"
  > | null;
  messageIndex: number;
  loadArtifact: (
    sessionId: string,
    messageIndex: number,
  ) => Promise<ProjectedMessageArtifact | null>;
}): Promise<ProjectedMessageArtifact | null> {
  const owner = input.owner;
  /** 選択中の会話を識別子・親・作成時刻で照合し、別の世代を除外する。 */
  const matchesOwner = () => {
    const current = input.getCurrentOwner();
    return (
      !!owner &&
      current?.id === owner.id &&
      current.parentSessionId === owner.parentSessionId &&
      current.createdAt === owner.createdAt
    );
  };
  if (
    !owner ||
    !Number.isInteger(input.messageIndex) ||
    input.messageIndex < 0 ||
    (owner.messageCount !== undefined
      ? input.messageIndex >= owner.messageCount
      : !owner.messages.some(
          (message, index) =>
            getMessageHistoryIndex(message, index) === input.messageIndex,
        )) ||
    !matchesOwner()
  )
    return null;
  const detail = await input.loadArtifact(owner.id, input.messageIndex);
  return matchesOwner() ? detail : null;
}

/** 実行中の補助会話だけを待機表示の所属グループとして返す。 */
export function resolvePendingAuxiliaryMessageGroupId(
  auxiliarySession: PendingAuxiliaryMessageGroupSession | null | undefined,
): string | null {
  return auxiliarySession?.runState === "running" ? auxiliarySession.id : null;
}

/** 親の履歴に補助会話を保存位置で差し込み、未保存の応答を重複させずに同じ一覧へ投影する。 */
export function buildMessageListProjection(
  sessionMessages: Message[],
  auxiliarySessions: MessageListAuxiliarySession[],
  sessionId = "session",
  options: MessageListProjectionOptions = {},
): MessageListProjection {
  const messages: Message[] = [];
  const sources: MessageListSource[] = [];
  const keys: string[] = [];
  const groups: Array<MessageListGroup | null> = [];
  const auxiliaryBuckets = new Map<number, MessageListAuxiliarySession[]>();
  const fallbackAuxiliarySessions: MessageListAuxiliarySession[] = [];
  const liveAssistant = normalizeLiveAssistantProjection(options.liveAssistant);
  const primaryMessageSourceKind =
    options.primaryMessageSourceKind ?? "session";
  const liveAssistantKey = liveAssistant
    ? buildLiveAssistantProjectionKey(
        liveAssistant.sessionId,
        liveAssistant.threadId,
        liveAssistant.messageIndex,
        liveAssistant.withMateTurnId,
      )
    : null;

  /** 基準会話の履歴行を追加し、確定した応答には未確定時の表示キーを引き継ぐ。 */
  const addSessionMessage = (message: Message, messageIndex: number) => {
    messageIndex = getMessageHistoryIndex(message, messageIndex);
    messages.push(message);
    sources.push(
      primaryMessageSourceKind === "auxiliary"
        ? {
            kind: "auxiliary",
            sessionId,
            messageIndex,
            artifact: message.artifact,
          }
        : { kind: "session", messageIndex },
    );
    keys.push(
      isMatchingPersistedLiveAssistantMessage({
        message,
        messageIndex,
        targetSessionId: sessionId,
        liveAssistant,
      }) && liveAssistantKey
        ? liveAssistantKey
        : `session-${sessionId}-${messageIndex}`,
    );
    groups.push(null);
  };

  /** 補助会話を同じグループにまとめ、対象の未確定応答が保存されていなければグループ末尾に加える。 */
  const addAuxiliarySession = (
    auxiliarySession: MessageListAuxiliarySession,
  ) => {
    const group = {
      id: auxiliarySession.id,
      label: "Auxiliary",
    };
    auxiliarySession.messages.forEach((message, messageIndex) => {
      messageIndex = getMessageHistoryIndex(message, messageIndex);
      messages.push({
        ...message,
        accent: true,
      });
      sources.push({
        kind: "auxiliary",
        sessionId: auxiliarySession.id,
        messageIndex,
        artifact: message.artifact,
      });
      keys.push(
        isMatchingPersistedLiveAssistantMessage({
          message,
          messageIndex,
          targetSessionId: auxiliarySession.id,
          liveAssistant,
        }) && liveAssistantKey
          ? liveAssistantKey
          : `auxiliary-${auxiliarySession.id}-${messageIndex}`,
      );
      groups.push(group);
    });

    if (
      liveAssistant &&
      liveAssistant.sessionId === auxiliarySession.id &&
      !hasPersistedLiveAssistantMessage(
        sessionMessages,
        [auxiliarySession],
        liveAssistant,
        sessionId,
      )
    ) {
      addLiveAssistantMessage(group);
    }
  };

  /** 未確定応答の仮の行を追加し、補助会話に属する場合はグループの強調を付ける。 */
  const addLiveAssistantMessage = (group: MessageListGroup | null) => {
    if (!liveAssistant || !liveAssistantKey) {
      return;
    }

    messages.push({
      role: "assistant",
      text: liveAssistant.text,
      ...(group ? { accent: true } : {}),
    });
    sources.push({
      kind: "live-assistant",
      sessionId: liveAssistant.sessionId,
      threadId: liveAssistant.threadId,
      ...(liveAssistant.withMateTurnId
        ? { withMateTurnId: liveAssistant.withMateTurnId }
        : {}),
    });
    keys.push(liveAssistantKey);
    groups.push(group);
  };

  const sortedAuxiliarySessions = [...auxiliarySessions].sort(
    compareAuxiliarySessions,
  );
  for (const auxiliarySession of sortedAuxiliarySessions) {
    if (auxiliarySession.displayAfterMessageIndex === null) {
      fallbackAuxiliarySessions.push(auxiliarySession);
      continue;
    }

    const maxAnchor = sessionMessages.length - 1;
    const displayAfterMessageIndex =
      sessionMessages.length === 0
        ? -1
        : Math.min(
            Math.max(auxiliarySession.displayAfterMessageIndex, -1),
            maxAnchor,
          );
    auxiliaryBuckets.set(displayAfterMessageIndex, [
      ...(auxiliaryBuckets.get(displayAfterMessageIndex) ?? []),
      auxiliarySession,
    ]);
  }

  for (let index = -1; index < sessionMessages.length; index += 1) {
    if (index >= 0) {
      addSessionMessage(sessionMessages[index], index);
    }

    for (const auxiliarySession of auxiliaryBuckets.get(index) ?? []) {
      addAuxiliarySession(auxiliarySession);
    }
  }

  for (const auxiliarySession of fallbackAuxiliarySessions) {
    addAuxiliarySession(auxiliarySession);
  }

  if (
    liveAssistant &&
    liveAssistantKey &&
    liveAssistant.sessionId === sessionId &&
    !hasPersistedLiveAssistantMessage(
      sessionMessages,
      auxiliarySessions,
      liveAssistant,
      sessionId,
    )
  ) {
    addLiveAssistantMessage(null);
  }

  return { messages, sources, keys, groups };
}

/** 同じ会話の未確定応答だけを重ね、保存済みの応答があれば仮の行を作らずキーを継承する。 */
export function projectLiveAssistantOnSessionHistory(
  history: MessageListProjection,
  sessionMessages: Message[],
  sessionId: string,
  liveAssistant: LiveAssistantProjection | null,
): MessageListProjection {
  const live = normalizeLiveAssistantProjection(liveAssistant);
  if (!live || live.sessionId !== sessionId) return history;

  const key = buildLiveAssistantProjectionKey(
    live.sessionId,
    live.threadId,
    live.messageIndex,
    live.withMateTurnId,
  );
  if (hasAssistantMessageAtIndex(sessionMessages, live.messageIndex)) {
    const localIndex = sessionMessages.findIndex(
      (message, index) =>
        getMessageHistoryIndex(message, index) === live.messageIndex,
    );
    if (history.keys[localIndex] === key) return history;
    const keys = [...history.keys];
    keys[localIndex] = key;
    return { ...history, keys };
  }

  return {
    messages: [...history.messages, { role: "assistant", text: live.text }],
    sources: [
      ...history.sources,
      {
        kind: "live-assistant",
        sessionId,
        threadId: live.threadId,
        ...(live.withMateTurnId ? { withMateTurnId: live.withMateTurnId } : {}),
      },
    ],
    keys: [...history.keys, key],
    groups: [...history.groups, null],
  };
}

/** Turn 識別子を優先して表示キーを作り、未取得なら履歴位置とスレッド情報を使う。 */
export function buildLiveAssistantProjectionKey(
  sessionId: string,
  threadId: string | null,
  messageIndex: number,
  withMateTurnId?: string,
): string {
  return withMateTurnId
    ? `live-assistant-${sessionId}-turn-${withMateTurnId}`
    : `live-assistant-${sessionId}-${messageIndex}-${threadId || "pending"}`;
}

/** 未確定応答と同じ会話・履歴位置に応答が保存済みかを、本文の一致には依存せず判定する。 */
export function hasPersistedLiveAssistantMessage(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliaryMessageLookupSession[],
  liveAssistant: LiveAssistantProjection | null | undefined,
  sessionId = "session",
): boolean {
  const normalizedLiveAssistant =
    normalizeLiveAssistantProjection(liveAssistant);
  if (!normalizedLiveAssistant) {
    return false;
  }

  if (
    normalizedLiveAssistant.sessionId === sessionId &&
    hasAssistantMessageAtIndex(
      sessionMessages,
      normalizedLiveAssistant.messageIndex,
    )
  ) {
    return true;
  }

  return auxiliarySessions.some(
    (auxiliarySession) =>
      auxiliarySession.id === normalizedLiveAssistant.sessionId &&
      hasAssistantMessageAtIndex(
        auxiliarySession.messages,
        normalizedLiveAssistant.messageIndex,
      ),
  );
}

/** 対象会話の次の履歴位置を求める。応答本文があり末尾が保存済みの応答なら、その位置を再利用する。 */
export function resolveLiveAssistantMessageIndex(
  sessionMessages: Message[],
  auxiliarySessions: AuxiliaryMessageLookupSession[],
  targetSessionId: string,
  sessionId = "session",
  assistantText = "",
): number {
  const targetMessages =
    targetSessionId === sessionId
      ? sessionMessages
      : (auxiliarySessions.find(
          (auxiliarySession) => auxiliarySession.id === targetSessionId,
        )?.messages ?? []);
  const persistedTailIndex = targetMessages.length - 1;
  const persistedTail = targetMessages[persistedTailIndex];
  if (assistantText.length > 0 && persistedTail?.role === "assistant") {
    return getMessageHistoryIndex(persistedTail, persistedTailIndex);
  }

  return persistedTail
    ? getMessageHistoryIndex(persistedTail, persistedTailIndex) + 1
    : 0;
}

/** 選択中の会話で、実行中・保存反映済み・反映待ちのいずれかなら応答を表示する。 */
export function shouldProjectLiveAssistantBridge({
  bridge,
  activeSessionId,
  hasLiveRun,
  hasPersistedAssistant,
  isSettling = false,
}: LiveAssistantBridgeProjectionInput): boolean {
  return (
    !!bridge &&
    bridge.sessionId === activeSessionId &&
    (hasLiveRun || hasPersistedAssistant || isSettling)
  );
}

/** 本文のない応答と整数でない履歴位置を除き、負の位置は先頭として扱う。 */
function normalizeLiveAssistantProjection(
  liveAssistant: LiveAssistantProjection | null | undefined,
): LiveAssistantProjection | null {
  if (
    !liveAssistant ||
    !liveAssistant.text ||
    !Number.isInteger(liveAssistant.messageIndex)
  ) {
    return null;
  }

  return {
    ...liveAssistant,
    messageIndex: Math.max(0, liveAssistant.messageIndex),
  };
}

/** 履歴行が未確定応答と同じ会話・履歴位置のアシスタント応答かを判定する。 */
function isMatchingPersistedLiveAssistantMessage({
  message,
  messageIndex,
  targetSessionId,
  liveAssistant,
}: {
  message: Message;
  messageIndex: number;
  targetSessionId: string;
  liveAssistant: LiveAssistantProjection | null;
}): boolean {
  return (
    liveAssistant?.sessionId === targetSessionId &&
    messageIndex === liveAssistant.messageIndex &&
    message.role === "assistant"
  );
}

/** ページ内の添字ではなく元の履歴位置で、アシスタント応答の存在を確認する。 */
function hasAssistantMessageAtIndex(
  messages: Message[],
  messageIndex: number,
): boolean {
  return messages.some(
    (message, index) =>
      getMessageHistoryIndex(message, index) === messageIndex &&
      message.role === "assistant",
  );
}

/** 挿入位置を共有する補助会話を作成順にし、同時刻なら識別子順でそろえる。 */
function compareAuxiliarySessions(
  left: MessageListAuxiliarySession,
  right: MessageListAuxiliarySession,
): number {
  const leftCreatedAt = Date.parse(left.createdAt);
  const rightCreatedAt = Date.parse(right.createdAt);
  const createdAtComparison =
    safeTimestamp(leftCreatedAt) - safeTimestamp(rightCreatedAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

/** 解釈できない作成時刻を有効な時刻の後に並べるため、比較用の値に置き換える。 */
function safeTimestamp(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}
