import type { AffectEvaluator } from "../src-shared/character-affect/affect-contract.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../src-shared/memory/memory-contract.js";
import { validateMemoryAppendRequest } from "../src/memory-v6/memory-validation.js";
import {
  CharacterAffectService,
  type CharacterAffectStorageAccess,
  type CharacterAffectEpisodeWriter,
  type CharacterAffectServiceMode,
} from "./character-affect-service.js";
import type { MemoryV6ResolvedTarget } from "./memory-v6-schema.js";
import type { MemoryV6StorageAccess } from "./memory-v6-service.js";

const LOCAL_USER_ID = "local-user";

export class MemoryV6CharacterAffectEpisodeWriter implements CharacterAffectEpisodeWriter {
  constructor(private readonly memoryStorage: MemoryV6StorageAccess) {}

  async validateEpisode(input: Parameters<CharacterAffectEpisodeWriter["validateEpisode"]>[0]): Promise<void> {
    await this.validateRequest(input, "character-affect-memory-preflight", true);
  }

  async writeEpisode(input: Parameters<CharacterAffectEpisodeWriter["writeEpisode"]>[0]): Promise<{ memoryEntryId: string }> {
    const request = await this.validateRequest(input, input.idempotencyKey, false);
    const target: MemoryV6ResolvedTarget = {
      owner: { type: "character", id: input.characterId },
      scope: { type: "character", id: input.characterId },
    };
    const result = await this.memoryStorage.appendEntry({
      target,
      kind: request.kind,
      title: request.title,
      body: request.body,
      preview: request.preview,
      tags: request.tags,
      supersedes: request.supersedes,
      idempotencyKey: request.idempotencyKey,
      bindingIdHash: LOCAL_USER_ID,
      source: {
        type: "agent",
        sessionId: input.sourceSessionId,
        messageId: null,
        providerId: null,
        appMessageId: null,
      },
    });
    return { memoryEntryId: result.entry.id };
  }

  private async validateRequest(
    input: Parameters<CharacterAffectEpisodeWriter["validateEpisode"]>[0],
    idempotencyKey: string,
    requireActiveSupersedes: boolean,
  ) {
    if (input.userId !== LOCAL_USER_ID) {
      throw new Error("Character Affect Memory episode owner must be local-user.");
    }
    if (input.supersedesMemoryEntryId && requireActiveSupersedes) {
      const predecessor = await this.memoryStorage.getEntry(input.supersedesMemoryEntryId);
      if (
        !predecessor
        || predecessor.state !== "active"
        || predecessor.owner.type !== "character"
        || predecessor.owner.id !== input.characterId
        || predecessor.scope.type !== "character"
        || predecessor.scope.id !== input.characterId
      ) {
        throw new Error("Character Affect Memory episode to supersede must be active in the same Character scope.");
      }
    }
    const request = validateMemoryAppendRequest({
      schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: {
        owner: "character",
        scope: "character",
        character: { type: "id", id: input.characterId },
      },
      kind: "context",
      title: input.candidate.title,
      body: input.candidate.body,
      preview: input.candidate.preview,
      tags: input.candidate.motif
        ? [{ type: "motif", value: input.candidate.motif }]
        : [],
      ...(input.supersedesMemoryEntryId ? { supersedes: [input.supersedesMemoryEntryId] } : {}),
      idempotencyKey,
    });
    if (!request.ok) {
      throw new Error(`Character Affect Memory episode is invalid: ${request.error.message}`);
    }

    return request.value;
  }
}

export function createCharacterAffectServiceWithMemory(input: {
  affectStorage: CharacterAffectStorageAccess;
  memoryStorage: MemoryV6StorageAccess;
  evaluator: AffectEvaluator;
  mode?: CharacterAffectServiceMode;
}): CharacterAffectService {
  return new CharacterAffectService(
    input.affectStorage,
    input.evaluator,
    new MemoryV6CharacterAffectEpisodeWriter(input.memoryStorage),
    input.mode,
  );
}
