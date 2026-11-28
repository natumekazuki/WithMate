import type { LiveSessionRunState } from "../../../src-shared/session/runtime-state.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";

/** 実行情報がないことも通知できるスナップショット。 */
type LiveState = LiveSessionRunState | null;
/** 初回読込と実行イベント購読をまとめるレンダラー側の窓口。 */
export type SessionLiveIngressApi = {
  getLiveSessionRun?: (sessionId: string) => Promise<LiveState>;
  subscribeLiveSessionRun: (
    listener: (sessionId: string, state: LiveState) => void,
  ) => () => void;
};
/** 詳細保持の要否と、購読ごとの更新・読込失敗の通知先。 */
type Selection = {
  detail: boolean;
  apply: (state: LiveState) => void;
  onError?: (error: unknown) => void;
};
/** セッション単位の購読者と、詳細・操作それぞれのスナップショット、更新世代。 */
type Owner = {
  fullState: LiveState | undefined;
  actionState: LiveState;
  controls: SessionRunControls;
  revision: number;
  pending: boolean;
  selections: Set<Selection>;
};
/** API ごとに一つの実行イベント購読を共有する接続状態。 */
type Ingress = {
  owners: Map<string, Owner>;
  events: Set<(id: string, state: LiveState) => void>;
  dispose: (() => void) | null;
};
const ingresses = new WeakMap<SessionLiveIngressApi, Ingress>();

/** 実行本文を保持せず、承認・質問・中止・追加入力の操作に必要な情報だけを取り出す。 */
export function projectSessionRunControls(state: LiveState) {
  const elicitations =
    state?.elicitationRequests ??
    (state?.elicitationRequest ? [state.elicitationRequest] : []);
  return {
    hasLiveRun: Boolean(state),
    hasAssistantText: Boolean(state?.assistantText),
    hasApprovalRequest: Boolean(state?.approvalRequest),
    hasElicitationRequest: elicitations.length > 0,
    hasBlockingElicitationRequest: elicitations.some(
      (request) => request.blocking !== false,
    ),
    // 等しいスナップショットが同じ操作要素を保てるよう、リクエストの識別情報は安定した文字列にする。
    approvalRequestId: state?.approvalRequest?.requestId ?? "",
    blockingElicitationRequestIds: elicitations
      .filter((request) => request.blocking !== false)
      .map((request) => request.requestId)
      .join("\n"),
    optionalElicitationRequestIds: elicitations
      .filter((request) => request.blocking === false)
      .map((request) => request.requestId)
      .join("\n"),
    hasInProgressStep: Boolean(
      state?.steps.some((step) => step.status === "in_progress"),
    ),
    errorMessage: state?.errorMessage ?? "",
    cancellationState: state?.cancellationState,
    stopTurnId:
      state?.runState !== "idle" && state?.runState !== "error"
        ? state?.sessionTurnId
        : undefined,
    stopReceiptId: state?.queueReceipt?.id,
    stopIncarnationId: state?.queueReceipt?.incarnationId,
    inputTurnId:
      state?.inputAvailable === true && !state.cancellationState
        ? state.turnId
        : undefined,
  };
}
/** 操作部の購読者へ渡す実行情報の軽量な投影。 */
export type SessionRunControls = ReturnType<typeof projectSessionRunControls>;

/** API の同一性にひも付け、各購読者から共有する接続状態を取得する。 */
function getIngress(api: SessionLiveIngressApi): Ingress {
  let ingress = ingresses.get(api);
  if (!ingress) {
    ingress = { owners: new Map(), events: new Set(), dispose: null };
    ingresses.set(api, ingress);
  }
  return ingress;
}

/** 更新世代を進め、詳細購読者がいる間だけ全体を保持して各購読者へ通知する。 */
function publish(owner: Owner, state: LiveState): void {
  ++owner.revision;
  // 操作の更新に必要なのは識別情報と保留中のリクエストであり、会話の詳細ではない。
  owner.actionState = state
    ? {
        ...state,
        assistantText: "",
        reasoningText: "",
        steps: [],
        backgroundTasks: [],
        usage: null,
      }
    : null;
  owner.controls = projectSessionRunControls(state);
  owner.fullState = [...owner.selections].some((selection) => selection.detail)
    ? state
    : undefined;
  for (const selection of owner.selections) selection.apply(state);
}

/** 最初の購読でイベントへ接続し、セッション別の購読とイベント監視の両方へ配信する。 */
function connect(api: SessionLiveIngressApi, ingress: Ingress): void {
  if (ingress.dispose) return;
  ingress.dispose = api.subscribeLiveSessionRun((id, state) => {
    const owner = ingress.owners.get(id);
    if (owner) publish(owner, state);
    for (const listener of ingress.events) listener(id, state);
  });
}

/** セッション別の購読とイベント監視が両方なくなったら接続を解除する。 */
function disconnectUnused(ingress: Ingress): void {
  if (ingress.owners.size || ingress.events.size) return;
  ingress.dispose?.();
  ingress.dispose = null;
}

