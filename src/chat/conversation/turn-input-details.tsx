import { useEffect, useState, type ReactNode } from "react";
import {
  coordinationDeliveryText,
  readCoordinationNotification,
} from "../../../src-shared/coordination/coordination-delivery.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import {
  projectRetryInputAuthor,
  type SessionTurnQueueCapturedInput,
  type SessionTurnQueueReceipt,
  type SessionTurnQueueOrigin,
  type SessionSteerOrigin,
} from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { approvalModeLabel } from "../../../src-shared/settings/approval-mode.js";
import { reasoningEffortLabel } from "../../../src-shared/settings/model-catalog.js";
import { codexSandboxModeOptions } from "../../../src-shared/settings/codex-sandbox-mode.js";
import { getQueuedSourceWaitState } from "./queued-source-wait.js";

/** 保存済み入力を読むための呼び出し元と、表示している会話の対象。 */
export type TurnInputReadContext = {
  ownerSessionId: string;
  target: SessionTarget;
};
/** 詳細欄で実行設定や入力の受付状態を確認するための取得結果。 */
type Execution = Extract<
  SessionExecutionReadResult<"get_execution">,
  { ok: true }
>;
/** 入力行を描画するための送信元・相談本文・配色等の取得結果。 */
type InputDisplay = Extract<
  SessionExecutionReadResult<"read_turn_input_display">,
  { ok: true }
>;
/** 受付 ID と Turn ID のいずれか一つで入力を特定する参照。 */
type InputReference =
  { receiptId: string; turnId?: never } | { turnId: string; receiptId?: never };

/** 入力詳細の項目名と値を定義リストの一行として描画する。 */
export function InputDetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="check-item">
      <dt>
        <span>{label}</span>
      </dt>
      <dd>
        <strong>{children}</strong>
      </dd>
    </div>
  );
}

