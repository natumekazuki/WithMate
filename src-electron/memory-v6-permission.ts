import type { MemoryError, MemoryPermission } from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";

export type MemoryV6Principal = {
  bindingIdHash: string;
  sessionId: string;
  providerId: string;
  permissions: readonly MemoryPermission[];
  character: { id: string; name: string } | null;
  sessionProject: { id: string; displayName: string } | null;
  accessibleCharacterIds?: readonly string[];
  accessibleProjectIds?: readonly string[];
};

export function memoryBindingRequiredError(message = "WithMate runtime binding is required."): MemoryError {
  return {
    code: "MEMORY_BINDING_REQUIRED",
    message,
  };
}

export function memoryUnauthorizedError(permission: MemoryPermission): MemoryError {
  return {
    code: "MEMORY_UNAUTHORIZED",
    message: `Memory permission is required: ${permission}`,
  };
}

export function memoryForbiddenError(): MemoryError {
  return {
    code: "MEMORY_FORBIDDEN",
    message: "Memory target is not accessible from the current binding.",
  };
}

export function requireMemoryPermission(principal: MemoryV6Principal | null, permission: MemoryPermission): MemoryError | null {
  if (!principal) {
    return memoryBindingRequiredError();
  }
  if (!principal.permissions.includes(permission)) {
    return memoryUnauthorizedError(permission);
  }
  return null;
}

export function canAccessMemoryTarget(principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): boolean {
  if (target.owner.type === "user" || target.scope.type === "session" || target.scope.type === "global") {
    return false;
  }

  const characterIds = new Set([
    ...(principal.character ? [principal.character.id] : []),
    ...(principal.accessibleCharacterIds ?? []),
  ]);
  const projectIds = new Set([
    ...(principal.sessionProject ? [principal.sessionProject.id] : []),
    ...(principal.accessibleProjectIds ?? []),
  ]);

  const ownerAllowed = target.owner.type === "character"
    ? characterIds.has(target.owner.id)
    : projectIds.has(target.owner.id);
  const scopeAllowed = target.scope.type === "character"
    ? characterIds.has(target.scope.id)
    : target.scope.type === "project" && projectIds.has(target.scope.id);

  return ownerAllowed && scopeAllowed;
}
