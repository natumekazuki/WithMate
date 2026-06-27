import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { CharacterProfile } from "../src/character-state.js";
import type { MemoryPermission } from "../src/memory-v6/memory-contract.js";
import type { ModelCatalogProvider } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import {
  getProviderMemoryBindingCapability,
  type ProviderMemoryBindingRuntimeProjection,
} from "./provider-memory-binding.js";
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

export class MemoryBindingRegistry {
  private readonly recordsByBindingId = new Map<string, MemoryBindingRecord>();
  private readonly bindingIdsByReferenceHash = new Map<string, string>();

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
    const sessionProject = input.session.workspacePath.trim()
      ? {
          id: input.session.workspacePath,
          displayName: input.session.workspaceLabel.trim() || input.session.workspacePath,
        }
      : null;
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
      bindingIdHash: record.bindingReferenceHash,
      sessionId: record.sessionId,
      providerId: record.providerId,
      permissions: [...record.permissions],
      character: record.character,
      sessionProject: record.sessionProject,
      accessibleCharacterIds: record.character ? [record.character.id] : [],
      accessibleProjectIds: record.sessionProject ? [record.sessionProject.id] : [],
    };
  }
}

function hashBindingReference(bindingReference: string): string {
  return createHash("sha256").update(bindingReference, "utf8").digest("base64url");
}

function isExpired(record: MemoryBindingRecord, now: Date): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}
