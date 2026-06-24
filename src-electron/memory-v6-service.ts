import {
  createMemoryAppendResponse,
  createMemoryErrorResponse,
  createMemoryForgetResponse,
  createMemoryGetEntryResponse,
  createMemoryListTagsResponse,
  createMemoryResolveContextResponse,
  createMemorySearchResponse,
  type MemoryAppendResponse,
  type MemoryForgetResult,
  type MemoryErrorResponse,
  type MemoryForgetResponse,
  type MemoryGetEntryResponse,
  type MemoryListTagsResponse,
  type MemoryResolveContextResponse,
  type MemorySearchResponse,
} from "../src/memory-v6/memory-response-contract.js";
import type { MemoryError } from "../src/memory-v6/memory-contract.js";
import {
  validateMemoryAppendRequest,
  validateMemoryForgetRequest,
  validateMemoryGetEntryRequest,
  validateMemoryListTagsRequest,
  validateMemorySearchRequest,
} from "../src/memory-v6/memory-validation.js";
import type { MemoryEntryDetail } from "../src/memory-v6/memory-state.js";
import { resolveMemoryV6Target, targetMatchesPrincipal, type MemoryV6TargetResolverDeps } from "./memory-v6-context-resolver.js";
import { targetKey, type MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import {
  requireMemoryPermission,
  type MemoryV6Principal,
} from "./memory-v6-permission.js";
import {
  MemoryV6EntryNotFoundError,
  MemoryV6IdempotencyConflictError,
  type MemoryV6Storage,
} from "./memory-v6-storage.js";

export type MemoryV6ServiceDeps = MemoryV6TargetResolverDeps & {
  storage: MemoryV6Storage;
};

type MemoryV6ServiceResult<T> = T | MemoryErrorResponse;

function entryTarget(entry: MemoryEntryDetail): MemoryV6ResolvedTarget {
  return {
    owner: entry.owner,
    scope: entry.scope,
  };
}

function toMemoryErrorResponse(error: MemoryError): MemoryErrorResponse {
  return createMemoryErrorResponse(error);
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

  resolveContext(principal: MemoryV6Principal | null): MemoryV6ServiceResult<MemoryResolveContextResponse> {
    const permissionError = requireMemoryPermission(principal, "memory.resolve_context");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
    }

    return createMemoryResolveContextResponse({
      session: { id: principal.sessionId },
      character: principal.character,
      sessionProject: principal.sessionProject,
      permissions: [...principal.permissions],
    });
  }

  search(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemorySearchResponse> {
    const permissionError = requireMemoryPermission(principal, "memory.search");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
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
    return createMemorySearchResponse(result.items, result.nextCursor);
  }

  getEntry(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryGetEntryResponse> {
    const permissionError = requireMemoryPermission(principal, "memory.get_entry");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
    }
    const validated = validateMemoryGetEntryRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const entry = this.deps.storage.getEntry(validated.value.entryId);
    if (!entry || entry.state !== "active" || !targetMatchesPrincipal(principal, entryTarget(entry))) {
      return createMemoryGetEntryResponse(null);
    }
    return createMemoryGetEntryResponse(entry);
  }

  listTags(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryListTagsResponse> {
    const permissionError = requireMemoryPermission(principal, "memory.list_tags");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
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
    const permissionError = requireMemoryPermission(principal, "memory.append");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
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
        bindingIdHash: principal.bindingIdHash,
        source: {
          type: "agent",
          sessionId: principal.sessionId,
          messageId: validated.value.sourceMessageId ?? null,
          providerId: principal.providerId,
          appMessageId: null,
        },
      });
      return createMemoryAppendResponse(result.entry, result.created);
    } catch (error) {
      return storageErrorResponse(error);
    }
  }

  forget(principal: MemoryV6Principal | null, request: unknown): MemoryV6ServiceResult<MemoryForgetResponse> {
    const permissionError = requireMemoryPermission(principal, "memory.forget");
    if (permissionError || !principal) {
      return toMemoryErrorResponse(permissionError ?? {
        code: "MEMORY_BINDING_REQUIRED",
        message: "WithMate runtime binding is required.",
      });
    }
    const validated = validateMemoryForgetRequest(request);
    if (!validated.ok) {
      return toMemoryErrorResponse(validated.error);
    }

    const targetResults = new Map<string, { target: MemoryV6ResolvedTarget; items: Array<{ entryId: string; index: number }> }>();
    const results: Array<MemoryForgetResult | null> = validated.value.entryIds.map((entryId, index) => {
      const entry = this.deps.storage.getEntry(entryId);
      if (!entry || !targetMatchesPrincipal(principal, entryTarget(entry))) {
        return { entryId, status: "not_found" };
      }
      const target = entryTarget(entry);
      const key = targetKey(target);
      const existing = targetResults.get(key);
      if (existing) {
        existing.items.push({ entryId, index });
      } else {
        targetResults.set(key, { target, items: [{ entryId, index }] });
      }
      return null;
    });

    try {
      for (const group of targetResults.values()) {
        const groupResults = this.deps.storage.forgetEntries({
          target: group.target,
          entryIds: group.items.map((item) => item.entryId),
          reason: validated.value.reason,
          idempotencyKey: validated.value.idempotencyKey,
          bindingIdHash: principal.bindingIdHash,
          sessionId: principal.sessionId,
        });
        for (const groupResult of groupResults) {
          const item = group.items.find((candidate) => candidate.entryId === groupResult.entryId);
          if (item) {
            results[item.index] = groupResult;
          }
        }
      }
    } catch (error) {
      return storageErrorResponse(error);
    }

    return createMemoryForgetResponse(results.map((result, index) => result ?? {
      entryId: validated.value.entryIds[index],
      status: "not_found" as const,
    }));
  }
}
