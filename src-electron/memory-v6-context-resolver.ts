import type {
  CharacterTargetRef,
  MemoryError,
  MemoryTargetSelector,
  ProjectTargetRef,
} from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ProjectScopeAdmission, MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import {
  canAccessMemoryTarget,
  memoryForbiddenError,
  type MemoryV6Principal,
} from "./memory-v6-permission.js";

export type MemoryV6ProjectContext = {
  id: string;
  displayName: string;
  admission?: MemoryV6ProjectScopeAdmission;
};

export type MemoryV6TargetResolverDeps = {
  resolveProjectById?(id: string): MemoryV6ProjectContext | null;
  resolveProjectByPath?(projectPath: string): MemoryV6ProjectContext | null;
  resolveKnownProjectByPath?(projectPath: string): MemoryV6ProjectContext | null;
  resolveCharacterById?(id: string): { id: string; name: string } | null;
};

export type MemoryV6TargetResolutionResult =
  | { ok: true; target: MemoryV6ResolvedTarget; projectScopeAdmissions: MemoryV6ProjectScopeAdmission[] }
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
  return deps.resolveProjectByPath?.(ref.path) ?? targetNotFoundError(field);
}

export type MemoryV6ProjectPathResolution = "create" | "known";

function resolveCharacter(
  ref: CharacterTargetRef,
  deps: MemoryV6TargetResolverDeps,
  field: string,
): { id: string; name: string } | MemoryError {
  if (deps.resolveCharacterById) {
    return deps.resolveCharacterById(ref.id) ?? targetNotFoundError(field);
  }
  return { id: ref.id, name: ref.id };
}

function withAccessCheck(
  principal: MemoryV6Principal,
  target: MemoryV6ResolvedTarget,
  projectScopeAdmissions: MemoryV6ProjectScopeAdmission[] = [],
): MemoryV6TargetResolutionResult {
  if (!canAccessMemoryTarget(principal, target)) {
    return { ok: false, error: memoryForbiddenError() };
  }
  return { ok: true, target, projectScopeAdmissions };
}

export function resolveMemoryV6Target(
  selector: MemoryTargetSelector,
  principal: MemoryV6Principal,
  deps: MemoryV6TargetResolverDeps = {},
  options: { projectPathResolution?: MemoryV6ProjectPathResolution } = {},
): MemoryV6TargetResolutionResult {
  const resolutionDeps = options.projectPathResolution === "known"
    ? { ...deps, resolveProjectByPath: deps.resolveKnownProjectByPath }
    : deps;
  if (
    principal.type === "session_binding"
    && selector.owner === "character"
    && selector.character.id !== principal.characterId
  ) {
    return { ok: false, error: memoryForbiddenError() };
  }
  if (selector.owner === "user" && selector.scope === "global") {
    return withAccessCheck(principal, {
      owner: { type: "user", id: "local-user" },
      scope: { type: "global", id: "global" },
    });
  }

  if (selector.owner === "project" && selector.scope === "project") {
    const project = resolveProject(selector.project, resolutionDeps, "target.project");
    if ("code" in project) {
      return { ok: false, error: project };
    }
    return withAccessCheck(principal, {
      owner: { type: "project", id: project.id },
      scope: { type: "project", id: project.id },
    }, project.admission ? [project.admission] : []);
  }

  if (selector.owner === "character" && selector.scope === "character") {
    const character = resolveCharacter(selector.character, deps, "target.character");
    if ("code" in character) {
      return { ok: false, error: character };
    }
    return withAccessCheck(principal, {
      owner: { type: "character", id: character.id },
      scope: { type: "character", id: character.id },
    });
  }

  if (selector.owner !== "character" || selector.scope !== "project") {
    return { ok: false, error: memoryForbiddenError() };
  }

  const character = resolveCharacter(selector.character, deps, "target.character");
  if ("code" in character) {
    return { ok: false, error: character };
  }
  const project = resolveProject(selector.project, resolutionDeps, "target.project");
  if ("code" in project) {
    return { ok: false, error: project };
  }
  return withAccessCheck(principal, {
    owner: { type: "character", id: character.id },
    scope: { type: "project", id: project.id },
  }, project.admission ? [project.admission] : []);
}

export function targetMatchesPrincipal(principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): boolean {
  return canAccessMemoryTarget(principal, target);
}
