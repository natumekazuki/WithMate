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
} from "../src/glossary-contract.js";
import {
  areResolvedGlossaryCheckoutsEqual,
  GlossaryApplicationService,
  type ResolvedGlossaryCheckout,
} from "./glossary-application-service.js";

export type GlossaryProjectionSession = {
  id: string;
  provider: string;
  workspacePath: string;
  workspaceLabel: string;
  branch: string;
};

export type GlossarySessionProjectionServiceDeps = {
  applicationService: GlossaryApplicationService;
  getSession: (sessionId: string) => GlossaryProjectionSession | null;
  getBindingGeneration: (sessionId: string, providerId: string) => string | null;
};

type ResolvedProjectionScope = {
  session: GlossaryProjectionSession;
  bindingGeneration: string | null;
  target: ResolvedGlossaryCheckout;
  scopeRevision: string;
  checkout: GlossaryCheckoutSummary;
};

function watchErrorState(error: unknown): GlossaryProjectionState {
  return {
    status: "watch-error",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision: null,
    message: error instanceof Error ? error.message : "Glossary projection failed.",
  };
}

function operationError(error: unknown): GlossaryOperationError {
  return {
    ok: false,
    code: "GLOSSARY_TARGET_INVALID",
    message: error instanceof Error ? error.message : "Glossary checkout is unavailable.",
    effect: "none",
    retryable: false,
  };
}

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

export class GlossarySessionProjectionService {
  readonly #applicationService: GlossaryApplicationService;
  readonly #getSession: GlossarySessionProjectionServiceDeps["getSession"];
  readonly #getBindingGeneration: GlossarySessionProjectionServiceDeps["getBindingGeneration"];
  readonly #sequenceBySession = new Map<string, number>();

  constructor(deps: GlossarySessionProjectionServiceDeps) {
    this.#applicationService = deps.applicationService;
    this.#getSession = deps.getSession;
    this.#getBindingGeneration = deps.getBindingGeneration;
  }

  async load(sessionId: string): Promise<SessionGlossaryProjection> {
    let lastError: unknown = new Error("Glossary projection scope changed during load.");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = this.#getSession(sessionId);
      if (!session || session.id !== sessionId) {
        return this.#unavailableProjection(sessionId, session, new Error("Session is unavailable."));
      }

      try {
        const before = await this.#resolveScope(session);
        const state = await this.#applicationService.read(before.target).catch(watchErrorState);
        const afterSession = this.#getSession(sessionId);
        if (!afterSession || afterSession.id !== sessionId) {
          return this.#unavailableProjection(sessionId, afterSession, new Error("Session is unavailable."));
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
          return this.#project(scope, watchErrorState(error));
        } catch {
          return this.#unavailableProjection(sessionId, current, error);
        }
      }
    }
    return this.#unavailableProjection(sessionId, this.#getSession(sessionId), lastError);
  }

  async search(
    sessionId: string,
    request: GlossarySearchRequest,
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    let lastError: unknown = new Error("Glossary search scope changed during load.");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = this.#getSession(sessionId);
      if (!session || session.id !== sessionId) {
        return operationError(new Error("Session is unavailable."));
      }
      try {
        const before = await this.#resolveScope(session);
        const result = await this.#applicationService.search(before.target, request);
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

  async subscribe(
    sessionId: string,
    listener: (projection: SessionGlossaryProjection) => void,
  ): Promise<() => void> {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let armedScopeRevision: string | null = null;

    const arm = async (): Promise<void> => {
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
      if (disposed) {
        return;
      }
      armedScopeRevision = scope.scopeRevision;
      unsubscribe = this.#applicationService.subscribe(scope.target, (state) => {
        void (async () => {
          const currentSession = this.#getSession(sessionId);
          if (!currentSession || disposed) {
            return;
          }
          try {
            const currentScope = await this.#resolveScope(currentSession);
            if (currentScope.scopeRevision !== armedScopeRevision || !this.#sameScope(scope, currentScope)) {
              await arm();
              if (!disposed) {
                listener(await this.load(sessionId));
              }
              return;
            }
            listener(this.#project(currentScope, state));
          } catch (error) {
            if (!disposed) {
              listener(this.#unavailableProjection(sessionId, currentSession, error));
            }
          }
        })();
      });
    };

    await arm();
    return () => {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    };
  }

  async #resolveScope(session: GlossaryProjectionSession): Promise<ResolvedProjectionScope> {
    const bindingGeneration = this.#getBindingGeneration(session.id, session.provider);
    const target = await this.#applicationService.resolvePrimaryCheckout(session.workspacePath);
    const checkout = await this.#applicationService.describeCheckout(target);
    return {
      session,
      bindingGeneration,
      target,
      scopeRevision: scopeRevision(session, bindingGeneration, target),
      checkout,
    };
  }

  #sameScope(left: ResolvedProjectionScope, right: ResolvedProjectionScope): boolean {
    return left.scopeRevision === right.scopeRevision
      && left.session.id === right.session.id
      && left.session.provider === right.session.provider
      && left.bindingGeneration === right.bindingGeneration
      && areResolvedGlossaryCheckoutsEqual(left.target, right.target);
  }

  #project(scope: ResolvedProjectionScope, state: GlossaryProjectionState): SessionGlossaryProjection {
    return {
      sessionId: scope.session.id,
      scopeRevision: scope.scopeRevision,
      sequence: this.#nextSequence(scope.session.id),
      checkout: scope.checkout,
      state,
    };
  }

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
      state: watchErrorState(error),
    };
  }

  #nextSequence(sessionId: string): number {
    const next = (this.#sequenceBySession.get(sessionId) ?? 0) + 1;
    this.#sequenceBySession.set(sessionId, next);
    return next;
  }
}
