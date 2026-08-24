import { createHash } from "node:crypto";

import {
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
  type GlossaryCheckoutSelector,
  type GlossaryCheckoutTarget,
  type GlossaryOperationError,
  type GlossaryRuntimeEnvelope,
} from "../src/glossary-contract.js";
import {
  glossaryAgentRuntimeOperation,
  glossaryCheckoutSelectorSchema,
  glossaryOperationRequestSchemas,
  glossaryRuntimeOperationByPath,
  type GlossaryRuntimeOperation,
} from "../src/glossary-operation-schema.js";
import type {
  ProviderAgentRuntimeBindingProjection,
  ResolvedAgentRuntimeBinding,
} from "./agent-runtime-binding.js";
import {
  areResolvedGlossaryCheckoutsEqual,
  GlossaryApplicationService,
  restoreGlossaryCheckoutAuthority,
  type GlossaryCheckoutAuthoritySnapshot,
  type ResolvedGlossaryCheckout,
} from "./glossary-application-service.js";
import type {
  AgentRuntimeActorSession,
  AgentRuntimeExtensionRequest,
  AgentRuntimeExtensionResponse,
} from "./memory-v6-http-server.js";
import {
  GlossaryProactiveTurnCoordinator,
  type GlossaryProactiveTurnHandle,
} from "./glossary-proactive-turn.js";

type BindingRegistry = {
  resolve(
    bindingReference: string | null | undefined,
    operation: string,
  ):
    | { ok: true; binding: ResolvedAgentRuntimeBinding }
    | {
        ok: false;
        code: "SESSION_BINDING_REQUIRED" | "SESSION_BINDING_INVALID" | "SESSION_BINDING_FORBIDDEN";
      };
};

export type GlossaryRuntimeServiceDeps = {
  applicationService: GlossaryApplicationService;
  bindingRegistry: BindingRegistry;
  resolveActorSession: (
    sessionId: string,
  ) => Promise<AgentRuntimeActorSession | null> | AgentRuntimeActorSession | null;
  getProactiveCreateLimit: () => number | null | undefined;
};

type AuthorizedCheckout = {
  binding: ResolvedAgentRuntimeBinding;
  target: ResolvedGlossaryCheckout;
  checkoutId: string;
};

function runtimeEnvelope<T extends object>(value: T): GlossaryRuntimeEnvelope<T> {
  return { schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION, ...value };
}

function runtimeError(
  code: GlossaryOperationError["code"],
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
  retryable = false,
): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return runtimeEnvelope({ ok: false, code, message, effect, retryable });
}

function statusForResult(result: GlossaryRuntimeEnvelope<object>): number {
  if (!("ok" in result) || result.ok !== false || !("code" in result)) {
    return 200;
  }
  switch (result.code) {
    case "GLOSSARY_INVALID_REQUEST":
    case "GLOSSARY_LIMIT_EXCEEDED":
      return 400;
    case "GLOSSARY_SESSION_BINDING_REQUIRED":
    case "GLOSSARY_SESSION_BINDING_INVALID":
      return 401;
    case "GLOSSARY_SESSION_BINDING_FORBIDDEN":
      return 403;
    case "GLOSSARY_NOT_FOUND":
    case "GLOSSARY_CHECKOUT_NOT_FOUND":
      return 404;
    case "GLOSSARY_CONFLICT":
    case "GLOSSARY_TARGET_CHANGED":
      return 409;
    case "GLOSSARY_INVALID_FILE":
    case "GLOSSARY_UNSUPPORTED_SCHEMA":
    case "GLOSSARY_TARGET_INVALID":
      return 422;
    default:
      return 500;
  }
}

function isCheckoutAuthoritySnapshot(value: unknown): value is GlossaryCheckoutAuthoritySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return [
    "rootPath",
    "rootRealPath",
    "rootDevice",
    "rootInode",
    "gitMarkerDevice",
    "gitMarkerInode",
  ].every((key) => typeof candidate[key] === "string" && candidate[key] !== "");
}

function createCheckoutId(binding: ResolvedAgentRuntimeBinding, target: ResolvedGlossaryCheckout): string {
  return createHash("sha256")
    .update(binding.bindingIdHash, "utf8")
    .update("\0", "utf8")
    .update(binding.executionGeneration, "utf8")
    .update("\0", "utf8")
    .update(target.rootRealPath, "utf8")
    .update("\0", "utf8")
    .update(target.rootIdentity.device.toString(), "utf8")
    .update("\0", "utf8")
    .update(target.rootIdentity.inode.toString(), "utf8")
    .digest("base64url");
}

function bindingErrorCode(
  code: "SESSION_BINDING_REQUIRED" | "SESSION_BINDING_INVALID" | "SESSION_BINDING_FORBIDDEN",
): GlossaryOperationError["code"] {
  switch (code) {
    case "SESSION_BINDING_REQUIRED":
      return "GLOSSARY_SESSION_BINDING_REQUIRED";
    case "SESSION_BINDING_INVALID":
      return "GLOSSARY_SESSION_BINDING_INVALID";
    case "SESSION_BINDING_FORBIDDEN":
      return "GLOSSARY_SESSION_BINDING_FORBIDDEN";
  }
}