/** 状態識別子を表示用の語句に変換し、状態が空なら指定の代替表示を返す。 */
export function inputDetailStateLabel(
  value: string | null | undefined,
  fallback: string,
) {
  return value
    ? value
        .replaceAll("-", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : fallback;
}

/** 受付時の本文と添付が実際に使う入力と同じかを判定し、元の作成者を表示できる条件に使う。 */
function retryReceiptInputUnchanged(receipt: SessionTurnQueueReceipt) {
  /** 本文と添付の ID・種別・パスの並びだけを比較対象にする。 */
  const comparison = (input: SessionTurnQueueCapturedInput) =>
    JSON.stringify([
      input.request.userMessage,
      input.attachments.map(({ id, kind, absolutePath }) => [
        id,
        kind,
        absolutePath,
      ]),
    ]);
  return (
    !!receipt.accepted &&
    comparison(receipt.accepted) ===
      comparison(receipt.dispatched ?? receipt.captured)
  );
}

/** プロバイダーに該当する実行設定だけを提示し、値が記録されていない項目を区別する。 */
function ExecutionSettings({
  settings,
}: {
  settings: NonNullable<Execution["executionSettings"]>;
}) {
  const providerLabel =
    (
      {
        codex: "Codex",
        claude: "Claude",
        copilot: "Copilot",
        opencode: "OpenCode",
      } as Record<string, string>
    )[settings.provider] ?? settings.provider;
  const supportsReviewerAndSpeed =
    settings.provider === "codex" || settings.provider === "claude";
  const rows: [string, string | null][] = [
    ["provider", providerLabel],
    ["approval", approvalModeLabel(settings.approvalMode)],
  ];
  if (supportsReviewerAndSpeed)
    rows.push(
      ["reviewer", settings.codexReviewer],
      ["speed", settings.codexSpeed],
    );
  else if (settings.withMateReviewerExplicit)
    rows.push([
      "reviewer",
      settings.codexReviewer === "auto-review" ? "Auto Review" : "User",
    ]);
  rows.push(
    ["model", settings.model],
    [
      "reasoning",
      settings.reasoningEffort
        ? reasoningEffortLabel(settings.reasoningEffort)
        : settings.source === "input"
          ? "Provider Default"
          : null,
    ],
  );
  if (settings.provider === "codex")
    rows.push([
      "sandbox",
      codexSandboxModeOptions.find(
        (option) => option.id === settings.codexSandboxMode,
      )?.label ?? settings.codexSandboxMode,
    ]);
  if (settings.customAgentName) rows.push(["agent", settings.customAgentName]);
  return (
    <details className="artifact-fold" aria-label="Execution Settings" open>
      <summary className="artifact-fold-summary">
        <span className="artifact-fold-summary-copy">
          <strong>Execution Settings</strong>
        </span>
      </summary>
      <dl className="check-list turn-input-rows artifact-fold-body">
        {rows.map(([label, value]) => (
          <InputDetailRow key={label} label={label}>
            {value || "Not Recorded"}
          </InputDetailRow>
        ))}
      </dl>
    </details>
  );
}

/** 入力行と、それを保存データへ結び付ける任意の受付・Turn・読取対象。 */
type TurnInputProps = {
  message: Message;
  receipt?: SessionTurnQueueReceipt;
  context?: TurnInputReadContext;
  turnId?: string;
  active?: boolean;
};
/** 取得結果とエラーを参照先に結び付け、再試行入力に限り履歴に引き継ぐ連番を持つ。 */
type LoadedTurnInput = {
  key: string;
  display?: InputDisplay;
  execution?: Execution;
  error?: string;
  retryUserSeq?: number;
};

/** 入力行表示または応答詳細に必要な保存情報を読み、対象や用途が変わった読取結果を混ぜない。 */
export function useTurnInputRead(
  { message, receipt, context, turnId, active = true }: TurnInputProps,
  mode: "display" | "details" = "display",
) {
  const input = message.turnInput;
  const [loaded, setLoaded] = useState<LoadedTurnInput | null>(null);
  const [routeError, setRouteError] = useState<{
    key: string;
    message: string;
  }>();
  const [revision, setRevision] = useState(0);
  const receiptId = receipt?.id ?? input?.queueId;
  const reference: InputReference | null = receiptId
    ? { receiptId }
    : input || turnId
      ? { turnId: input?.turnId ?? turnId! }
      : null;
  const statusReference =
    input && !receiptId && message.historyIndex !== undefined
      ? { messageSeq: message.historyIndex }
      : (reference ??
        (message.historyIndex !== undefined
          ? { messageSeq: message.historyIndex }
          : null));
  const referenceIdentity = JSON.stringify([context, statusReference, mode]);
  // 再試行した入力の表示は、処理中の受付情報がなくなった後も残る場合がある。
  // 保存シーケンスでの読み取りが追いつくまでは、この所有者の正確なユーザー入力シーケンスに紐付け済みの表示データだけを再利用する。
  const retainsRetryDisplay =
    mode === "display" &&
    message.role === "user" &&
    !receiptId &&
    message.historyIndex !== undefined &&
    loaded?.retryUserSeq === message.historyIndex &&
    loaded.display?.receiptId &&
    loaded.key ===
      JSON.stringify([context, { receiptId: loaded.display.receiptId }, mode]);
  const currentRead =
    active && (loaded?.key === referenceIdentity || retainsRetryDisplay)
      ? loaded
      : null;
  const observed = currentRead?.display ?? null;
  const execution = currentRead?.execution ?? null;
  const captured = receipt?.dispatched ?? receipt?.captured;
  // 直接送った追加入力は、Turn の開始入力でなく、その追加入力自体の送信者に属する。
  const origin =
    input && !receiptId
      ? input.origin
      : (observed?.origin ??
        execution?.origin ??
        receipt?.accepted?.origin ??
        receipt?.captured.origin);
  const displayOrigin = projectRetryInputAuthor(
    origin,
    captured ? captured.retrySource : observed?.retrySource,
    receipt
      ? !!captured?.retrySource && retryReceiptInputUnchanged(receipt)
      : observed?.retryInputUnchanged,
  );
  const observedAuthor = projectRetryInputAuthor(
    origin,
    observed?.retrySource,
    observed?.retryInputUnchanged,
  );
  // ローカルのキューには直近の読み取りよりも新しい編集が反映されている場合がある。その場合に以前の作成者の色で描画しない。
  const senderTheme =
    displayOrigin?.kind === "session" &&
    observedAuthor?.kind === "session" &&
    displayOrigin.actorSessionId === observedAuthor.actorSessionId &&
    displayOrigin.actorIncarnationId === observedAuthor.actorIncarnationId &&
    displayOrigin.actorKind === observedAuthor.actorKind &&
    displayOrigin.actorSnapshot?.character.id ===
      observedAuthor.actorSnapshot?.character.id
      ? (observed?.senderTheme ?? null)
      : null;
  const sourceSessionId =
    displayOrigin?.kind === "session"
      ? displayOrigin.actorSessionId
      : undefined;
  const sourceMainId =
    displayOrigin?.kind === "session" && displayOrigin.actorKind === "auxiliary"
      ? displayOrigin.actorMainSessionId
      : undefined;
  useEffect(() => {
    const api = getWithMateApi();
    if (!active || !context) return;
    /** 表示対象のキューまたは Turn の更新に限り、読取をやり直す。 */
    const refresh = (sessionId: string) => {
      if (sessionId === context.target.sessionId)
        setRevision((value) => value + 1);
    };
    const queueChanged = api?.onSessionTurnQueueChanged?.(refresh);
    const turnUpdated = api?.onSessionTurnUpdated?.(refresh);
    return () => {
      queueChanged?.();
      turnUpdated?.();
    };
  }, [context?.target.sessionId, context?.ownerSessionId, active]);
  useEffect(() => {
    if (!active || mode !== "display" || !sourceSessionId) return;
    return getWithMateApi()?.subscribeSessionInvalidation?.((event) => {
      // Main のタイトル・説明・ピンの更新が変えるのは要約だけで、保存済みの来歴や色には影響しない。
      if (event.detailChanged === false) return;
      if (
        event.scope === "ids" &&
        !event.sessionIds.includes(sourceSessionId) &&
        (!sourceMainId || !event.sessionIds.includes(sourceMainId))
      )
        return;
      setRevision((value) => value + 1);
    });
  }, [active, mode, sourceSessionId, sourceMainId]);
  const identity = JSON.stringify([
    referenceIdentity,
    receipt?.updatedAt,
    input?.state,
    revision,
  ]);
  useEffect(() => {
    const api = getWithMateApi();
    if (!active || !context || !statusReference || !api?.readSessionExecution)
      return;
    let current = true;
    setLoaded((value) =>
      value?.key === referenceIdentity && value.error
        ? { ...value, error: undefined }
        : value,
    );
    setRouteError((value) =>
      value?.key === referenceIdentity ? undefined : value,
    );
    /** 同じ入力で取得済みの内容は残すが、失敗後に古い送信者の配色を使わない。 */
    const fail = (error: string) =>
      setLoaded((value) => {
        if (value?.key !== referenceIdentity)
          return { key: referenceIdentity, error };
        const display = value.display
          ? { ...value.display, senderTheme: null }
          : undefined;
        return { ...value, display, error };
      });
    const request = { target: context.target, ...statusReference };
    /** 用途に応じて表示情報か実行詳細を読み、応答から受付が特定できないときは入力連番で読み直す。 */
    const load = async () => {
      if (mode === "display") {
        const result = await api.readSessionExecution(
          context.ownerSessionId,
          "read_turn_input_display",
          request,
        );
        if (!current) return;
        if (result.ok) {
          const retryUserSeq =
            message.role === "user" &&
            result.retrySource &&
            receipt?.id === result.receiptId
              ? (receipt.userMessageSeq ?? undefined)
              : undefined;
          setLoaded({ key: referenceIdentity, display: result, retryUserSeq });
        } else fail(result.message);
      } else {
        let result = await api.readSessionExecution(
          context.ownerSessionId,
          "get_execution",
          request,
        );
        if (
          current &&
          result.ok &&
          message.role === "assistant" &&
          !result.receiptId &&
          result.userMessageSeq !== null
        ) {
          result = await api.readSessionExecution(
            context.ownerSessionId,
            "get_execution",
            { target: context.target, messageSeq: result.userMessageSeq },
          );
        }
        if (!current) return;
        if (result.ok) setLoaded({ key: referenceIdentity, execution: result });
        else fail(result.message);
      }
    };
    void load().catch((error) => {
      if (current)
        fail(
          error instanceof Error
            ? error.message
            : "Could not read saved input.",
        );
    });
    return () => {
      current = false;
    };
  }, [identity, active]);
  const text =
    message.role === "user"
      ? receipt?.captured.coordination
        ? coordinationDeliveryText(receipt.dispatched ?? receipt.captured)
        : (observed?.coordination?.text ?? message.text)
      : message.text;
  const coordination =
    message.role !== "user"
      ? null
      : captured?.coordination
        ? {
            id: captured.coordination.id,
            consultation:
              readCoordinationNotification(captured)?.consultation ?? text,
          }
        : (observed?.coordination ?? null);
  const readError =
    currentRead?.error ??
    (routeError?.key === referenceIdentity ? routeError.message : "");
  /** 関連セッションを開けなかったエラーを、現在の入力参照に関連付ける。 */
  const setReadError = (message: string) =>
    setRouteError({ key: referenceIdentity, message });
  return {
    input,
    text,
    coordination,
    execution,
    observed,
    origin,
    displayOrigin,
    senderTheme,
    statusReference,
    receiptId,
    identity,
    readError,
    setReadError,
    setRevision,
  };
}

/** 実行詳細欄が、実行チェックとの設定表示の重複と入力表示の再試行を扱うための入力。 */
type TurnExecutionDetailsProps = TurnInputProps & {
  hasRunChecks?: boolean;
  displayReadError?: string;
  onRetryDisplay?: () => void;
};

/** 表示用の入力情報とは別に実行詳細を取得して、応答の詳細欄へ渡す。 */
export function TurnExecutionDetails(props: TurnExecutionDetailsProps) {
  return (
    <TurnInputDetailsContent
      {...props}
      read={useTurnInputRead(props, "details")}
    />
  );
}

/** ユーザー入力行と失敗応答だけで入力表示の読取を有効にして、結果を描画処理に渡す。 */
export function TurnInputReadBoundary({
  children,
  ...props
}: TurnInputProps & {
  children: (read: ReturnType<typeof useTurnInputRead>) => ReactNode;
}) {
  return children(
    useTurnInputRead({
      ...props,
      active:
        props.message.role === "user" ||
        (props.message.role === "assistant" &&
          props.message.runFailure !== undefined),
    }),
  );
}

/** セッションから送られた入力だけに、記録された送信者のアイコンと名前を添える。 */
export function TurnInputOriginAvatar({
  read,
  origin = read.origin,
}: {
  read: ReturnType<typeof useTurnInputRead>;
  origin?: ReturnType<typeof useTurnInputRead>["origin"];
}) {
  if (origin?.kind !== "session") return null;
  const character = origin.actorSnapshot?.character ?? {
    name: "Unknown Sender",
    iconPath: "",
  };
  return (
    <>
      <div className="message-avatar-stack">
        <CharacterAvatar
          character={character}
          size="small"
          className="message-avatar"
        />
      </div>
      <div className="message-character-name">{character.name}</div>
    </>
  );
}

/** Turn への追加入力に該当するユーザー行だけに、配信状態の注意を表示する。 */
export function TurnInputStatus({ message }: { message: Message }) {
  const input = message.turnInput;
  if (message.role !== "user" || !input) return null;
  return <AdditionalInputStatus state={input.state} />;
}

/** 追加入力の配信が未確認の場合と未送信の場合を、別の注意文で示す。 */
export function AdditionalInputStatus({
  state,
}: {
  state: NonNullable<Message["turnInput"]>["state"];
}) {
  return (
    <>
      {state === "unknown" ? (
        <p className="message-paragraph" role="alert">
          Delivery or saving could not be confirmed. This input is not a
          confirmed addition.
        </p>
      ) : null}
      {state === "not-sent" ? (
        <p className="message-paragraph" role="alert">
          This input was not delivered to the Turn. It has not been sent as a
          new Turn.
        </p>
      ) : null}
    </>
  );
}

/** 送信行なら送信先、受信行なら送信元のセッションを開く導線を出し、開けなかった理由を通知する。 */
export function SessionOriginRoute({
  origin,
  target,
  onError,
  onOpenRecipientThread,
}: {
  origin: SessionTurnQueueOrigin | SessionSteerOrigin;
  target?: SessionTarget;
  onError: (message: string) => void;
  onOpenRecipientThread?: () => void;
}) {
  const outbound = target !== undefined;
  const snapshot = outbound ? origin.targetSnapshot : origin.actorSnapshot;
  const recipient =
    origin.targetSnapshot?.character.name ?? "Unknown Recipient";
  const sessionTitle = snapshot?.sessionTitle ?? "Unknown Session";
  const route = target
    ? target.kind === "auxiliary"
      ? ([target.mainSessionId, target.sessionId] as const)
      : ([target.sessionId] as const)
    : origin.actorKind === "auxiliary"
      ? origin.actorMainSessionId && origin.actorSessionId
        ? ([origin.actorMainSessionId, origin.actorSessionId] as const)
        : null
      : origin.actorSessionId
        ? ([origin.actorSessionId] as const)
        : null;
  return (
    <div className="session-message-address">
      {outbound && onOpenRecipientThread ? (
        <button
          type="button"
          className="session-message-mention"
          title={`Go to this instruction in: ${sessionTitle}`}
          aria-label={`@${recipient}: Go to this instruction in ${sessionTitle}`}
          onClick={onOpenRecipientThread}
        >
          @{recipient}
        </button>
      ) : (
        <span
          className="session-message-mention"
          title={`Recipient: ${recipient}`}
        >
          @{recipient}
        </span>
      )}
      <button
        type="button"
        className="related-session-route"
        disabled={!route || !getWithMateApi()?.openSession}
        title={sessionTitle}
        aria-label={`${outbound ? "Open Recipient" : "Open Sender"}: ${sessionTitle}`}
        onClick={() => {
          if (route)
            void getWithMateApi()!
              .openSession(route[0], route[1])
              .catch((failure) =>
                onError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not open sender Session.",
                ),
              );
        }}
      >
        <span className="related-session-direction" aria-hidden="true">
          {outbound ? "To" : "From"}
        </span>
        <span className="related-session-title">{sessionTitle}</span>
      </button>
    </div>
  );
}

