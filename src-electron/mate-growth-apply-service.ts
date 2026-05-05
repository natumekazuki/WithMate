import type {
  MateGrowthEvent,
  MateGrowthStorage,
} from "./mate-growth-storage.js";
import { createHash } from "node:crypto";
import type {
  MateProfileItem,
  MateProfileItemCategory,
  MateProfileItemSectionKey,
  MateProfileItemStorage,
} from "./mate-profile-item-storage.js";
import { renderMateProfileFiles } from "./mate-profile-file-renderer.js";
import type { MateStorage } from "./mate-storage.js";

type ApplyPendingGrowthOptions = {
  runId?: number;
  limit?: number;
};

export type ApplyPendingGrowthResult = {
  candidateCount: number;
  appliedCount: number;
  skippedCount: number;
  revisionId: string | null;
};

const APPLY_TARGET_SECTIONS = ["core", "bond", "work_style"] as const;
const APPLYABLE_CORE_GROWTH_SOURCE_TYPES = ["explicit_user_instruction", "user_correction"] as const;

const APPLYABLE_CORE_SOURCE_TYPES = ["mate_talk"] as const;
const APPLY_PENDING_GROWTH_WAIT_MS = 50;
const APPLY_PENDING_GROWTH_MAX_ATTEMPTS = 30;

type SemanticEmbeddingIndexService = {
  indexGrowthEvent: (event: MateGrowthEvent) => Promise<unknown>;
  indexProfileItem: (item: MateProfileItem) => Promise<unknown>;
};

export class MateGrowthApplyService {
  constructor(
    private readonly growthStorage: MateGrowthStorage,
    private readonly profileItemStorage: MateProfileItemStorage,
    private readonly mateStorage: MateStorage,
    private readonly semanticEmbeddingIndexService?: SemanticEmbeddingIndexService,
  ) {}

  async applyPendingGrowth(options: ApplyPendingGrowthOptions = {}): Promise<ApplyPendingGrowthResult> {
    const events = this.growthStorage.listPendingEvents({
      runId: options.runId,
      limit: options.limit,
    });
    if (events.length === 0) {
      return {
        candidateCount: 0,
        appliedCount: 0,
        skippedCount: 0,
        revisionId: null,
      };
    }

    const profile = this.mateStorage.getMateProfile();
    if (!profile) {
      throw new Error("Mate が作成されていないよ。");
    }

    const applicableEvents = events.filter(isApplicableProfileEvent);
    const skippedEvents = events.filter((event) => !isApplicableProfileEvent(event));
    const runFingerprint = buildGrowthApplyInputFingerprint(options, events);
    const operationId = `growth-apply:${runFingerprint}`;
    const lock = this.growthStorage.acquireGrowthApplyRun({
      operationId,
      inputHash: runFingerprint,
      candidateCount: events.length,
    });

    if (!lock.isOwner) {
      const completedRunResult = await this.waitForExistingGrowthApplyRunResult(operationId);
      if (completedRunResult) {
        return completedRunResult;
      }

      throw new Error("Growth apply の完了待ちがタイムアウトしました。");
    }

    const appliedIndexTargets: Array<{
      event: MateGrowthEvent;
      profileItem: MateProfileItem;
    }> = [];
    let updatedProfileRevisionId: string | null = null;
    let result: ApplyPendingGrowthResult;

    try {
      this.growthStorage.markGrowthApplyRunApplying(lock.runId);

      for (const event of skippedEvents) {
        this.growthStorage.markEventSkipped(event.id);
      }

      if (applicableEvents.length === 0) {
        result = {
          candidateCount: events.length,
          appliedCount: 0,
          skippedCount: skippedEvents.length,
          revisionId: null,
        };
        this.growthStorage.finishRun(lock.runId, {
          appliedCount: result.appliedCount,
          invalidCount: result.skippedCount,
        });
        return result;
      }

      for (const event of applicableEvents) {
        const upsertedItem = this.profileItemStorage.upsertProfileItem({
          sectionKey: event.targetSection,
          category: growthEventCategory(event),
          claimKey: growthEventClaimKey(event),
          claimValue: event.statement,
          renderedText: event.statement,
          normalizedClaim: event.statementFingerprint || event.statement,
          confidence: event.confidence,
          salienceScore: event.salienceScore,
          recurrenceCount: event.recurrenceCount,
          projectionAllowed: event.projectionAllowed,
          sourceGrowthEventId: event.id,
          tags: [
            { type: "growth_kind", value: event.kind },
            { type: "growth_source_type", value: event.growthSourceType },
          ],
        });

        appliedIndexTargets.push({ event, profileItem: upsertedItem });
      }

      const profileItems = this.profileItemStorage.listProfileItems({ state: "active" });
      const renderedFiles = renderMateProfileFiles(profile, profileItems);
      const updatedProfile = await this.mateStorage.applyProfileFiles({
        sourceGrowthEventId: applicableEvents[0].id,
        summary: `growth apply: ${applicableEvents.length} item(s)`,
        files: renderedFiles,
      });
      updatedProfileRevisionId = updatedProfile.activeRevisionId;

      for (const event of applicableEvents) {
        this.growthStorage.markEventApplied(event.id, updatedProfileRevisionId ?? undefined);
      }
      await this.indexAppliedGrowthBestEffort(appliedIndexTargets);

      result = {
        candidateCount: events.length,
        appliedCount: applicableEvents.length,
        skippedCount: skippedEvents.length,
        revisionId: updatedProfileRevisionId,
      };
    } catch (error) {
      this.growthStorage.failRun(lock.runId, error instanceof Error ? error.message : String(error));
      throw error;
    }

    this.growthStorage.finishRun(lock.runId, {
      outputRevisionId: result.revisionId ?? undefined,
      appliedCount: result.appliedCount,
      invalidCount: result.skippedCount,
    });

    return result;
  }

