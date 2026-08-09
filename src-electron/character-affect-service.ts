import {
  type AffectBaselineComponent,
  type AffectConversationEvent,
  type AffectEvaluator,
  type AffectMemoryEpisodeCandidate,
  type EffectiveAffectState,
} from "../src/character-affect/affect-contract.js";
import {
  CharacterAffectStorage,
  type AffectResetInput,
  type StoredAffectEvent,
} from "./character-affect-storage.js";

export type CharacterAffectEpisodeWriter = {
  validateEpisode(input: {
    characterId: string;
    userId: string;
    sourceSessionId: string;
    candidate: AffectMemoryEpisodeCandidate;
    supersedesMemoryEntryId?: string;
  }): void;
  writeEpisode(input: {
    characterId: string;
    userId: string;
    sourceSessionId: string;
    sourceEventId: string;
    idempotencyKey: string;
    candidate: AffectMemoryEpisodeCandidate;
    supersedesMemoryEntryId?: string;
  }): Promise<{ memoryEntryId: string }>;
};

export type CharacterAffectServiceMode = "shadow" | "active";

export class CharacterAffectService {
  constructor(
    private readonly storage: CharacterAffectStorage,
    private readonly evaluator: AffectEvaluator,
    private readonly episodeWriter: CharacterAffectEpisodeWriter,
    private readonly mode: CharacterAffectServiceMode = "shadow",
  ) {
    if (!episodeWriter) {
      throw new Error("Character Affect Memory episode writer is required.");
    }
  }

  async evaluateAndRecord(input: {
    characterId: string;
    userId: string;
    characterDefinition: string;
    baseline: readonly AffectBaselineComponent[];
    event: AffectConversationEvent;
  }): Promise<{ mode: CharacterAffectServiceMode; events: StoredAffectEvent[] }> {
    const current = this.storage.getEffectiveState({
      characterId: input.characterId,
      userId: input.userId,
      sessionId: input.event.sessionId,
      baseline: input.baseline,
    });
    let candidates;
    try {
      candidates = await this.evaluator.evaluate({
        characterId: input.characterId,
        userId: input.userId,
        characterDefinition: input.characterDefinition,
        baseline: input.baseline,
        current,
        event: input.event,
      });
    } catch (error) {
      this.storage.recordRejection({
        characterId: input.characterId,
        userId: input.userId,
        sessionId: input.event.sessionId,
        reason: errorMessage(error),
      });
      throw error;
    }

    const recorded: StoredAffectEvent[] = [];
    for (const candidate of candidates) {
      if (
        candidate.characterId !== input.characterId
        || candidate.userId !== input.userId
        || candidate.sessionId !== input.event.sessionId
      ) {
        this.storage.recordRejection({
          characterId: input.characterId,
          userId: input.userId,
          sessionId: input.event.sessionId,
          reason: "Affect evaluator returned a candidate outside the requested owner scope.",
        });
        throw new Error("Affect evaluator returned a candidate outside the requested owner scope.");
      }
      if (candidate.memoryEpisode) {
        this.episodeWriter.validateEpisode({
          characterId: candidate.characterId,
          userId: candidate.userId,
          sourceSessionId: candidate.sessionId,
          candidate: candidate.memoryEpisode,
        });
      }
      let result;
      try {
        result = this.storage.recordEvent(candidate);
      } catch (error) {
        this.storage.recordRejection({
          characterId: input.characterId,
          userId: input.userId,
          sessionId: input.event.sessionId,
          reason: errorMessage(error),
        });
        throw error;
      }
      const event = await this.persistEpisode(result.event, candidate.memoryEpisode);
      recorded.push(event);
    }
    return { mode: this.mode, events: recorded };
  }

  getEffectiveState(input: {
    characterId: string;
    userId: string;
    sessionId: string;
    baseline?: readonly AffectBaselineComponent[];
  }): EffectiveAffectState & { mode: CharacterAffectServiceMode } {
    return { ...this.storage.getEffectiveState(input), mode: this.mode };
  }

  async correctEvent(input: Parameters<CharacterAffectStorage["correctEvent"]>[0]) {
    const original = this.storage.getEvent({
      eventId: input.eventId,
      characterId: input.replacement.characterId,
      userId: input.replacement.userId,
    });
    if (!original || original.state !== "active") {
      const replay = this.storage.correctEvent(input);
      return {
        ...replay,
        event: await this.persistEpisode(
          replay.event,
          input.replacement.memoryEpisode,
          replay.event.supersedesMemoryEntryId ?? undefined,
        ),
      };
    }
    if (original.memoryEntryId && !input.replacement.memoryEpisode) {
      throw new Error("Affect correction must provide a replacement Memory episode.");
    }
    if (input.replacement.memoryEpisode) {
      this.episodeWriter.validateEpisode({
        characterId: input.replacement.characterId,
        userId: input.replacement.userId,
        sourceSessionId: input.replacement.sessionId,
        candidate: input.replacement.memoryEpisode,
        ...(original.memoryEntryId ? { supersedesMemoryEntryId: original.memoryEntryId } : {}),
      });
    }
    const result = this.storage.correctEvent(input);
    return {
      ...result,
      event: await this.persistEpisode(
        result.event,
        input.replacement.memoryEpisode,
        original.memoryEntryId ?? undefined,
      ),
    };
  }

  reset(input: AffectResetInput) {
    return this.storage.reset(input);
  }

  inspect(input: Parameters<CharacterAffectStorage["inspect"]>[0]) {
    return this.storage.inspect(input);
  }

  getMetrics() {
    return this.storage.getMetrics();
  }

  private async persistEpisode(
    event: StoredAffectEvent,
    candidate: AffectMemoryEpisodeCandidate | undefined,
    supersedesMemoryEntryId?: string,
  ): Promise<StoredAffectEvent> {
    if (!candidate) {
      return event;
    }
    this.storage.recordEpisodeCandidate(event.id);
    if (event.memoryEntryId) {
      return event;
    }
    if (!event.sourceSessionId) {
      throw new Error("Affect event source session is unavailable for Memory episode creation.");
    }
    const episode = await this.episodeWriter.writeEpisode({
      characterId: event.characterId,
      userId: event.userId,
      sourceSessionId: event.sourceSessionId,
      sourceEventId: event.id,
      idempotencyKey: `${event.id}:memory-episode`,
      candidate,
      ...(supersedesMemoryEntryId ? { supersedesMemoryEntryId } : {}),
    });
    this.storage.linkMemoryEpisode(event.id, episode.memoryEntryId);
    return this.storage.inspect({
      characterId: event.characterId,
      userId: event.userId,
      sessionId: event.sourceSessionId,
    }).events.find((item) => item.id === event.id)!;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown affect evaluation rejection.";
}