/** 保存済みの実行設定と受付状態を応答の詳細に出し、確認できない読取は個別に再試行できるようにする。 */
function TurnInputDetailsContent({
  message,
  receipt,
  read,
  hasRunChecks = false,
  displayReadError,
  onRetryDisplay,
}: TurnExecutionDetailsProps & { read: ReturnType<typeof useTurnInputRead> }) {
  const { execution, origin, statusReference, readError, setRevision } = read;
  if (message.role !== "assistant" || !statusReference) return null;
  const sourceWaitState = getQueuedSourceWaitState(receipt);
  const captured = receipt?.dispatched ?? receipt?.captured;
  const settings =
    execution?.executionSettings ??
    (captured
      ? {
          source: "input" as const,
          provider: captured.provider,
          ...captured.request.executionOptions,
        }
      : null);
  const hasDelivery = execution?.receiptId || receipt;
  const error = readError || displayReadError;
  return (
    <section className="turn-input-details" aria-label="Turn Input Details">
      {!hasRunChecks && settings ? (
        <ExecutionSettings settings={settings} />
      ) : null}
      {hasDelivery ? (
        <details className="artifact-fold" aria-label="Input State" open>
          <summary className="artifact-fold-summary">
            <span className="artifact-fold-summary-copy">
              <strong>Input State</strong>
            </span>
          </summary>
          <dl
            className="check-list turn-input-rows artifact-fold-body"
            aria-label="Input State"
          >
            {sourceWaitState === "unknown" ? (
              <InputDetailRow label="Delivery">
                <span className="turn-input-state">
                  Source Turn State Unknown
                </span>
              </InputDetailRow>
            ) : null}
            <InputDetailRow label="Receipt State">
              {inputDetailStateLabel(
                execution?.receiptState ?? receipt?.state,
                "No Receipt",
              )}
            </InputDetailRow>
            <InputDetailRow label="Turn State">
              {inputDetailStateLabel(execution?.turnState, "Not Confirmed")}
            </InputDetailRow>
            {execution?.inputs?.entry?.comparison === "changed" ? (
              <InputDetailRow label="Starting Input">
                Edited before this Turn started
              </InputDetailRow>
            ) : null}
            {execution?.retrySource?.changedSinceAcceptance ? (
              <InputDetailRow label="Original Input">
                Edited before the original Turn started
              </InputDetailRow>
            ) : null}
            {execution?.retrySource ? (
              <InputDetailRow label="Original Sender">
                {execution.retrySource.origin.kind === "session"
                  ? (execution.retrySource.origin.actorSnapshot?.character
                      .name ?? "Unknown Session")
                  : "You"}
              </InputDetailRow>
            ) : null}
            {origin?.operation === "send" && origin.kind === "session" ? (
              <InputDetailRow label="Delivery Timing">
                {origin.deliveryTiming === "after_source_turn"
                  ? "After Sender Turn"
                  : "Immediate"}
              </InputDetailRow>
            ) : null}
            {origin?.operation === "send" &&
            origin.kind === "session" &&
            origin.sourceTurnPhase ? (
              <InputDetailRow label="Sender Turn Outcome">
                {inputDetailStateLabel(origin.sourceTurnPhase, "Not Confirmed")}
              </InputDetailRow>
            ) : null}
          </dl>
        </details>
      ) : null}
      {error ? (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="drawer-toggle compact secondary"
            onClick={() => {
              if (readError) setRevision((value) => value + 1);
              if (displayReadError) onRetryDisplay?.();
            }}
          >
            Retry Input Details
          </button>
        </p>
      ) : null}
      {!execution && !readError ? (
        <LoadingIndicator inline label="Loading input details" />
      ) : null}
    </section>
  );
}
