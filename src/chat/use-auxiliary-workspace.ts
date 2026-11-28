import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import {
  projectAuxiliarySessionSummary,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ConcurrentChatWindowProps } from "./chat-window.js";
import type {
  ConversationColumnSession,
  ConversationMessageColumnApi,
} from "./conversation-message-column.js";
import type { SessionMessageColumnProps } from "./conversation/session-message-column.js";
import {
  setMessageBookmarked,
  type MessageArtifact,
} from "../../src-shared/session/session-state.js";
import { mergeMessageBookmarkProjection } from "./runtime/session-submit-coordinator.js";
import {
  captureSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { subscribeSessionLiveEvents } from "./runtime/session-window-live-ingress.js";
import {
  startConversationDetailSubscription,
  type SessionSummaryInvalidationSubscriptionApi,
} from "./runtime/session-summary-subscription.js";

/** 親に属する補助会話の一覧・詳細・実行状態を取得し、利用可能な変更通知を購読する境界。 */
export type AuxiliaryWorkspaceApi = {
  /** 指定した親に所属する補助会話の要約を取得する。 */
  listAuxiliarySessions(
    parentSessionId: string,
  ): Promise<AuxiliarySessionSummary[]>;
  /** 補助会話の履歴を含む詳細を取得し、存在しなければ null を返す。 */
  getAuxiliarySession(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySession | null>;
  /** 本文を再取得せず、補助会話の所属・世代・実行状態だけを確認する。 */
  getAuxiliarySessionStatus(
    auxiliarySessionId: string,
  ): Promise<Pick<
    AuxiliarySession,
    "id" | "parentSessionId" | "createdAt" | "runState"
  > | null>;
  subscribeSessionInvalidation?: SessionSummaryInvalidationSubscriptionApi["subscribeSessionInvalidation"];
  getUnreadSessionResult?: ConversationMessageColumnApi["getUnreadSessionResult"];
  onSessionTurnUpdated?: ConversationMessageColumnApi["onSessionTurnUpdated"];
  subscribeLiveSessionRun?: (
    listener: (sessionId: string, state: LiveSessionRunState | null) => void,
  ) => () => void;
};

/** 親と補助のどちらへ入力を送るかを示す。表示中の補助会話の選択とは別に保持する。 */
export type AuxiliaryWorkspaceTarget = "main" | "auxiliary";
/** 画面で非表示になっても会話単位で操作するための状態・保存キューと更新処理。 */
export type AuxiliarySessionBinding = {
  sessionRef: { current: AuxiliarySession | null };
  mutationRevision: { current: number };
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  /** 会話の詳細と一覧の要約に変更を反映する。 */
  setSession(update: SetStateAction<AuxiliarySession | null>): void;
  /** 元の履歴位置で対象を特定し、読み込み済みの行にブックマークを反映する。 */
  setMessageBookmark(messageIndex: number, isBookmarked: boolean): void;
  /** 再描画を待たずに、この対象の現行の詳細を取得する。 */
  getSession(): AuxiliarySession | null;
  /** 保存済みの詳細を読み直しても直近の実行設定を合成できるよう選択を保持する。 */
  setExecutionSelection(session: AuxiliarySession): void;
  /** 操作中の詳細をキャッシュ退避から保護し、終了時に保護を解除する関数を返す。 */
  retainDetail(): () => void;
};

/** 現在の親に属する補助会話と、選択・送信先・画面分割を扱う操作。 */
export type AuxiliaryWorkspace = {
  summaries: AuxiliarySessionSummary[];
  selectedId: string | null;
  /** 非同期処理から最新の選択を同期的に参照する。 */
  getCurrentSelectedId(): string | null;
  selectedSession: AuxiliarySession | null;
  loading: boolean;
  error: Error | null;
  detailLoading: boolean;
  detailError: Error | null;
  target: AuxiliaryWorkspaceTarget;
  widthRatio: number;
  /** ドラッグ中の分割比率を表示へ反映する。 */
  setWidthRatio(ratio: number): void;
  /** 確定した分割比率を親ごとの表示設定に保存する。 */
  commitWidthRatio(): void;
  /** 表示する補助会話を選択し、null なら選択を解除する。 */
  selectSession(id: string | null): void;
  /** 通知などから補助会話を選択する。入力の送信先は切り替えない。 */
  requestSessionSelection(id: string): void;
  /** 入力の送信先を親または補助会話に切り替える。 */
  setTarget(target: AuxiliaryWorkspaceTarget): void;
  /** 現在の親に属する確定済みの補助会話を追加し、選択と送信先を移す。 */
  addSession(saved: AuxiliarySession): void;
  /** 親に属する補助会話の要約を保存先から再取得する。 */
  refreshSummaries(): Promise<void>;
  /** 新しい編集時刻を反映し、必要なときだけ一覧の使用順を変える。 */
  touchRecency(id: string, updatedAt: string): void;
  /** 対象会話に紐づく更新口を取得する。未選択なら変更を行わない更新口を返す。 */
  getBinding(id: string | null): AuxiliarySessionBinding;
  /** 現在の選択状態と列ごとの操作を、親・補助の並列表示へ渡す。 */
  buildConcurrentChats(
    input: AuxiliaryConcurrentChatSurfaceInput,
  ): ConcurrentChatWindowProps;
};

/** 並列表示に使う親・補助それぞれの会話情報、状態、履歴操作。 */
export type AuxiliaryConcurrentChatSurfaceInput = {
  mainSession: ConversationColumnSession | null;
  auxiliarySession: ConversationColumnSession | null;
  api?: ConversationMessageColumnApi;
  mainLiveRun?: LiveSessionRunState | null;
  auxiliaryLiveRun?: LiveSessionRunState | null;
  messageColumn: SessionMessageColumnProps;
  onToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
  mainOnLoadArtifactDetail?: (index: number) => Promise<MessageArtifact | null>;
  mainOnOpenPath?: (target: string) => void;
  auxiliaryOnLoadArtifactDetail?: (
    index: number,
  ) => Promise<MessageArtifact | null>;
  auxiliaryOnOpenPath?: (target: string) => void;
  onAddAuxiliary?: () => void;
  isAddAuxiliaryDisabled?: boolean;
  scrollToLatestOnSend?: boolean;
};

const DEFAULT_WIDTH_RATIO = 0;
const HIDDEN_DETAIL_CACHE_LIMIT = 8;
const PREFS_KEY_PREFIX = "withmate:auxiliary-workspace:";

/** 親ごとに復元する、最後の補助会話の選択と確定済みの分割比率。 */
type WorkspacePrefs = { selectedId: string | null; widthRatio: number };

/** 別の親の表示設定を上書きしないよう、保存キーを親の識別子で分ける。 */
function prefsKey(parentSessionId: string): string {
  return `${PREFS_KEY_PREFIX}${parentSessionId}`;
}

/** 親の保存済み設定を読み、欠落・破損した項目は既定値にする。 */
function readPrefs(parentSessionId: string): WorkspacePrefs {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(prefsKey(parentSessionId)) ?? "null",
    ) as Partial<WorkspacePrefs> | null;
    const widthRatio =
      typeof value?.widthRatio === "number" && Number.isFinite(value.widthRatio)
        ? clampAuxiliaryWidthRatio(value.widthRatio)
        : DEFAULT_WIDTH_RATIO;
    return {
      selectedId:
        typeof value?.selectedId === "string" ? value.selectedId : null,
      widthRatio,
    };
  } catch {
    return { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
  }
}

/** 表示設定を親ごとに保存し、保存できなくても現在の画面状態は維持する。 */
function writePrefs(parentSessionId: string, prefs: WorkspacePrefs): void {
  try {
    window.localStorage.setItem(
      prefsKey(parentSessionId),
      JSON.stringify(prefs),
    );
  } catch {
    // ストレージが使えなくてもよい。引き続きメモリ上の状態を正本とする。
  }
}

/** 選択と分割比率の両方を比較し、保存済み設定から変更されたかを判断できるようにする。 */
function samePrefs(left: WorkspacePrefs, right: WorkspacePrefs): boolean {
  return (
    left.selectedId === right.selectedId && left.widthRatio === right.widthRatio
  );
}

/** 保存時刻と画面での編集時刻の新しい方を使って並べ、同時刻なら識別子の降順にする。 */
function sortByLastUsed(
  summaries: AuxiliarySessionSummary[],
  recency?: ReadonlyMap<string, string>,
): AuxiliarySessionSummary[] {
  return [...summaries].sort((left, right) => {
    const leftTime = recency?.get(left.id);
    const rightTime = recency?.get(right.id);
    const updated = (
      rightTime && rightTime > right.updatedAt ? rightTime : right.updatedAt
    ).localeCompare(
      leftTime && leftTime > left.updatedAt ? leftTime : left.updatedAt,
    );
    return updated || right.id.localeCompare(left.id);
  });
}

/** 要約の項目と値を浅く比較し、変更のない一覧更新を避ける。 */
function sameSummary(
  left: AuxiliarySessionSummary,
  right: AuxiliarySessionSummary,
): boolean {
  const keys = Object.keys(right) as Array<keyof AuxiliarySessionSummary>;
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => {
      return left[key] === right[key];
    })
  );
}

