import {
  createMemoryAppendResponse,
  createMemoryErrorResponse,
  createMemoryForgetResponse,
  createMemoryGetEntryResponse,
  createMemoryListCharactersResponse,
  createMemoryListTagsResponse,
  createMemorySearchResponse,
  type MemoryAppendResponse,
  type MemoryErrorResponse,
  type MemoryForgetResponse,
  type MemoryGetEntryResponse,
  type MemoryListCharactersResponse,
  type MemoryListTagsResponse,
  type MemorySearchResponse,
} from "../src/memory-v6/memory-response-contract.js";
import type { CharacterCatalogEntry } from "../src/character/character-catalog.js";
import type { MemoryError } from "../src/memory-v6/memory-contract.js";
import {
  validateMemoryAppendRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryListTagsRequest,
  validateMemorySearchRequest,
} from "../src/memory-v6/memory-validation.js";
import type { MemoryEntryDetail } from "../src/memory-v6/memory-state.js";
import { resolveMemoryV6Target, type MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import { requireMemoryPermission, type MemoryV6Principal } from "./memory-v6-permission.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6IdempotencyConflictError,
  type MemoryV6Storage,
} from "./memory-v6-storage.js";

export type MemoryV6ServiceDeps = MemoryV6TargetResolverDeps & {
  storage: MemoryV6Storage;
  listCharacters?(): readonly CharacterCatalogEntry[];
};

type MemoryV6ServiceResult<T> = T | MemoryErrorResponse;

function entryTarget(entry: MemoryEntryDetail): MemoryV6ResolvedTarget {
  return {
    owner: entry.owner,
    scope: entry.scope,
  };
}

function sameTarget(left: MemoryV6ResolvedTarget, right: MemoryV6ResolvedTarget): boolean {
  return left.owner.type === right.owner.type
    && left.owner.id === right.owner.id
    && left.scope.type === right.scope.type
    && left.scope.id === right.scope.id;
}

function toMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return createMemoryErrorResponse(error);
}

function requirePrincipalPermission(principal: MemoryV6Principal | null, permission: Parameters<typeof requireMemoryPermission>[1]): MemoryErrorResponse | null {
  const permissionError = requireMemoryPermission(principal, permission);
  return permissionError ? toMemoryErrorResponse(permissionError) : null;
}

function bindingIdHashForPrincipal(principal: MemoryV6Principal): string {
  return principal.bindingIdHash;
}

function providerIdForPrincipal(principal: MemoryV6Principal): string | null {
  return principal.providerId;
}

function storageErrorResponse(error: unknown): MemoryErrorResponse {
  if (error instanceof MemoryV6IdempotencyConflictError) {
    return toMemoryErrorResponse({
      code: "MEMORY_IDEMPOTENCY_CONFLICT",
      message: "Memory idempotency key was reused with a different request.",
    });
  }
  if (error instanceof MemoryV6EntryNotFoundError) {
    return toMemoryErrorResponse({
      code: "MEMORY_ENTRY_NOT_FOUND",
      message: "Memory entry was not found.",
    });
  }
  throw error;
}

export class MemoryV6Service {
  constructor(private readonly deps: MemoryV6ServiceDeps) {}

  listCharacters(principal: MemoryV6Principal | null): MemoryV6ServiceResult<MemoryListCharactersResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_characters");
    if (permissionError) {
      return permissionError;
    }
    return createMemoryListCharactersResponse(this.deps.listCharacters?.() ?? []);
  }

  search(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemorySearchResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.search");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemorySearchRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const resolvedTargets: MemoryV6ResolvedTarget[] = [];
    for (const target of validated.value.targets) {
      const resolved = resolveMemoryV6Target(target, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      resolvedTargets.push(resolved.target);
    }

    const result = this.deps.storage.searchEntries({
      targets: resolvedTargets,
      query: validated.value.query,
      kinds: validated.value.kinds,
      tags: validated.value.tags,
      limit: validated.value.limit,
      cursor: validated.value.cursor,
    });
    return createMemorySearchResponse(result.items, {
      nextCursor: result.nextCursor,
      relatedTags: result.relatedTags,
    });
  }

  getEntry(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryGetEntryResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.get_entry");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryGetEntryRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    if (!validated.value.target) {
      return toMemoryErrorResponse({
        code: "MEMORY_TARGET_REQUIRED",
        message: "Explicit memory target is required for get-entry.",
        field: "target",
      });
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }
    const requestedTarget = resolved.target;

    const entry = this.deps.storage.getEntry(validated.value.entryId);
    if (!entry || entry.state !== "active") {
      return createMemoryGetEntryResponse(null);
    }
    const target = entryTarget(entry);
    if (!sameTarget(requestedTarget, target)) {
      return createMemoryGetEntryResponse(null);
    }
    return createMemoryGetEntryResponse(entry);
  }

  listTags(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryListTagsResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.list_tags");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryListTagsRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const resolvedTargets: MemoryV6ResolvedTarget[] = [];
    for (const target of validated.value.targets) {
      const resolved = resolveMemoryV6Target(target, principal, this.deps);
      if (!resolved.ok) {
        return toMemoryErrorResponse(resolved.error);
      }
      resolvedTargets.push(resolved.target);
    }

    return createMemoryListTagsResponse(this.deps.storage.listTags(resolvedTargets));
  }

  append(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryAppendResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.append");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryAppendRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }

    try {
      const result = this.deps.storage.appendEntry({
        target: resolved.target,
        kind: validated.value.kind,
        title: validated.value.title,
        body: validated.value.body,
        preview: validated.value.preview,
        tags: validated.value.tags,
        supersedes: validated.value.supersedes,
        idempotencyKey: validated.value.idempotencyKey,
        bindingIdHash: bindingIdHashForPrincipal(principal),
        source: {
          type: "agent",
          sessionId: null,
          messageId: validated.value.sourceMessageId ?? null,
          providerId: providerIdForPrincipal(principal),
          appMessageId: null,
        },
      });
      return createMemoryAppendResponse(result.entry, result.created);
    } catch (error) {
      return storageErrorResponse(error);
    }
  }

  forget(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryForgetResponse> {
    const permissionError = requirePrincipalPermission(principal, "memory.forget");
    if (permissionError) {
      return permissionError;
    }
    if (!principal) {
      throw new Error("Memory principal permission check failed.");
    }
    const validated = validateMemoryForgetRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }
    const resolved = resolveMemoryV6Target(validated.value.target, principal, this.deps);
    if (!resolved.ok) {
      return toMemoryErrorResponse(resolved.error);
    }

    try {
      const results = this.deps.storage.forgetEntries({
        target: resolved.target,
        entryIds: validated.value.entryIds,
        reason: validated.value.reason,
        idempotencyKey: validated.value.idempotencyKey,
        bindingIdHash: bindingIdHashForPrincipal(principal),
        sessionId: null,
      });
      return createMemoryForgetResponse(results);
    } catch (error) {
      return storageErrorResponse(error);
    }
  }
}
