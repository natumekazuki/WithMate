import { createHash } from "node:crypto";

import {
  GLOSSARY_RELATIVE_PATH,
  type GlossaryCheckoutSummary,
  type GlossaryListResult,
  type GlossaryOperationError,
  type GlossaryOperationResult,
  type GlossaryProjectionState,
  type GlossarySearchRequest,
  type SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import {
  areResolvedGlossaryCheckoutsEqual,
  GlossaryApplicationService,
  isGlossaryNotApplicableError,
  type ResolvedGlossaryCheckout,
} from "./glossary-application-service.js";

/** 用語集表示の対象を解決するためのセッション情報と、解決できない場合の表示ラベル。 */
export type GlossaryProjectionSession = {
  id: string;
  provider: string;
  workspacePath: string;
  workspaceLabel: string;
  branch: string;
};

/** セッションの参照、バインディング世代の追跡、チェックアウトの用語集読み取りに使う依存処理。 */
export type GlossarySessionProjectionServiceDeps = {
  applicationService: GlossaryApplicationService;
  getSession: (sessionId: string) => GlossaryProjectionSession | null;
  getBindingGeneration: (
    sessionId: string,
    providerId: string,
  ) => string | null;
  subscribeBindingChanges: (
    listener: (change: { sessionId: string; providerId: string }) => void,
  ) => () => void;
};

/** 表示対象を特定したセッション、実行世代、チェックアウト実体、および表示用の要約。 */
type ResolvedProjectionScope = {
  session: GlossaryProjectionSession;
  bindingGeneration: string | null;
  target: ResolvedGlossaryCheckout;
  scopeRevision: string;
  checkout: GlossaryCheckoutSummary;
};

/** 用語集の読み取りや監視ができない理由を表示状態に変換する。 */
function watchErrorState(error: unknown): GlossaryProjectionState {
  return {
    status: "watch-error",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision: null,
    message:
      error instanceof Error ? error.message : "Glossary projection failed.",
  };
}

/** Git チェックアウトに適用できない場合の状態を返す。 */
function notApplicableState(): GlossaryProjectionState {
  return {
    status: "not-applicable",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision: null,
    reason: "not-git",
  };
}

/** Git 管理外を対象外として扱い、それ以外の失敗を監視エラーへ変換する。 */
function stateForError(error: unknown): GlossaryProjectionState {
  return isGlossaryNotApplicableError(error)
    ? notApplicableState()
    : watchErrorState(error);
}

/** 検索対象の解決に失敗した理由を、副作用なし・再試行不可の操作エラーに変換する。 */
function operationError(error: unknown): GlossaryOperationError {
  return {
    ok: false,
    code: "GLOSSARY_TARGET_INVALID",
    message:
      error instanceof Error
        ? error.message
        : "Glossary checkout is unavailable.",
    effect: "none",
    retryable: false,
  };
}

/** セッション、バインディング世代、ワークスペース、取得できたチェックアウト実体から描画対象を識別する値を作る。 */
function scopeRevision(
  session: GlossaryProjectionSession,
  bindingGeneration: string | null,
  target: ResolvedGlossaryCheckout | null,
): string {
  const hash = createHash("sha256")
    .update(session.id, "utf8")
    .update("\0", "utf8")
    .update(session.provider, "utf8")
    .update("\0", "utf8")
    .update(bindingGeneration ?? "unbound", "utf8")
    .update("\0", "utf8")
    .update(session.workspacePath, "utf8");
  if (target) {
    hash
      .update("\0", "utf8")
      .update(target.rootRealPath, "utf8")
      .update("\0", "utf8")
      .update(target.rootIdentity.device.toString(), "utf8")
      .update("\0", "utf8")
      .update(target.rootIdentity.inode.toString(), "utf8");
  }
  return hash.digest("base64url");
}

/** セッションの現在のチェックアウトを表示・検索対象とし、監視中に古い対象の結果を配信しないようにする。 */
export class GlossarySessionProjectionService {
  readonly #applicationService: GlossaryApplicationService;
  readonly #getSession: GlossarySessionProjectionServiceDeps["getSession"];
  readonly #getBindingGeneration: GlossarySessionProjectionServiceDeps["getBindingGeneration"];
  readonly #subscribeBindingChanges: GlossarySessionProjectionServiceDeps["subscribeBindingChanges"];
  readonly #sequenceBySession = new Map<string, number>();

  /** セッションとバインディングの変化を観測する依存処理および用語集サービスを受け取る。 */
  constructor(deps: GlossarySessionProjectionServiceDeps) {
    this.#applicationService = deps.applicationService;
    this.#getSession = deps.getSession;
    this.#getBindingGeneration = deps.getBindingGeneration;
    this.#subscribeBindingChanges = deps.subscribeBindingChanges;
  }

  /** 表示状態を読み取り、前後で参照範囲が一致した結果を返す。変化が続く場合は利用できない状態を返す。 */
  async load(sessionId: string): Promise<SessionGlossaryProjection> {
    let lastError: unknown = new Error(
      "Glossary projection scope changed during load.",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = this.#getSession(sessionId);
      if (!session || session.id !== sessionId) {
        return this.#unavailableProjection(
          sessionId,
          session,
          new Error("Session is unavailable."),
        );
      }

      try {
        const before = await this.#resolveScope(session);
        const state = await this.#applicationService
          .read(before.target)
          .catch(stateForError);
        const afterSession = this.#getSession(sessionId);
        if (!afterSession || afterSession.id !== sessionId) {
          return this.#unavailableProjection(
            sessionId,
            afterSession,
            new Error("Session is unavailable."),
          );
        }
        const after = await this.#resolveScope(afterSession);
        if (this.#sameScope(before, after)) {
          return this.#project(before, state);
        }
        lastError = new Error("Glossary projection scope changed during load.");
      } catch (error) {
        lastError = error;
        const current = this.#getSession(sessionId);
        if (!current || current.id !== sessionId) {
          return this.#unavailableProjection(sessionId, current, error);
        }
        try {
          const scope = await this.#resolveScope(current);
          return this.#project(scope, stateForError(error));
        } catch {
          return this.#unavailableProjection(sessionId, current, error);
        }
      }
    }
    return this.#unavailableProjection(
      sessionId,
      this.#getSession(sessionId),
      lastError,
    );
  }

  /** セッションの用語集を検索し、検索中に参照範囲が変わった結果は採用せず、試行の上限でエラーを返す。 */
  async search(
    sessionId: string,
    request: GlossarySearchRequest,
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    let lastError: unknown = new Error(
      "Glossary search scope changed during load.",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = this.#getSession(sessionId);
      if (!session || session.id !== sessionId) {
        return operationError(new Error("Session is unavailable."));
      }
      try {
        const before = await this.#resolveScope(session);
        const result = await this.#applicationService.search(
          before.target,
          request,
        );
        const afterSession = this.#getSession(sessionId);
        if (!afterSession || afterSession.id !== sessionId) {
          return operationError(new Error("Session is unavailable."));
        }
        const after = await this.#resolveScope(afterSession);
        if (this.#sameScope(before, after)) {
          return result;
        }
        lastError = new Error("Glossary search scope changed during load.");
      } catch (error) {
        lastError = error;
      }
    }
    return operationError(lastError);
  }

  /** チェックアウトとバインディングの変化を監視し、現在のセッションに対応する表示内容を配信する。戻り値で監視を解除できる。 */
  async subscribe(
    sessionId: string,
    listener: (projection: SessionGlossaryProjection) => void,
  ): Promise<() => void> {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let armedScopeRevision: string | null = null;
    let armGeneration = 0;
    let deliveryGeneration = 0;

    /** 既存の監視を解除し、現在の参照範囲を解決できた場合だけ監視を張り直す。 */
    const arm = async (): Promise<void> => {
      const currentArmGeneration = ++armGeneration;
      unsubscribe?.();
      unsubscribe = null;
      const session = this.#getSession(sessionId);
      if (!session || disposed) {
        return;
      }
      let scope: ResolvedProjectionScope;
      try {
        scope = await this.#resolveScope(session);
      } catch {
        return;
      }
      if (disposed || currentArmGeneration !== armGeneration) {
        return;
      }
      armedScopeRevision = scope.scopeRevision;
      const nextUnsubscribe = this.#applicationService.subscribe(
        scope.target,
        (state) => {
          const currentDeliveryGeneration = ++deliveryGeneration;
          void (async () => {
            const currentSession = this.#getSession(sessionId);
            if (!currentSession || disposed) {
              return;
            }
            try {
              const currentScope = await this.#resolveScope(currentSession);
              if (
                disposed ||
                currentDeliveryGeneration !== deliveryGeneration
              ) {
                return;
              }
              if (
                currentScope.scopeRevision !== armedScopeRevision ||
                !this.#sameScope(scope, currentScope)
              ) {
                await arm();
                if (
                  disposed ||
                  currentDeliveryGeneration !== deliveryGeneration
                ) {
                  return;
                }
                const projection = await this.load(sessionId);
                if (
                  !disposed &&
                  currentDeliveryGeneration === deliveryGeneration
                ) {
                  listener(projection);
                }
                return;
              }
              listener(this.#project(currentScope, state));
            } catch (error) {
              if (
                !disposed &&
                currentDeliveryGeneration === deliveryGeneration
              ) {
                listener(
                  this.#unavailableProjection(sessionId, currentSession, error),
                );
              }
            }
          })();
        },
      );
      if (disposed || currentArmGeneration !== armGeneration) {
        nextUnsubscribe();
        return;
      }
      unsubscribe = nextUnsubscribe;
    };

    const unsubscribeBindingChanges = this.#subscribeBindingChanges(
      (change) => {
        const session = this.#getSession(sessionId);
        if (
          disposed ||
          !session ||
          change.sessionId !== session.id ||
          change.providerId !== session.provider
        ) {
          return;
        }
        const currentDeliveryGeneration = ++deliveryGeneration;
        void (async () => {
          try {
            await arm();
            if (disposed || currentDeliveryGeneration !== deliveryGeneration) {
              return;
            }
            const projection = await this.load(sessionId);
            if (!disposed && currentDeliveryGeneration === deliveryGeneration) {
              listener(projection);
            }
          } catch (error) {
            const currentSession = this.#getSession(sessionId);
            if (
              !disposed &&
              currentSession &&
              currentDeliveryGeneration === deliveryGeneration
            ) {
              listener(
                this.#unavailableProjection(sessionId, currentSession, error),
              );
            }
          }
        })();
      },
    );

    await arm();
    return () => {
      disposed = true;
      armGeneration += 1;
      deliveryGeneration += 1;
      unsubscribeBindingChanges();
      unsubscribe?.();
      unsubscribe = null;
    };
  }

  /** 現在のバインディング世代に対応するチェックアウトと、その表示に必要な情報を解決する。 */
  async #resolveScope(
    session: GlossaryProjectionSession,
  ): Promise<ResolvedProjectionScope> {
    const bindingGeneration = this.#getBindingGeneration(
      session.id,
      session.provider,
    );
    const target = await this.#applicationService.resolvePrimaryCheckout(
      session.workspacePath,
    );
    const checkout = await this.#applicationService.describeCheckout(target);
    return {
      session,
      bindingGeneration,
      target,
      scopeRevision: scopeRevision(session, bindingGeneration, target),
      checkout,
    };
  }

  /** 読み取り前後のセッション、バインディング世代、チェックアウト実体が同じ参照範囲か確認する。 */
  #sameScope(
    left: ResolvedProjectionScope,
    right: ResolvedProjectionScope,
  ): boolean {
    return (
      left.scopeRevision === right.scopeRevision &&
      left.session.id === right.session.id &&
      left.session.provider === right.session.provider &&
      left.bindingGeneration === right.bindingGeneration &&
      areResolvedGlossaryCheckoutsEqual(left.target, right.target)
    );
  }

  /** 設定された参照範囲の要約・状態に、セッションごとの連番を付けて表示用データにする。 */
  #project(
    scope: ResolvedProjectionScope,
    state: GlossaryProjectionState,
  ): SessionGlossaryProjection {
    return {
      sessionId: scope.session.id,
      scopeRevision: scope.scopeRevision,
      sequence: this.#nextSequence(scope.session.id),
      checkout: scope.checkout,
      state,
    };
  }

  /** 参照範囲を解決できないときは、代替のラベルと原因に応じた状態を表示用データとして返す。 */
  #unavailableProjection(
    sessionId: string,
    session: GlossaryProjectionSession | null,
    error: unknown,
  ): SessionGlossaryProjection {
    const fallbackSession: GlossaryProjectionSession = session ?? {
      id: sessionId,
      provider: "",
      workspacePath: "",
      workspaceLabel: "Repository",
      branch: "",
    };
    const label = fallbackSession.workspaceLabel.trim() || "Repository";
    return {
      sessionId,
      scopeRevision: scopeRevision(
        fallbackSession,
        this.#getBindingGeneration(sessionId, fallbackSession.provider),
        null,
      ),
      sequence: this.#nextSequence(sessionId),
      checkout: {
        repositoryName: label,
        branch: fallbackSession.branch.trim() || "unavailable",
        pathLabel: label,
      },
      state: stateForError(error),
    };
  }

  /** セッションごとに配信順を比較できるよう、前回より1大きい連番を返す。 */
  #nextSequence(sessionId: string): number {
    const next = (this.#sequenceBySession.get(sessionId) ?? 0) + 1;
    this.#sequenceBySession.set(sessionId, next);
    return next;
  }
}