/** 指定した要約を追加・更新・削除し、値が同じなら一覧の参照を維持する。 */
function replaceSummary(
  current: AuxiliarySessionSummary[],
  id: string,
  next: AuxiliarySessionSummary | null,
  recency?: ReadonlyMap<string, string>,
): AuxiliarySessionSummary[] {
  const index = current.findIndex((summary) => summary.id === id);
  if (index < 0)
    return next ? sortByLastUsed([...current, next], recency) : current;
  if (next && sameSummary(current[index], next)) return current;
  const updated = current.slice();
  if (!next) updated.splice(index, 1);
  else updated[index] = next;
  return next && current[index].updatedAt !== next.updatedAt
    ? sortByLastUsed(updated, recency)
    : updated;
}

/** 分割比率を 0 から 1 に収め、有限値でなければ既定値に戻す。 */
export function clampAuxiliaryWidthRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_WIDTH_RATIO;
  return Math.min(1, Math.max(0, ratio));
}

/** 未読結果を親・会話・作成時刻の組で識別し、別の世代の未読と混同しないようにする。 */
function auxiliaryResultKey(
  owner: string,
  id: string,
  createdAt: string,
): string {
  return JSON.stringify([owner, id, createdAt]);
}

/** 現在の親に所属する補助会話の未読結果を購読し、一覧の順序とは独立して保持する。 */
function useAuxiliarySwitcherUnread(
  api: AuxiliaryWorkspaceApi | null,
  owner: string | null,
  summaries: AuxiliarySessionSummary[],
) {
  // 読み取る共有結果は所属によって決まり、一覧の順序や実行時状態・詳細の更新には左右されない。
  const membership = JSON.stringify(
    summaries
      .filter((item) => item.parentSessionId === owner)
      .map(({ id, createdAt }) => [id, createdAt])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!owner || !api?.getUnreadSessionResult) return;
    const targets = new Map<string, string>(
      (JSON.parse(membership) as [string, string][]).map(([id, createdAt]) => [
        id,
        auxiliaryResultKey(owner, id, createdAt),
      ]),
    );
    const allowed = new Set(targets.values());
    setUnread((previous) =>
      [...previous].every((key) => allowed.has(key))
        ? previous
        : new Set([...previous].filter((key) => allowed.has(key))),
    );
    const revisions = new Map<string, number>();
    let active = true;
    /** 所属する会話だけの未読結果を取得し、要求が前後した場合は新しい方だけを反映する。 */
    const read = (id: string) => {
      const key = targets.get(id);
      if (!key) return;
      const revision = (revisions.get(id) ?? 0) + 1;
      revisions.set(id, revision);
      void api.getUnreadSessionResult?.(id).then(
        (result) => {
          if (!active || revisions.get(id) !== revision) return;
          setUnread((previous) => {
            if (previous.has(key) === (result !== null)) return previous;
            const next = new Set(previous);
            if (result) next.add(key);
            else next.delete(key);
            return next;
          });
        },
        () => {
          /* 一時的に読み取りが失敗した場合は、直近の確認済み表示を維持する。 */
        },
      );
    };
    const unsubscribe = api.onSessionTurnUpdated?.(read);
    for (const id of targets.keys()) read(id);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api, owner, membership]);
  return unread;
}