function operationLabel(operation: GlossaryRuntimeOperation): string {
  return operation.replaceAll("_", "-");
}

export class GlossaryRuntimeService {
  readonly #applicationService: GlossaryApplicationService;
  readonly #bindingRegistry: BindingRegistry;
  readonly #resolveActorSession: GlossaryRuntimeServiceDeps["resolveActorSession"];
  readonly #getProactiveCreateLimit: GlossaryRuntimeServiceDeps["getProactiveCreateLimit"];
  readonly #proactiveTurns = new GlossaryProactiveTurnCoordinator();

  constructor(deps: GlossaryRuntimeServiceDeps) {
    this.#applicationService = deps.applicationService;
    this.#bindingRegistry = deps.bindingRegistry;
    this.#resolveActorSession = deps.resolveActorSession;
    this.#getProactiveCreateLimit = deps.getProactiveCreateLimit;
  }

  beginProviderTurn(
    actorSessionId: string,
    binding: ProviderAgentRuntimeBindingProjection,
  ): {
    handle: GlossaryProactiveTurnHandle;
    binding: ProviderAgentRuntimeBindingProjection;
  } {
    const handle = this.#proactiveTurns.begin({
      actorSessionId,
      providerId: binding.providerId,
      proactiveCreateLimit: this.#getProactiveCreateLimit(),
    });
    return {
      handle,
      binding: { ...binding, turnCapability: handle.capability },
    };
  }

  endProviderTurn(handle: GlossaryProactiveTurnHandle): void {
    this.#proactiveTurns.end(handle);
  }

  async route(request: AgentRuntimeExtensionRequest): Promise<AgentRuntimeExtensionResponse | null> {
    const operationUrl = new URL(request.path, "http://127.0.0.1");
    const operation = glossaryRuntimeOperationByPath.get(operationUrl.pathname);
    if (!operation) {
      return null;
    }
    if (request.method !== "POST") {
      return this.#respond(runtimeError(
        "GLOSSARY_INVALID_REQUEST",
        `Glossary ${operationLabel(operation)} requires POST.`,
      ), 405);
    }

    const schema = glossaryOperationRequestSchemas[operation];
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return this.#respond(runtimeError(
        "GLOSSARY_INVALID_REQUEST",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "),
      ));
    }

    const selector: GlossaryCheckoutSelector = operation === "list_targets"
      ? { kind: "primary" }
      : glossaryCheckoutSelectorSchema.parse((parsed.data as { selector?: unknown }).selector);
    const authorization = await this.#authorize(request.bindingReference, operation, selector);
    if ("error" in authorization) {
      return this.#respond(authorization.error);
    }
    const { binding, target, checkoutId } = authorization;
    const guard = async (): Promise<ResolvedGlossaryCheckout | null> => {
      const current = await this.#authorize(request.bindingReference, operation, selector);
      if (
        "error" in current
        || current.binding.bindingId !== binding.bindingId
        || current.binding.executionGeneration !== binding.executionGeneration
      ) {
        return null;
      }
      return current.target;
    };

    switch (operation) {
      case "list_targets": {
        const display = await this.#applicationService.describeCheckout(target);
        const checkoutTarget: GlossaryCheckoutTarget = {
          checkoutId,
          selector: { kind: "checkout", checkoutId },
          isPrimary: true,
          ...display,
        };
        return this.#respond(runtimeEnvelope({ ok: true, targets: [checkoutTarget] }));
      }
      case "list": {
        const input = glossaryOperationRequestSchemas.list.parse(request.body);
        return this.#respond(runtimeEnvelope(await this.#applicationService.list(target, input)));
      }
      case "search": {
        const input = glossaryOperationRequestSchemas.search.parse(request.body);
        return this.#respond(runtimeEnvelope(await this.#applicationService.search(target, input)));
      }
      case "get": {
        const input = glossaryOperationRequestSchemas.get.parse(request.body);
        return this.#respond(runtimeEnvelope(await this.#applicationService.get(target, input.termOrAlias)));
      }
      case "create": {
        const input = glossaryOperationRequestSchemas.create.parse(request.body);
        const proactiveAdmission = input.mode === "proactive"
          ? this.#admitProactiveCreate(binding, request.turnCapability, "create", input.entry, 1)
          : null;
        if (proactiveAdmission && !proactiveAdmission.ok) {
          return this.#respond(proactiveAdmission.error);
        }
        return this.#respond(runtimeEnvelope(await this.#applicationService.create(target, {
          mode: input.mode,
          entry: input.entry,
          proactiveCreateLimit: proactiveAdmission?.proactiveCreateLimit,
        }, guard)));
      }
      case "create_batch": {
        const input = glossaryOperationRequestSchemas.create_batch.parse(request.body);
        const proactiveAdmission = input.mode === "proactive"
          ? this.#admitProactiveCreate(binding, request.turnCapability, "create_batch", input.entries, input.entries.length)
          : null;
        if (proactiveAdmission && !proactiveAdmission.ok) {
          return this.#respond(proactiveAdmission.error);
        }
        return this.#respond(runtimeEnvelope(await this.#applicationService.createBatch(target, {
          mode: input.mode,
          entries: input.entries,
          proactiveCreateLimit: proactiveAdmission?.proactiveCreateLimit,
        }, guard)));
      }
      case "update": {
        const input = glossaryOperationRequestSchemas.update.parse(request.body);
        return this.#respond(runtimeEnvelope(await this.#applicationService.update(target, {
          expectedRevision: input.expectedRevision,
          targetTerm: input.targetTerm,
          entry: input.entry,
        }, guard)));
      }
      case "delete": {
        const input = glossaryOperationRequestSchemas.delete.parse(request.body);
        return this.#respond(runtimeEnvelope(await this.#applicationService.delete(target, {
          expectedRevision: input.expectedRevision,
          targetTerm: input.targetTerm,
        }, guard)));
      }
      case "validate":
        return this.#respond(runtimeEnvelope(await this.#applicationService.validate(target)));
    }
  }

  #admitProactiveCreate(
    binding: ResolvedAgentRuntimeBinding,
    turnCapability: string | null | undefined,
    operation: "create" | "create_batch",
    entries: unknown,
    entryCount: number,
  ):
    | { ok: true; proactiveCreateLimit: number }
    | { ok: false; error: GlossaryRuntimeEnvelope<GlossaryOperationError> } {
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify([operation, entries]), "utf8")
      .digest("hex");
    const admission = this.#proactiveTurns.admit({
      actorSessionId: binding.actorSessionId,
      providerId: binding.providerId,
      turnCapability,
      requestFingerprint,
      entryCount,
    });
    if (admission.ok) {
      return { ok: true, proactiveCreateLimit: admission.proactiveCreateLimit };
    }
    if (admission.reason === "invalid-limit") {
      return { ok: false, error: runtimeError("GLOSSARY_INVALID_REQUEST", "A valid proactive create limit is required.") };
    }
    if (admission.reason === "inactive") {
      return { ok: false, error: runtimeError(
        "GLOSSARY_SESSION_BINDING_INVALID",
        "Proactive create requires the active provider Session turn.",
      ) };
    }
    return { ok: false, error: runtimeError(
      "GLOSSARY_LIMIT_EXCEEDED",
      admission.reason === "second-request"
        ? "Only one proactive create request is allowed per provider Session turn."
        : "Proactive create exceeds the current provider Session turn limit.",
    ) };
  }

  async #authorize(
    bindingReference: string | undefined,
    operation: GlossaryRuntimeOperation,
    selector: GlossaryCheckoutSelector,
  ): Promise<AuthorizedCheckout | { error: GlossaryRuntimeEnvelope<GlossaryOperationError> }> {
    const resolved = this.#bindingRegistry.resolve(
      bindingReference,
      glossaryAgentRuntimeOperation(operation),
    );
    if (!resolved.ok) {
      return {
        error: runtimeError(
          bindingErrorCode(resolved.code),
          "Glossary operation requires the active provider Session runtime binding.",
        ),
      };
    }
    const actorSession = await this.#resolveActorSession(resolved.binding.actorSessionId);
    if (
      !actorSession
      || actorSession.id !== resolved.binding.actorSessionId
      || actorSession.providerId !== resolved.binding.providerId
      || !actorSession.workspacePath
    ) {
      return { error: runtimeError("GLOSSARY_SESSION_BINDING_INVALID", "Actor Session binding is no longer valid.") };
    }
    const snapshot = resolved.binding.authoritySnapshot.glossaryPrimaryCheckout;
    if (!isCheckoutAuthoritySnapshot(snapshot)) {
      return { error: runtimeError("GLOSSARY_SESSION_BINDING_FORBIDDEN", "Binding does not authorize a glossary checkout.") };
    }

    let authorizedTarget: ResolvedGlossaryCheckout;
    let currentTarget: ResolvedGlossaryCheckout;
    try {
      authorizedTarget = restoreGlossaryCheckoutAuthority(snapshot);
      currentTarget = await this.#applicationService.resolvePrimaryCheckout(actorSession.workspacePath);
    } catch {
      return { error: runtimeError("GLOSSARY_SESSION_BINDING_INVALID", "Primary checkout identity can no longer be verified.") };
    }
    if (!areResolvedGlossaryCheckoutsEqual(authorizedTarget, currentTarget)) {
      return { error: runtimeError("GLOSSARY_SESSION_BINDING_INVALID", "Primary checkout no longer matches the runtime binding.") };
    }
    const checkoutId = createCheckoutId(resolved.binding, currentTarget);
    if (selector.kind === "checkout" && selector.checkoutId !== checkoutId) {
      return { error: runtimeError("GLOSSARY_CHECKOUT_NOT_FOUND", "checkoutId is not authorized by this runtime binding.") };
    }
    return { binding: resolved.binding, target: currentTarget, checkoutId };
  }

  #respond(
    value: GlossaryRuntimeEnvelope<object>,
    forcedStatus?: number,
  ): AgentRuntimeExtensionResponse {
    return { status: forcedStatus ?? statusForResult(value), value };
  }
}