  private buildApplyResultFromRun(run: {
    candidateCount: number;
    appliedCount: number;
    invalidCount: number;
    outputRevisionId: string | null;
  }): ApplyPendingGrowthResult {
    const candidateCount = Math.max(run.candidateCount, 0);
    const appliedCount = Math.max(run.appliedCount, 0);
    const skippedCount = Math.max(run.invalidCount, 0);
    return {
      candidateCount,
      appliedCount,
      skippedCount,
      revisionId: run.outputRevisionId,
    };
  }

  private async waitForExistingGrowthApplyRunResult(operationId: string): Promise<ApplyPendingGrowthResult | null> {
    for (let attempt = 0; attempt < APPLY_PENDING_GROWTH_MAX_ATTEMPTS; attempt += 1) {
      const run = this.growthStorage.getGrowthApplyRunByOperationId(operationId);
      if (!run) {
        return null;
      }
      if (run.status === "failed") {
        throw new Error("Growth apply failed before completion.");
      }
      if (run.status !== "queued" && run.status !== "applying") {
        return this.buildApplyResultFromRun(run);
      }
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, APPLY_PENDING_GROWTH_WAIT_MS));
      }
    }
    return null;
  }

  private async indexAppliedGrowthBestEffort(
    targets: Array<{
      event: MateGrowthEvent;
      profileItem: MateProfileItem;
    }>,
  ): Promise<void> {
    if (!this.semanticEmbeddingIndexService || targets.length === 0) {
      return;
    }

    await Promise.allSettled(targets.flatMap(({ event, profileItem }) => [
      this.semanticEmbeddingIndexService!.indexGrowthEvent(event),
      this.semanticEmbeddingIndexService!.indexProfileItem(profileItem),
    ]));
  }
}

function buildGrowthApplyInputFingerprint(options: ApplyPendingGrowthOptions, events: MateGrowthEvent[]): string {
  const runId = options.runId === undefined ? null : options.runId;
  const limit = options.limit === undefined ? null : options.limit;
  const payload = {
    runId,
    limit,
    events: events.map((event) => ({
      id: event.id,
      statementFingerprint: event.statementFingerprint,
      statement: event.statement,
      targetSection: event.targetSection,
      targetClaimKey: event.targetClaimKey,
      confidence: event.confidence,
      salienceScore: event.salienceScore,
      projectionAllowed: event.projectionAllowed,
      updatedAt: event.updatedAt,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isApplicableProfileEvent(event: MateGrowthEvent): event is MateGrowthEvent & {
  targetSection: Extract<MateProfileItemSectionKey, "core" | "bond" | "work_style">;
} {
  return event.projectionAllowed &&
    event.state === "candidate" &&
    (APPLY_TARGET_SECTIONS as readonly string[]).includes(event.targetSection) &&
    (event.targetSection !== "core" || isManualCoreGrowthEvent(event));
}

function isManualCoreGrowthEvent(event: MateGrowthEvent): boolean {
  return (
    (APPLYABLE_CORE_SOURCE_TYPES as readonly string[]).includes(event.sourceType) &&
    (APPLYABLE_CORE_GROWTH_SOURCE_TYPES as readonly string[]).includes(event.growthSourceType)
  );
}

function growthEventCategory(event: MateGrowthEvent): MateProfileItemCategory {
  if (event.kind === "preference") {
    return "preference";
  }
  if (event.kind === "relationship") {
    return "relationship";
  }
  if (event.kind === "work_style") {
    return "work_style";
  }
  if (event.kind === "boundary") {
    return "boundary";
  }
  if (event.kind === "project_context") {
    return "project_context";
  }
  if (event.kind === "conversation") {
    return "voice";
  }
  return "note";
}

function growthEventClaimKey(event: MateGrowthEvent): string {
  const targetClaimKey = event.targetClaimKey.trim();
  if (targetClaimKey) {
    return targetClaimKey;
  }
  if (event.statementFingerprint.trim()) {
    return event.statementFingerprint;
  }
  return event.id;
}