/** 親ごとの補助会話一覧・詳細・表示設定を管理し、実行や保存の通知を現在の作業領域に反映する。 */
export function useAuxiliaryWorkspace(input: {
  parentSessionId: string | null;
  api: AuxiliaryWorkspaceApi | null;
  initialSelectedId?: string | null;
}): AuxiliaryWorkspace {
  const { parentSessionId, api, initialSelectedId } = input;
  const normalizedInitialSelectedId = initialSelectedId?.trim() || null;
  const parentSessionIdRef = useRef(parentSessionId);
  parentSessionIdRef.current = parentSessionId;
  const [summaries, setSummaries] = useState<AuxiliarySessionSummary[]>([]);
  const summariesRef = useRef<AuxiliarySessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] =
    useState<AuxiliarySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [target, setTargetState] = useState<AuxiliaryWorkspaceTarget>("main");
  const prefsRef = useRef<WorkspacePrefs | null>(null);
  if (prefsRef.current === null) {
    prefsRef.current = parentSessionId
      ? readPrefs(parentSessionId)
      : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
  }
  const initialPrefs = prefsRef.current;
  const persistedPrefsRef = useRef<WorkspacePrefs>(initialPrefs);
  const prefsParentSessionIdRef = useRef(parentSessionId);
  const widthRatioRef = useRef(initialPrefs.widthRatio);
  const [widthRatio, setWidthRatioState] = useState(widthRatioRef.current);
  const selectedIdRef = useRef<string | null>(null);
  const requestedSelectionRef = useRef<string | null>(null);
  const pendingSelectionIdRef = useRef<string | null>(
    normalizedInitialSelectedId,
  );
  const detailsRef = useRef(new Map<string, AuxiliarySession>());
  const bindingsRef = useRef(new Map<string, AuxiliarySessionBinding>());
  const dirtyDetailsRef = useRef(new Set<string>());
  const detailOperationsRef = useRef(new Map<string, number>());
  const operationWasDirtyRef = useRef(new Map<string, boolean>());
  const detailQueuesRef = useRef(new Map<string, number>());
  const detailLoadingIdsRef = useRef(new Set<string>());
  const pruneDetails = useCallback(() => {
    const reusable = [...detailsRef.current.keys()].filter(
      (id) =>
        id !== selectedIdRef.current &&
        detailsRef.current.get(id)?.runState !== "running" &&
        !dirtyDetailsRef.current.has(id) &&
        !detailOperationsRef.current.has(id) &&
        !detailQueuesRef.current.has(id) &&
        !detailLoadingIdsRef.current.has(id),
    );
    for (const id of reusable.slice(
      0,
      Math.max(0, reusable.length - HIDDEN_DETAIL_CACHE_LIMIT),
    )) {
      detailsRef.current.delete(id);
      const binding = bindingsRef.current.get(id);
      if (binding) binding.sessionRef.current = null;
    }
  }, []);
  const cacheDetail = useCallback(
    (id: string, session: AuxiliarySession) => {
      detailsRef.current.delete(id);
      detailsRef.current.set(id, session);
      const binding = bindingsRef.current.get(id);
      if (binding) binding.sessionRef.current = session;
      pruneDetails();
    },
    [pruneDetails],
  );
  const executionSelectionsRef = useRef(
    new Map<string, { createdAt: string; options: SessionExecutionOptions }>(),
  );
  const mergeExecutionSelection = useCallback(
    (session: AuxiliarySession): AuxiliarySession => {
      const selection = executionSelectionsRef.current.get(session.id);
      if (!selection) return session;
      if (selection.createdAt !== session.createdAt) {
        executionSelectionsRef.current.delete(session.id);
        return session;
      }
      const selected = Object.entries(selection.options).every(
        ([key, value]) =>
          session[key as keyof SessionExecutionOptions] === value,
      )
        ? session
        : { ...session, ...selection.options };
      return selected;
    },
    [],
  );
  const loadRevisionRef = useRef(0);
  const listRevisionRef = useRef(0);
  const mutationRevisionRef = useRef(0);
  const workspaceGenerationRef = useRef(0);
  const detailMutationEpochRef = useRef(new Map<string, number>());
  const bookmarkRevisionRef = useRef(new Map<string, number>());
  const detailReadRevisionRef = useRef(new Map<string, number>());
  const recencyRef = useRef(new Map<string, string>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistPrefs = useCallback(
    (next: Partial<WorkspacePrefs>) => {
      const current = prefsRef.current;
      if (!current) return;
      prefsRef.current = { ...current, ...next };
      const persisted = persistedPrefsRef.current;
      const updatedPersisted = { ...persisted, ...next };
      if (samePrefs(persisted, updatedPersisted)) return;
      persistedPrefsRef.current = updatedPersisted;
      if (parentSessionId) writePrefs(parentSessionId, updatedPersisted);
    },
    [parentSessionId],
  );

  const refreshSummaries = useCallback(async () => {
    if (!api || !parentSessionId) {
      setSummaries([]);
      setLoading(false);
      return;
    }
    const requestRevision = ++listRevisionRef.current;
    const requestParentId = parentSessionId;
    const requestMutationRevision = mutationRevisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = sortByLastUsed(
        await api.listAuxiliarySessions(parentSessionId),
        recencyRef.current,
      );
      if (
        !mountedRef.current ||
        requestRevision !== listRevisionRef.current ||
        requestParentId !== parentSessionIdRef.current ||
        requestMutationRevision !== mutationRevisionRef.current
      )
        return;
      const previous = summariesRef.current;
      const stable =
        next.length === previous.length &&
        next.every(
          (summary, index) =>
            summary.id === previous[index].id &&
            sameSummary(summary, previous[index]),
        )
          ? previous
          : next;
      if (stable !== previous) setSummaries(stable);
      summariesRef.current = stable;
      const preferred = prefsRef.current?.selectedId ?? null;
      const requested = requestedSelectionRef.current;
      const requestedId = pendingSelectionIdRef.current;
      const hasRequestedId =
        requestedId !== null &&
        next.some((summary) => summary.id === requestedId);
      const hasLegacyRequestedId =
        requested !== null && next.some((summary) => summary.id === requested);
      const nextId =
        requested !== null
          ? requested
          : hasRequestedId
            ? requestedId
            : selectedIdRef.current &&
                next.some((summary) => summary.id === selectedIdRef.current)
              ? selectedIdRef.current
              : preferred && next.some((summary) => summary.id === preferred)
                ? preferred
                : (next[0]?.id ?? null);
      if (hasRequestedId) {
        pendingSelectionIdRef.current = null;
        persistPrefs({ selectedId: nextId });
      }
      if (hasLegacyRequestedId) {
        requestedSelectionRef.current = null;
      }
      if (nextId !== selectedIdRef.current) {
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
      }
    } catch (cause) {
      if (
        !mountedRef.current ||
        requestRevision !== listRevisionRef.current ||
        requestMutationRevision !== mutationRevisionRef.current
      )
        return;
      const nextError =
        cause instanceof Error ? cause : new Error(String(cause));
      setError(nextError);
    } finally {
      if (
        requestRevision === listRevisionRef.current &&
        requestMutationRevision === mutationRevisionRef.current
      ) {
        setLoading(false);
      }
    }
  }, [api, parentSessionId, persistPrefs]);

  useEffect(() => {
    if (prefsParentSessionIdRef.current !== parentSessionId) {
      prefsParentSessionIdRef.current = parentSessionId;
      const nextPrefs = parentSessionId
        ? readPrefs(parentSessionId)
        : { selectedId: null, widthRatio: DEFAULT_WIDTH_RATIO };
      prefsRef.current = nextPrefs;
      persistedPrefsRef.current = nextPrefs;
      widthRatioRef.current = nextPrefs.widthRatio;
      setWidthRatioState(widthRatioRef.current);
    }
    selectedIdRef.current = null;
    requestedSelectionRef.current = null;
    pendingSelectionIdRef.current = normalizedInitialSelectedId;
    setSelectedId(null);
    setSelectedSession(null);
    summariesRef.current = [];
    setSummaries([]);
    setTargetState("main");
    detailsRef.current.clear();
    executionSelectionsRef.current.clear();
    bindingsRef.current.clear();
    dirtyDetailsRef.current.clear();
    detailOperationsRef.current.clear();
    operationWasDirtyRef.current.clear();
    detailQueuesRef.current.clear();
    detailLoadingIdsRef.current.clear();
    detailMutationEpochRef.current.clear();
    bookmarkRevisionRef.current.clear();
    detailReadRevisionRef.current.clear();
    recencyRef.current.clear();
    workspaceGenerationRef.current += 1;
    mutationRevisionRef.current += 1;
    listRevisionRef.current += 1;
    setDetailLoading(false);
    setDetailError(null);
    setError(null);
    void refreshSummaries();
  }, [initialSelectedId, parentSessionId, refreshSummaries]);

  useEffect(() => {
    const id = selectedId;
    const revision = ++loadRevisionRef.current;
    if (!id) {
      setSelectedSession(null);
      pruneDetails();
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const cached =
      detailsRef.current.get(id) ??
      bindingsRef.current.get(id)?.sessionRef.current ??
      null;
    if (cached) {
      cacheDetail(id, cached);
      setSelectedSession(cached);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    setSelectedSession(null);
    setDetailLoading(true);
    setDetailError(null);
    const detailEpoch = detailMutationEpochRef.current.get(id) ?? 0;
    if (!api) {
      setDetailLoading(false);
      return;
    }
    void api
      .getAuxiliarySession(id)
      .then((session) => {
        if (
          !mountedRef.current ||
          revision !== loadRevisionRef.current ||
          selectedIdRef.current !== id
        )
          return;
        const mergedSession = session ? mergeExecutionSelection(session) : null;
        if (
          mergedSession &&
          detailEpoch === (detailMutationEpochRef.current.get(id) ?? 0)
        ) {
          cacheDetail(id, mergedSession);
        }
        if (detailEpoch === (detailMutationEpochRef.current.get(id) ?? 0)) {
          if (mergedSession) {
            setSelectedSession(mergedSession);
            setDetailError(null);
          } else {
            setDetailError(new Error(`Auxiliary session ${id} was not found`));
          }
        }
        setDetailLoading(false);
      })
      .catch((cause) => {
        if (
          !mountedRef.current ||
          revision !== loadRevisionRef.current ||
          selectedIdRef.current !== id
        )
          return;
        if (detailEpoch !== (detailMutationEpochRef.current.get(id) ?? 0))
          return;
        const detailCause =
          cause instanceof Error ? cause : new Error(String(cause));
        setDetailError(detailCause);
        setDetailLoading(false);
      });
  }, [api, cacheDetail, mergeExecutionSelection, pruneDetails, selectedId]);

  useEffect(() => {
    if (!api || !parentSessionId) return;
    let active = true;
    const subscriptionGeneration = workspaceGenerationRef.current;
    const statusRequests = new Map<string, { pending: boolean }>();
    const liveStatusKeys = new Map<string, { key: string }>();
    const detailLoads = new Map<
      string,
      {
        revision: number;
        status?: NonNullable<
          Awaited<
            ReturnType<AuxiliaryWorkspaceApi["getAuxiliarySessionStatus"]>
          >
        >;
        resolvedEpoch?: number;
      }
    >();
    /** 有効な読み取りを一覧と詳細へ反映し、取得中の実行設定・ブックマークの変更も維持する。 */
    const applySession = (
      id: string,
      session: AuxiliarySession,
      readRevision: number,
      readEpoch: number,
      bookmarkRevision: number,
    ) => {
      if (
        !active ||
        !mountedRef.current ||
        subscriptionGeneration !== workspaceGenerationRef.current ||
        readRevision !== detailReadRevisionRef.current.get(id) ||
        readEpoch !== (detailMutationEpochRef.current.get(id) ?? 0)
      )
        return;
      session = mergeExecutionSelection(session);
      if (bookmarkRevision !== (bookmarkRevisionRef.current.get(id) ?? 0)) {
        const projected = detailsRef.current.get(id);
        if (projected?.createdAt === session.createdAt) {
          session = {
            ...session,
            messages: mergeMessageBookmarkProjection(
              projected.messages,
              session.messages,
            ),
          };
        }
      }
      const nextSummaries = replaceSummary(
        summariesRef.current,
        id,
        projectAuxiliarySessionSummary(session),
        recencyRef.current,
      );
      if (nextSummaries !== summariesRef.current) {
        summariesRef.current = nextSummaries;
        setSummaries(nextSummaries);
      }
      cacheDetail(id, session);
      if (selectedIdRef.current === id) {
        setSelectedSession(session);
        setDetailLoading(false);
        setDetailError(null);
      }
    };
    /** 会話ごとの実行状態照会を集約し、新しく確認した状態は取得中の本文にも合流させる。 */
    const refreshStatus = (id: string) => {
      const existing = statusRequests.get(id);
      if (existing) {
        existing.pending = true;
        return;
      }
      const request = { pending: false };
      statusRequests.set(id, request);
      const liveStatusKey = liveStatusKeys.get(id);
      const revision = detailReadRevisionRef.current.get(id);
      const epoch = detailMutationEpochRef.current.get(id) ?? 0;
      const pendingDetail = detailLoads.get(id);
      void api
        .getAuxiliarySessionStatus(id)
        .then((status) => {
          const currentEpoch = detailMutationEpochRef.current.get(id) ?? 0;
          if (
            !active ||
            !mountedRef.current ||
            subscriptionGeneration !== workspaceGenerationRef.current ||
            revision !== detailReadRevisionRef.current.get(id) ||
            (epoch !== currentEpoch &&
              pendingDetail?.resolvedEpoch !== currentEpoch) ||
            !status
          )
            return;
          const summary = summariesRef.current.find((item) => item.id === id);
          if (
            !summary ||
            summary.parentSessionId !== status.parentSessionId ||
            summary.createdAt !== status.createdAt
          )
            return;
          // 新しい実行状態で、処理中の詳細読み取りに含まれる完了済みメッセージを捨ててはいけない。
          // 本文が届いたら、その確認済み状態を合流させる。
          const detailLoad = detailLoads.get(id);
          if (detailLoad) detailLoad.status = status;
          const nextSummaries = replaceSummary(
            summariesRef.current,
            id,
            { ...summary, runState: status.runState },
            recencyRef.current,
          );
          if (nextSummaries !== summariesRef.current) {
            summariesRef.current = nextSummaries;
            setSummaries(nextSummaries);
          }
          const detail = detailsRef.current.get(id);
          if (detail && detail.runState !== status.runState) {
            const next = { ...detail, runState: status.runState };
            detailsRef.current.set(id, next);
            const binding = bindingsRef.current.get(id);
            if (binding) binding.sessionRef.current = next;
            if (selectedIdRef.current === id) setSelectedSession(next);
          }
          pruneDetails();
        })
        .catch((cause) => {
          // この観測結果だけを消す。後続の A/B/A 遷移では、意味上のキーが同じでも
          // 状態の更新がキューに残っている場合がある。
          if (liveStatusKeys.get(id) === liveStatusKey)
            liveStatusKeys.delete(id);
          if (
            active &&
            mountedRef.current &&
            subscriptionGeneration === workspaceGenerationRef.current &&
            revision === detailReadRevisionRef.current.get(id)
          ) {
            console.error(
              "Failed to refresh Auxiliary session run state",
              cause,
            );
          }
        })
        .finally(() => {
          statusRequests.delete(id);
          if (
            request.pending &&
            active &&
            mountedRef.current &&
            subscriptionGeneration === workspaceGenerationRef.current
          )
            refreshStatus(id);
        });
    };
    /** 終了または保存の通知から詳細を読み直し、同じ会話の新しい実行状態があれば確定本文と合成する。 */
    const refreshDetail = (id: string, terminal: boolean) => {
      if (terminal) liveStatusKeys.delete(id);
      const readRevision = (detailReadRevisionRef.current.get(id) ?? 0) + 1;
      detailReadRevisionRef.current.set(id, readRevision);
      detailLoads.set(id, { revision: readRevision });
      detailLoadingIdsRef.current.add(id);
      const pendingStatus = statusRequests.get(id);
      if (terminal && pendingStatus) pendingStatus.pending = false;
      const readStartEpoch = detailMutationEpochRef.current.get(id) ?? 0;
      const readBookmarkRevision = bookmarkRevisionRef.current.get(id) ?? 0;
      void api
        .getAuxiliarySession(id)
        .then((session) => {
          if (
            !active ||
            !mountedRef.current ||
            subscriptionGeneration !== workspaceGenerationRef.current ||
            readRevision !== detailReadRevisionRef.current.get(id)
          )
            return;
          if (readStartEpoch !== (detailMutationEpochRef.current.get(id) ?? 0))
            return;
          mutationRevisionRef.current += 1;
          setLoading(false);
          const resolvedEpoch = readStartEpoch + 1;
          detailMutationEpochRef.current.set(id, resolvedEpoch);
          if (session) {
            const detailLoad = detailLoads.get(id)!;
            detailLoad.resolvedEpoch = resolvedEpoch;
            const status = detailLoad.status;
            if (
              status &&
              status.createdAt === session.createdAt &&
              status.parentSessionId === session.parentSessionId
            ) {
              session = { ...session, runState: status.runState };
            }
            applySession(
              id,
              session,
              readRevision,
              resolvedEpoch,
              readBookmarkRevision,
            );
            return;
          }
          detailsRef.current.delete(id);
          const binding = bindingsRef.current.get(id);
          if (binding) binding.sessionRef.current = null;
          if (selectedIdRef.current === id) {
            setSelectedSession(null);
            setDetailLoading(false);
            setDetailError(new Error(`Auxiliary session ${id} was not found`));
          }
          void refreshSummaries();
        })
        .catch((cause) => {
          if (
            active &&
            mountedRef.current &&
            subscriptionGeneration === workspaceGenerationRef.current &&
            readRevision === detailReadRevisionRef.current.get(id)
          ) {
            const detailCause =
              cause instanceof Error ? cause : new Error(String(cause));
            if (selectedIdRef.current === id) {
              setDetailLoading(false);
              setDetailError(detailCause);
            }
          }
        })
        .finally(() => {
          if (detailLoads.get(id)?.revision === readRevision) {
            detailLoads.delete(id);
            if (
              active &&
              subscriptionGeneration === workspaceGenerationRef.current
            ) {
              detailLoadingIdsRef.current.delete(id);
              pruneDetails();
            }
          }
        });
    };
    const unsubscribeLive = api.subscribeLiveSessionRun
      ? subscribeSessionLiveEvents(
          api as AuxiliaryWorkspaceApi &
            Required<Pick<AuxiliaryWorkspaceApi, "subscribeLiveSessionRun">>,
          (id, state) => {
            if (
              !active ||
              subscriptionGeneration !== workspaceGenerationRef.current
            )
              return;
            const summary = summariesRef.current.find((item) => item.id === id);
            if (!summary) return;
            if (state === null) {
              refreshDetail(id, true);
              return;
            }
            const key = JSON.stringify([
              summary.createdAt,
              state.runState,
              state.turnId,
              state.cancellationState,
              state.inputAvailable,
            ]);
            if (liveStatusKeys.get(id)?.key === key) return;
            liveStatusKeys.set(id, { key });
            refreshStatus(id);
          },
        )
      : () => undefined;
    const unsubscribeSaved = startConversationDetailSubscription({
      api,
      ownerSessionId: parentSessionId,
      /** 保存通知を受け、選択中または保持中の詳細だけを再取得する。 */
      onChange: () => {
        const ids = new Set(detailsRef.current.keys());
        if (selectedIdRef.current) ids.add(selectedIdRef.current);
        for (const id of ids) refreshDetail(id, false);
      },
    });
    return () => {
      active = false;
      unsubscribeLive();
      unsubscribeSaved();
    };
  }, [
    api,
    cacheDetail,
    mergeExecutionSelection,
    parentSessionId,
    pruneDetails,
    refreshSummaries,
  ]);

  const touchRecency = useCallback((id: string, updatedAt: string) => {
    const current = summariesRef.current;
    const recordedTime = recencyRef.current.get(id);
    if (recordedTime && updatedAt <= recordedTime) return;
    if (current[0]?.id === id) {
      if (updatedAt > current[0].updatedAt)
        recencyRef.current.set(id, updatedAt);
      return;
    }
    const index = current.findIndex((summary) => summary.id === id);
    if (index < 0) return;
    const previousTime = recencyRef.current.get(id) ?? current[index].updatedAt;
    if (updatedAt <= previousTime) return;
    recencyRef.current.set(id, updatedAt);
    const next = current.slice();
    next.splice(index, 1);
    const nextIndex = next.findIndex((summary) => {
      const recorded = recencyRef.current.get(summary.id);
      const time =
        recorded && recorded > summary.updatedAt ? recorded : summary.updatedAt;
      return (
        updatedAt > time ||
        (updatedAt === time && id.localeCompare(summary.id) > 0)
      );
    });
    const insertionIndex = nextIndex < 0 ? next.length : nextIndex;
    if (insertionIndex === index) return;
    next.splice(insertionIndex, 0, { ...current[index], updatedAt });
    mutationRevisionRef.current += 1;
    summariesRef.current = next;
    setSummaries(next);
  }, []);

  const selectSession = useCallback(
    (id: string | null) => {
      if (id !== null && !summaries.some((summary) => summary.id === id)) {
        pendingSelectionIdRef.current = id;
        void refreshSummaries();
        return;
      }
      pendingSelectionIdRef.current = null;
      requestedSelectionRef.current = null;
      selectedIdRef.current = id;
      setSelectedId(id);
      setSelectedSession(id ? (detailsRef.current.get(id) ?? null) : null);
      pruneDetails();
      persistPrefs({ selectedId: id });
    },
    [persistPrefs, pruneDetails, refreshSummaries, summaries],
  );

  const requestSessionSelection = useCallback(
    (id: string) => {
      const normalizedId = id.trim();
      if (!normalizedId) {
        return;
      }
      requestedSelectionRef.current = normalizedId;
      selectedIdRef.current = normalizedId;
      setSelectedId(normalizedId);
      setSelectedSession(detailsRef.current.get(normalizedId) ?? null);
      pruneDetails();
      setTargetState("auxiliary");
      persistPrefs({ selectedId: normalizedId });
    },
    [persistPrefs, pruneDetails],
  );

  const setWidthRatio = useCallback((ratio: number) => {
    const next = clampAuxiliaryWidthRatio(ratio);
    if (widthRatioRef.current === next) return;
    widthRatioRef.current = next;
    setWidthRatioState(next);
    if (prefsRef.current)
      prefsRef.current = { ...prefsRef.current, widthRatio: next };
  }, []);

  const commitWidthRatio = useCallback(() => {
    persistPrefs({ widthRatio: widthRatioRef.current });
  }, [persistPrefs]);

  const setTarget = useCallback((next: AuxiliaryWorkspaceTarget) => {
    setTargetState(next);
  }, []);

  const addSession = useCallback(
    (saved: AuxiliarySession) => {
      if (
        !parentSessionIdRef.current ||
        saved.parentSessionId !== parentSessionIdRef.current
      )
        return;
      mutationRevisionRef.current += 1;
      setLoading(false);
      detailMutationEpochRef.current.set(
        saved.id,
        (detailMutationEpochRef.current.get(saved.id) ?? 0) + 1,
      );
      const nextSummaries = sortByLastUsed(
        [
          ...summariesRef.current.filter((summary) => summary.id !== saved.id),
          projectAuxiliarySessionSummary(saved),
        ],
        recencyRef.current,
      );
      summariesRef.current = nextSummaries;
      setSummaries(nextSummaries);
      selectedIdRef.current = saved.id;
      cacheDetail(saved.id, saved);
      setSelectedId(saved.id);
      setSelectedSession(saved);
      setTargetState("auxiliary");
      persistPrefs({ selectedId: saved.id });
    },
    [cacheDetail, persistPrefs],
  );

  /** 会話ごとに更新口を再利用し、保存中の非表示会話の詳細も操作できるようにする。 */
  const getBinding = useCallback(
    (id: string | null): AuxiliarySessionBinding => {
      if (id === null) {
        const emptyId = "__empty__";
        const existingEmpty = bindingsRef.current.get(emptyId);
        if (existingEmpty) return existingEmpty;
        const emptyBinding: AuxiliarySessionBinding = {
          sessionRef: { current: null },
          mutationRevision: { current: 0 },
          draftSaveQueue: { current: Promise.resolve() },
          sessionSaveQueue: { current: Promise.resolve() },
          /** 未選択なので詳細の変更は適用しない。 */
          setSession() {},
          /** 対象となる履歴がないのでブックマークを変更しない。 */
          setMessageBookmark() {},
          /** 未選択のため操作対象の詳細はない。 */
          getSession() {
            return null;
          },
          /** 未選択のため実行設定を保持しない。 */
          setExecutionSelection() {},
          /** 保護する詳細がないため、解除時にも何もしない。 */
          retainDetail() {
            return () => {};
          },
        };
        bindingsRef.current.set(emptyId, emptyBinding);
        return emptyBinding;
      }
      const existing = bindingsRef.current.get(id);
      if (existing) return existing;
      const bindingGeneration = workspaceGenerationRef.current;
      /** キューに登録した保存が終わるまで、会話の詳細をキャッシュ退避から保護する。 */
      const trackedQueue = () => {
        let current = Promise.resolve();
        return {
          /** 次の保存を連結するために、キューの末尾を返す。 */
          get current() {
            return current;
          },
          /** 新しい末尾を設定して、現行の作業領域に保留中の保存として計上する。 */
          set current(operation: Promise<void>) {
            current = operation;
            if (bindingGeneration !== workspaceGenerationRef.current) return;
            detailQueuesRef.current.set(
              id,
              (detailQueuesRef.current.get(id) ?? 0) + 1,
            );
            /** 保存の成否を問わず保留件数を減らし、詳細を退避できるか再判定する。 */
            const settled = () => {
              if (bindingGeneration !== workspaceGenerationRef.current) return;
              const remaining = (detailQueuesRef.current.get(id) ?? 1) - 1;
              if (remaining > 0) detailQueuesRef.current.set(id, remaining);
              else detailQueuesRef.current.delete(id);
              pruneDetails();
            };
            void operation.then(settled, settled);
          },
        };
      };
      const binding: AuxiliarySessionBinding = {
        sessionRef: { current: detailsRef.current.get(id) ?? null },
        mutationRevision: { current: 0 },
        draftSaveQueue: trackedQueue(),
        sessionSaveQueue: trackedQueue(),
        /** 選択した実行設定を維持しつつ詳細を更新し、この会話の要約だけを差し替える。 */
        setSession(update) {
          if (bindingGeneration !== workspaceGenerationRef.current) return;
          const current = binding.sessionRef.current;
          const candidate =
            typeof update === "function" ? update(current) : update;
          const next = candidate
            ? mergeExecutionSelection(candidate)
            : candidate;
          // 操作結果の適用側は、状態を公開する前に sessionRef を先に更新することがある。
          if (next === (detailsRef.current.get(id) ?? null)) return;
          binding.sessionRef.current = next;
          detailMutationEpochRef.current.set(
            id,
            (detailMutationEpochRef.current.get(id) ?? 0) + 1,
          );
          if (next) {
            dirtyDetailsRef.current.add(id);
            cacheDetail(id, next);
          } else detailsRef.current.delete(id);
          setSelectedSession((selected) =>
            selected?.id === id ? next : selected,
          );
          const nextSummaries = replaceSummary(
            summariesRef.current,
            id,
            next ? projectAuxiliarySessionSummary(next) : null,
            recencyRef.current,
          );
          if (nextSummaries !== summariesRef.current) {
            summariesRef.current = nextSummaries;
            setSummaries(nextSummaries);
          }
        },
        /** 非表示中の操作でも、結び付いた会話の最新詳細を返す。 */
        getSession() {
          return binding.sessionRef.current;
        },
        /** ページ内の添字ではなく履歴全体の位置で対象を特定し、再取得中の詳細にも変更を引き継げるよう版を進める。 */
        setMessageBookmark(messageIndex, isBookmarked) {
          if (bindingGeneration !== workspaceGenerationRef.current) return;
          const current = binding.sessionRef.current;
          if (!current || !Number.isInteger(messageIndex) || messageIndex < 0)
            return;
          const localIndex = current.messages.findIndex(
            (message, index) =>
              (message.historyIndex ?? index) === messageIndex,
          );
          if (localIndex < 0) return;
          const message = current.messages[localIndex];
          if ((message.isBookmarked === true) === isBookmarked) return;
          const messages = current.messages.slice();
          messages[localIndex] = setMessageBookmarked(message, isBookmarked);
          const next = { ...current, messages };
          binding.sessionRef.current = next;
          detailsRef.current.set(id, next);
          bookmarkRevisionRef.current.set(
            id,
            (bookmarkRevisionRef.current.get(id) ?? 0) + 1,
          );
          setSelectedSession((selected) =>
            selected?.id === id && selected.createdAt === current.createdAt
              ? next
              : selected,
          );
        },
        /** この世代の実行設定を優先表示する。設定選択だけで詳細を退避不可にはしない。 */
        setExecutionSelection(session) {
          if (bindingGeneration !== workspaceGenerationRef.current) return;
          const wasDirty = dirtyDetailsRef.current.has(id);
          executionSelectionsRef.current.set(id, {
            createdAt: session.createdAt,
            options: captureSessionExecutionOptions(session),
          });
          binding.setSession(session);
          if (!wasDirty) dirtyDetailsRef.current.delete(id);
          pruneDetails();
        },
        /** この会話の処理を参照数で保護し、最後の解除時にキャッシュ退避を再判定する。 */
        retainDetail() {
          if (bindingGeneration !== workspaceGenerationRef.current)
            return () => {};
          if (!detailOperationsRef.current.has(id))
            operationWasDirtyRef.current.set(
              id,
              dirtyDetailsRef.current.has(id),
            );
          detailOperationsRef.current.set(
            id,
            (detailOperationsRef.current.get(id) ?? 0) + 1,
          );
          let released = false;
          return () => {
            if (
              released ||
              bindingGeneration !== workspaceGenerationRef.current
            )
              return;
            released = true;
            const remaining = (detailOperationsRef.current.get(id) ?? 1) - 1;
            if (remaining > 0) detailOperationsRef.current.set(id, remaining);
            else {
              detailOperationsRef.current.delete(id);
              if (!operationWasDirtyRef.current.get(id))
                dirtyDetailsRef.current.delete(id);
              operationWasDirtyRef.current.delete(id);
            }
            pruneDetails();
          };
        },
      };
      bindingsRef.current.set(id, binding);
      return binding;
    },
    [cacheDetail, mergeExecutionSelection, pruneDetails],
  );

  const unread = useAuxiliarySwitcherUnread(api, parentSessionId, summaries);
  const auxiliaryItems = useMemo(
    () =>
      summaries.map((summary) => ({
        id: summary.id,
        label: summary.preview?.trim() ?? "",
        searchText: summary.preview?.trim() ?? "",
        icon: createElement(CharacterAvatar, {
          character: { name: "", iconPath: summary.characterIconPath ?? "" },
          size: "tiny",
        }),
        isProcessing: summary.runState === "running",
        hasUnreadResult:
          parentSessionId === summary.parentSessionId &&
          unread.has(
            auxiliaryResultKey(
              summary.parentSessionId,
              summary.id,
              summary.createdAt,
            ),
          ),
      })),
    [summaries, unread, parentSessionId],
  );

  const buildConcurrentChats = useCallback(
    (input: AuxiliaryConcurrentChatSurfaceInput): ConcurrentChatWindowProps => {
      const mainSessionId =
        input.mainSession?.id ?? input.messageColumn.sessionId;
      const mainMessages =
        input.mainSession?.messages ?? input.messageColumn.messages;
      const auxiliarySession =
        input.auxiliarySession?.id === selectedId
          ? input.auxiliarySession
          : null;
      const main = {
        ...input.messageColumn,
        inputReadContext: input.mainSession?.incarnationId
          ? {
              ownerSessionId: mainSessionId,
              target: {
                kind: "main" as const,
                sessionId: mainSessionId,
                incarnationId: input.mainSession.incarnationId,
              },
            }
          : undefined,
        sessionId: mainSessionId,
        messages: mainMessages,
        onToggleMessageBookmark: input.onToggleMessageBookmark,
        onLoadArtifactDetail: input.mainOnLoadArtifactDetail,
        onOpenPath: input.mainOnOpenPath,
      };
      const auxiliary = auxiliarySession
        ? {
            ...input.messageColumn,
            inputReadContext:
              input.mainSession?.incarnationId &&
              selectedSession?.id === auxiliarySession.id
                ? {
                    ownerSessionId: mainSessionId,
                    target: {
                      kind: "auxiliary" as const,
                      sessionId: selectedSession.id,
                      incarnationId: selectedSession.createdAt,
                      mainSessionId: selectedSession.parentSessionId,
                      mainIncarnationId: input.mainSession.incarnationId,
                    },
                  }
                : undefined,
            sessionId: auxiliarySession.id,
            messages: auxiliarySession.messages ?? [],
            onToggleMessageBookmark: input.onToggleMessageBookmark,
            onLoadArtifactDetail: input.auxiliaryOnLoadArtifactDetail,
            onOpenPath: input.auxiliaryOnOpenPath,
          }
        : null;

      return {
        main,
        auxiliary,
        mainSession: input.mainSession,
        auxiliarySession,
        api: input.api,
        mainLiveRun: input.mainLiveRun,
        auxiliaryLiveRun: input.auxiliaryLiveRun,
        selectedAuxiliaryId: selectedId,
        auxiliaryItems,
        onAddAuxiliary: input.onAddAuxiliary,
        isAddAuxiliaryDisabled: input.isAddAuxiliaryDisabled,
        target,
        widthRatio,
        scrollToLatestOnSend: input.scrollToLatestOnSend,
        onSelectAuxiliary: selectSession,
        onTargetChange: setTarget,
        onWidthRatioChange: setWidthRatio,
        onWidthRatioCommit: commitWidthRatio,
        loading: loading || detailLoading,
        error: detailError?.message ?? error?.message ?? null,
      };
    },
    [
      auxiliaryItems,
      commitWidthRatio,
      detailError,
      detailLoading,
      error,
      loading,
      selectSession,
      selectedId,
      selectedSession,
      setTarget,
      setWidthRatio,
      target,
      widthRatio,
    ],
  );

  return useMemo(
    () => ({
      summaries,
      selectedId,
      /** 呼び出し時点での選択を返し、レンダー時点の選択との差を照合できるようにする。 */
      getCurrentSelectedId: () => selectedIdRef.current,
      selectedSession:
        selectedSession?.id === selectedId ? selectedSession : null,
      loading,
      error,
      detailLoading,
      detailError,
      target,
      widthRatio,
      setWidthRatio,
      commitWidthRatio,
      selectSession,
      requestSessionSelection,
      setTarget,
      addSession,
      refreshSummaries,
      touchRecency,
      getBinding,
      buildConcurrentChats,
    }),
    [
      addSession,
      buildConcurrentChats,
      commitWidthRatio,
      detailError,
      detailLoading,
      error,
      getBinding,
      loading,
      refreshSummaries,
      requestSessionSelection,
      selectSession,
      selectedId,
      selectedSession,
      setTarget,
      setWidthRatio,
      summaries,
      target,
      touchRecency,
      widthRatio,
    ],
  );
}
