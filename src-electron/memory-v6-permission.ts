import type { MemoryError, MemoryPermission } from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";

export type MemoryV6SessionBindingPrincipal = {
  type: "session_binding";
  bindingIdHash: string;
  sessionId: string;
  providerId: string;
  permissions: readonly MemoryPermission[];
  character: { id: string; name: string } | null;
  sessionProject: { id: string; displayName: string } | null;
  accessibleCharacterIds?: readonly string[];
  accessibleProjectIds?: readonly string[];
};

export type MemoryV6LocalUserPrincipal = {
  type: "local_user";
  bindingIdHash: "local-user";
  providerId: "local-user";
  permissions: readonly MemoryPermission[];
};

export type MemoryV6Principal = MemoryV6SessionBindingPrincipal | MemoryV6LocalUserPrincipal;

export const LOCAL_USER_MEMORY_PERMISSIONS: readonly MemoryPermission[] = [
  "memory.search",
  "memory.get_entry",
  "memory.list_tags",
  "memory.append",
  "memory.forget",
];

export function createLocalUserMemoryPrincipal(): MemoryV6LocalUserPrincipal {
  return {
    type: "local_user",
    bindingIdHash: "local-user",
    providerId: "local-user",
    permissions: LOCAL_USER_MEMORY_PERMISSIONS,
  };
}

export function isSessionBindingPrincipal(
  principal: MemoryV6Principal,
): principal is MemoryV6SessionBindingPrincipal {
  return principal.type === "session_binding";
}

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
  const isUserGlobalTarget = target.owner.type === "user" && target.scope.type === "global";
  if (principal.type === "local_user") {
    return isUserGlobalTarget || (target.owner.type === "project" && target.scope.type === "project");
  }

  if (target.owner.type === "user" || target.scope.type === "session" || target.scope.type === "global") {
    return isUserGlobalTarget;
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
