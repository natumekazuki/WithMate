import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { CharacterProfile } from "../src/character-state.js";
import type { MemoryPermission } from "../src/memory-v6/memory-contract.js";
import type { ModelCatalogProvider } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import {
  getProviderMemoryBindingCapability,
  type ProviderMemoryBindingRuntimeProjection,
} from "./provider-memory-binding.js";
import type { MemoryV6ProjectContext } from "./memory-v6-context-resolver.js";
import type { MemoryV6Principal } from "./memory-v6-permission.js";

const DEFAULT_MEMORY_PERMISSIONS: readonly MemoryPermission[] = [
  "memory.resolve_context",
  "memory.search",
  "memory.get_entry",
  "memory.list_tags",
  "memory.append",
  "memory.forget",
];

export type MemoryBindingRecord = {
  bindingId: string;
  bindingReferenceHash: string;
  runId: string | null;
  sessionId: string;
  characterId: string | null;
  projectScopeId: string | null;
  providerId: string;
  permissions: readonly MemoryPermission[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  character: { id: string; name: string } | null;
  sessionProject: { id: string; displayName: string } | null;
  accessibleProjects: readonly { id: string; displayName: string }[];
};

export type CreateMemoryBindingInput = {
  session: Session;
  provider: ModelCatalogProvider;
  character: CharacterProfile | null;
  runId?: string | null;
  now?: Date;
  permissions?: readonly MemoryPermission[];
  expiresAt?: string | null;
};

export type MemoryBindingProjectResolver = {
  resolveProjectByPath?(projectPath: string): MemoryV6ProjectContext | null;
};

function uniqueProjects(projects: readonly (MemoryV6ProjectContext | null)[]): MemoryV6ProjectContext[] {
  const seen = new Set<string>();
  const unique: MemoryV6ProjectContext[] = [];
  for (const project of projects) {
    if (!project || seen.has(project.id)) {
      continue;
    }
    seen.add(project.id);
    unique.push(project);
  }
  return unique;
}

export class MemoryBindingRegistry {
  private readonly recordsByBindingId = new Map<string, MemoryBindingRecord>();
  private readonly bindingIdsByReferenceHash = new Map<string, string>();

  constructor(private projectResolver: MemoryBindingProjectResolver = {}) {}

  setProjectResolver(projectResolver: MemoryBindingProjectResolver): void {
    this.projectResolver = projectResolver;
  }

  createBinding(input: CreateMemoryBindingInput): ProviderMemoryBindingRuntimeProjection | null {
    this.revokeSessionBindings(input.session.id);

    const capability = getProviderMemoryBindingCapability(input.provider.id);
    if (capability.transport === "unsupported") {
      return {
        bindingId: randomUUID(),
        bindingReference: "",
        transport: "unsupported",
      };
    }

    const bindingId = randomUUID();
    const bindingReference = randomBytes(32).toString("base64url");
    const bindingReferenceHash = hashBindingReference(bindingReference);
    const createdAt = (input.now ?? new Date()).toISOString();
    const workspacePath = input.session.workspacePath.trim();
    const resolvedProject = workspacePath
      ? this.projectResolver.resolveProjectByPath?.(workspacePath) ?? null
      : null;
    const sessionProject = workspacePath && resolvedProject
      ? {
          id: resolvedProject.id,
          displayName: input.session.workspaceLabel.trim() || resolvedProject.displayName,
        }
      : null;
    const accessibleProjects = uniqueProjects([
      sessionProject,
      ...input.session.allowedAdditionalDirectories.map((directoryPath) => {
        const normalizedDirectoryPath = directoryPath.trim();
        return normalizedDirectoryPath ? this.projectResolver.resolveProjectByPath?.(normalizedDirectoryPath) ?? null : null;
      }),
    ]);
    const character = input.character
      ? { id: input.character.id, name: input.character.name }
      : input.session.characterId.trim()
        ? { id: input.session.characterId, name: input.session.character.trim() || input.session.characterId }
        : null;
    const record: MemoryBindingRecord = {
      bindingId,
      bindingReferenceHash,
      runId: input.runId ?? null,
      sessionId: input.session.id,
      characterId: character?.id ?? null,
      projectScopeId: sessionProject?.id ?? null,
      providerId: input.provider.id,
      permissions: [...(input.permissions ?? DEFAULT_MEMORY_PERMISSIONS)],
      createdAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      character,
      sessionProject,
      accessibleProjects,
    };

    this.recordsByBindingId.set(record.bindingId, record);
    this.bindingIdsByReferenceHash.set(record.bindingReferenceHash, record.bindingId);

    return {
      bindingId,
      bindingReference,
      transport: capability.transport,
      expiresAt: record.expiresAt,
    };
  }

  revokeBinding(binding: Pick<ProviderMemoryBindingRuntimeProjection, "bindingId">): void {
    const record = this.recordsByBindingId.get(binding.bindingId);
    if (!record) {
      return;
    }

    this.recordsByBindingId.delete(record.bindingId);
    this.bindingIdsByReferenceHash.delete(record.bindingReferenceHash);
  }

  revokeSessionBindings(sessionId: string): void {
    for (const record of [...this.recordsByBindingId.values()]) {
      if (record.sessionId === sessionId) {
        this.revokeBinding(record);
      }
    }
  }

  revokeAll(): void {
    this.recordsByBindingId.clear();
    this.bindingIdsByReferenceHash.clear();
  }

  getActiveBindingCount(now = new Date()): number {
    let count = 0;
    for (const record of [...this.recordsByBindingId.values()]) {
      if (record.revokedAt || isExpired(record, now)) {
        this.revokeBinding(record);
        continue;
      }
      count += 1;
    }
    return count;
  }

  resolvePrincipal(bindingReference: string | null | undefined, now = new Date()): MemoryV6Principal | null {
    const normalizedReference = bindingReference?.trim();
    if (!normalizedReference) {
      return null;
    }

    const bindingId = this.bindingIdsByReferenceHash.get(hashBindingReference(normalizedReference));
    if (!bindingId) {
      return null;
    }
    const record = this.recordsByBindingId.get(bindingId);
    if (!record) {
      return null;
    }
    if (record.revokedAt || isExpired(record, now)) {
      this.revokeBinding(record);
      return null;
    }

    return {
      type: "session_binding",
      bindingIdHash: record.bindingReferenceHash,
      sessionId: record.sessionId,
      providerId: record.providerId,
      permissions: [...record.permissions],
      character: record.character,
      sessionProject: record.sessionProject,
      accessibleCharacterIds: record.character ? [record.character.id] : [],
      accessibleProjectIds: record.accessibleProjects.map((project) => project.id),
      accessibleProjects: record.accessibleProjects.map((project) => ({ ...project })),
    };
  }
}

function hashBindingReference(bindingReference: string): string {
  return createHash("sha256").update(bindingReference, "utf8").digest("base64url");
}

function isExpired(record: MemoryBindingRecord, now: Date): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}