/** 実行情報を一件ずつ読み、開始時の購読所有者や更新世代が変わっていれば古い結果を反映しない。 */
function loadOwner(
  api: SessionLiveIngressApi,
  ingress: Ingress,
  id: string,
  owner: Owner,
): void {
  if (owner.pending || !api.getLiveSessionRun) return;
  owner.pending = true;
  const revision = owner.revision;
  void api
    .getLiveSessionRun(id)
    .then((state) => {
      if (ingress.owners.get(id) === owner && owner.revision === revision)
        publish(owner, state);
    })
    .catch((error: unknown) => {
      if (ingress.owners.get(id) === owner && owner.revision === revision) {
        for (const selection of owner.selections) selection.onError?.(error);
      }
    })
    .finally(() => {
      owner.pending = false;
      // 操作要素だけの読み取りがイベントで無効になった後から、詳細を表示する画面が購読に加わる場合がある。
      if (
        ingress.owners.get(id) === owner &&
        owner.revision !== revision &&
        owner.fullState === undefined &&
        [...owner.selections].some((selection) => selection.detail)
      ) {
        loadOwner(api, ingress, id, owner);
      }
    });
}

/** 指定セッションから取り出す投影と、変更の比較・通知方法。 */
type SelectionInput<T> = {
  api: SessionLiveIngressApi;
  sessionId: string;
  detail: boolean;
  select: (state: LiveState) => T;
  equal?: (left: T, right: T) => boolean;
  onChange: (value: T) => void;
  onError?: (error: unknown) => void;
};
/** 現在の投影を直ちに通知して購読し、解除時は不要になった詳細や購読所有者を破棄する。 */
function subscribeSelection<T>(
  input: SelectionInput<T>,
  initial: (owner: Owner) => T,
): () => void {
  const ingress = getIngress(input.api);
  let owner = ingress.owners.get(input.sessionId);
  const created = !owner;
  if (!owner) {
    owner = {
      fullState: undefined,
      actionState: null,
      controls: projectSessionRunControls(null),
      revision: 0,
      pending: false,
      selections: new Set(),
    };
    ingress.owners.set(input.sessionId, owner);
  }
  let current: T;
  let initialized = false;
  const selection: Selection = {
    detail: input.detail,
    onError: input.onError,
    /** 投影を更新し、前回の結果と等しい場合は変更通知を省く。 */
    apply: (state) => {
      const next = input.select(state);
      if (initialized && (input.equal ?? Object.is)(current, next)) return;
      current = next;
      initialized = true;
      input.onChange(next);
    },
  };
  owner.selections.add(selection);
  current = initial(owner);
  initialized = true;
  input.onChange(current);
  connect(input.api, ingress);
  if (created || (input.detail && owner.fullState === undefined))
    loadOwner(input.api, ingress, input.sessionId, owner);
  return () => {
    owner.selections.delete(selection);
    if (![...owner.selections].some((subscriber) => subscriber.detail))
      owner.fullState = undefined;
    if (!owner.selections.size) ingress.owners.delete(input.sessionId);
    disconnectUnused(ingress);
  };
}

/** 実行の詳細を保持する購読として登録し、現在の詳細から最初の投影を作る。 */
export function subscribeSessionLiveSelection<T>(
  input: Omit<SelectionInput<T>, "detail">,
): () => void {
  return subscribeSelection({ ...input, detail: true }, (owner) =>
    input.select(owner.fullState ?? null),
  );
}

/** 詳細保持を要求せず、操作に関わる項目が変わったときだけ新しい投影を通知する。 */
export function subscribeSessionRunControls(input: {
  api: SessionLiveIngressApi;
  sessionId: string;
  onChange: (controls: SessionRunControls) => void;
}): () => void {
  return subscribeSelection(
    {
      ...input,
      detail: false,
      select: projectSessionRunControls,
      /** 操作に使うすべての項目が前回と同じかを比較する。 */
      equal: (left, right) =>
        (Object.keys(left) as Array<keyof SessionRunControls>).every(
          (key) => left[key] === right[key],
        ),
    },
    (owner) => owner.controls,
  );
}

/** イベント監視側はペイロードを保持せず、スナップショットの所有者も作らない。 */
export function subscribeSessionLiveEvents(
  api: SessionLiveIngressApi,
  listener: (id: string, state: LiveState) => void,
): () => void {
  const ingress = getIngress(api);
  ingress.events.add(listener);
  connect(api, ingress);
  return () => {
    ingress.events.delete(listener);
    disconnectUnused(ingress);
  };
}

/** 現在の購読所有者で観測した実行情報の更新世代を返す。未購読なら 0 を返す。 */
export function getSessionLiveRevision(
  api: SessionLiveIngressApi,
  sessionId: string,
): number {
  return getIngress(api).owners.get(sessionId)?.revision ?? 0;
}

/** 現在購読中の対象に限り、所有者の一致と変更の有無を確認してローカル更新を配信する。 */
export function updateSessionLiveState(
  api: SessionLiveIngressApi,
  id: string,
  update:
    | OwnedLiveSessionRunState
    | ((current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState),
): void {
  const ingress = getIngress(api);
  const owner = ingress.owners.get(id);
  if (!owner) return;
  const previous = {
    ownerSessionId: id,
    state: owner.fullState ?? owner.actionState,
  };
  const next = typeof update === "function" ? update(previous) : update;
  if (next === previous || next.ownerSessionId !== id) return;
  publish(owner, next.state);
}
