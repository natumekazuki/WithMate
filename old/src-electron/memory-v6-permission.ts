import type { MemoryError, MemoryPermission } from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";

export type MemoryV6LocalUserPrincipal = {
  type: "local_user";
  bindingIdHash: "local-user";
  providerId: "local-user";
  permissions: readonly MemoryPermission[];
};

export type MemoryV6Principal = MemoryV6LocalUserPrincipal;

export const LOCAL_USER_MEMORY_PERMISSIONS: readonly MemoryPermission[] = [
  "memory.search",
  "memory.get_entry",
  "memory.get_file",
  "memory.export_files",
  "memory.list_tags",
  "memory.list_characters",
  "memory.file_usage",
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

export function memoryPrincipalRequiredError(message = "Memory API principal is required."): MemoryError {
  return {
    code: "MEMORY_PRINCIPAL_REQUIRED",
    message,
  };
}

export function memoryUnauthorizedError(permission: MemoryPermission): MemoryError {
  return {
    code: "MEMORY_UNAUTHORIZED",
    message: `Memory permission is required: ${permission}`,
  };
}

export function memoryForbiddenError(options: {
  message?: string;
} = {}): MemoryError {
  return {
    code: "MEMORY_FORBIDDEN",
    message: options.message ?? "Memory target is not accessible.",
  };
}

export function requireMemoryPermission(principal: MemoryV6Principal | null, permission: MemoryPermission): MemoryError | null {
  if (!principal) {
    return memoryPrincipalRequiredError();
  }
  if (!principal.permissions.includes(permission)) {
    return memoryUnauthorizedError(permission);
  }
  return null;
}

export function canAccessMemoryTarget(_principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): boolean {
  const isUserGlobalTarget = target.owner.type === "user" && target.scope.type === "global";
  const isProjectTarget = target.owner.type === "project" && target.scope.type === "project";
  const isCharacterTarget = target.owner.type === "character" && target.scope.type === "character";
  const isCharacterProjectTarget = target.owner.type === "character" && target.scope.type === "project";
  return isUserGlobalTarget || isProjectTarget || isCharacterTarget || isCharacterProjectTarget;
}
