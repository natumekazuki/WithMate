import type {
  CharacterTargetRef,
  MemoryError,
  MemoryTargetSelector,
  ProjectTargetRef,
} from "../src/memory-v6/memory-contract.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import {
  canAccessMemoryTarget,
  isSessionBindingPrincipal,
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
  resolveKnownProjectByPath?(projectPath: string): MemoryV6ProjectContext | null;
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
  if (ref.type === "current") {
    return memoryBindingRequiredError("current project requires a WithMate runtime binding.");
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
    return isSessionBindingPrincipal(principal) && principal.character
      ? principal.character
      : memoryBindingRequiredError("current character requires a WithMate runtime binding.");
  }
  if (deps.resolveCharacterById) {
    return deps.resolveCharacterById(ref.id) ?? targetNotFoundError(field);
  }
  return { id: ref.id, name: ref.id };
}

function allowedProjectTargetLabels(principal: MemoryV6Principal): string[] {
  if (!isSessionBindingPrincipal(principal)) {
    return [];
  }
  const projects = principal.accessibleProjects ?? (principal.sessionProject ? [principal.sessionProject] : []);
  return projects.map((project) => project.displayName || project.id);
}

function resolveProjectForPrincipal(
  ref: ProjectTargetRef,
  principal: MemoryV6Principal,
  deps: MemoryV6TargetResolverDeps,
  field: string,
): MemoryV6ProjectContext | MemoryError {
  if (ref.type === "current") {
    return isSessionBindingPrincipal(principal) && principal.sessionProject
      ? principal.sessionProject
      : memoryBindingRequiredError("current project requires a WithMate runtime binding.");
  }
  if (ref.type === "path" && isSessionBindingPrincipal(principal)) {
    return deps.resolveKnownProjectByPath?.(ref.path) ?? targetNotFoundError(field);
  }
  return resolveProject(ref, deps, field);
}

function withAccessCheck(principal: MemoryV6Principal, target: MemoryV6ResolvedTarget): MemoryV6TargetResolutionResult {
  if (!canAccessMemoryTarget(principal, target)) {
    if (target.owner.type === "project") {
      return {
        ok: false,
        error: memoryForbiddenError({
          message: "Project target is not attached to this session.",
          allowedProjectTargets: allowedProjectTargetLabels(principal),
          suggestion: "Attach the repository to this session or run the command from an allowed project.",
        }),
      };
    }
    return { ok: false, error: memoryForbiddenError() };
  }
  return { ok: true, target };
}

export function resolveMemoryV6Target(
  selector: MemoryTargetSelector,
  principal: MemoryV6Principal,
  deps: MemoryV6TargetResolverDeps = {},
): MemoryV6TargetResolutionResult {
  if (selector.owner === "user" && selector.scope === "global") {
    return withAccessCheck(principal, {
      owner: { type: "user", id: "local-user" },
      scope: { type: "global", id: "global" },
    });
  }

  if (selector.owner === "project" && selector.scope === "project") {
    const project = resolveProjectForPrincipal(selector.project, principal, deps, "target.project");
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

  if (selector.owner !== "character" || selector.scope !== "project") {
    return { ok: false, error: memoryForbiddenError() };
  }

  const character = resolveCharacter(selector.character, principal, deps, "target.character");
  if ("code" in character) {
    return { ok: false, error: character };
  }
  const project = resolveProjectForPrincipal(selector.project, principal, deps, "target.project");
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
