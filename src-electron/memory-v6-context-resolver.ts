import type {
  CharacterTargetRef,
  MemoryError,
  MemoryTargetSelector,
  ProjectTargetRef,
} from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import {
  canAccessMemoryTarget,
  memoryBindingRequiredError,
  memoryForbiddenError,
  type MemoryV6Principal,
} from "./memory-v6-permission.js";

export type MemoryV6ProjectContext = {
  id: string;
  displayName: string;
};

export type MemoryV6TargetResolverDeps = {
  resolveProjectById?(id: string): MemoryV6ProjectContext | null;
  resolveProjectByPath?(projectPath: string): MemoryV6ProjectContext | null;
  resolveProjectByAlias?(alias: string): MemoryV6ProjectContext | null;
  resolveCharacterById?(id: string): { id: string; name: string } | null;
};

export type MemoryV6TargetResolutionResult =
  | { ok: true; target: MemoryV6ResolvedTarget }
  | { ok: false; error: MemoryError };

function targetNotFoundError(field: string): MemoryError {
  return {
    code: "MEMORY_TARGET_NOT_FOUND",
    message: "Memory target was not found.",
    field,
  };
}

function resolveProject(ref: ProjectTargetRef, deps: MemoryV6TargetResolverDeps, field: string): MemoryV6ProjectContext | MemoryError {
  if (ref.type === "id") {
    if (deps.resolveProjectById) {
      return deps.resolveProjectById(ref.id) ?? targetNotFoundError(field);
    }
    return { id: ref.id, displayName: ref.id };
  }
  if (ref.type === "path") {
    return deps.resolveProjectByPath?.(ref.path) ?? targetNotFoundError(field);
  }
  return deps.resolveProjectByAlias?.(ref.alias) ?? targetNotFoundError(field);
}

function resolveCharacter(
  ref: CharacterTargetRef,
  principal: MemoryV6Principal,
  deps: MemoryV6TargetResolverDeps,
  field: string,
): { id: string; name: string } | MemoryError {
  if (ref.type === "current") {
    return principal.character ?? memoryBindingRequiredError("current character requires a WithMate runtime binding.");
  }
  if (deps.resolveCharacterById) {
    return deps.resolveCharacterById(ref.id) ?? targetNotFoundError(field);
  }
  return { id: ref.id, name: ref.id };
}

function withAccessCheck(principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): MemoryV6TargetResolutionResult {
  if (!canAccessMemoryTarget(principal, target)) {
    return { ok: false, error: memoryForbiddenError() };
  }
  return { ok: true, target };
}

export function resolveMemoryV6Target(
  selector: MemoryTargetSelector,
  principal: MemoryV6Principal,
  deps: MemoryV6TargetResolverDeps = {},
): MemoryV6TargetResolutionResult {
  if (selector.owner === "project" && selector.scope === "project") {
    const project = resolveProject(selector.project, deps, "target.project");
    if ("code" in project) {
      return { ok: false, error: project };
    }
    return withAccessCheck(principal, {
      owner: { type: "project", id: project.id },
      scope: { type: "project", id: project.id },
    });
  }

  if (selector.owner === "character" && selector.scope === "character") {
    const character = resolveCharacter(selector.character, principal, deps, "target.character");
    if ("code" in character) {
      return { ok: false, error: character };
    }
    return withAccessCheck(principal, {
      owner: { type: "character", id: character.id },
      scope: { type: "character", id: character.id },
    });
  }

  const character = resolveCharacter(selector.character, principal, deps, "target.character");
  if ("code" in character) {
    return { ok: false, error: character };
  }
  const project = resolveProject(selector.project, deps, "target.project");
  if ("code" in project) {
    return { ok: false, error: project };
  }
  return withAccessCheck(principal, {
    owner: { type: "character", id: character.id },
    scope: { type: "project", id: project.id },
  });
}

export function targetMatchesPrincipal(principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): boolean {
  return canAccessMemoryTarget(principal, target);
}
