import type {
  MateGrowthEvent,
  MateGrowthStorage,
} from "./mate-growth-storage.js";
import type {
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

export class MateGrowthApplyService {
  constructor(
    private readonly growthStorage: MateGrowthStorage,
    private readonly profileItemStorage: MateProfileItemStorage,
    private readonly mateStorage: MateStorage,
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

    for (const event of skippedEvents) {
      this.growthStorage.markEventSkipped(event.id);
    }

    if (applicableEvents.length === 0) {
      return {
        candidateCount: events.length,
        appliedCount: 0,
        skippedCount: skippedEvents.length,
        revisionId: null,
      };
    }

    for (const event of applicableEvents) {
      this.profileItemStorage.upsertProfileItem({
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
    }

    const profileItems = this.profileItemStorage.listProfileItems({ state: "active" });
    const renderedFiles = renderMateProfileFiles(profile, profileItems);
    const updatedProfile = await this.mateStorage.applyProfileFiles({
      sourceGrowthEventId: applicableEvents[0].id,
      summary: `growth apply: ${applicableEvents.length} item(s)`,
      files: renderedFiles,
    });

    for (const event of applicableEvents) {
      this.growthStorage.markEventApplied(event.id, updatedProfile.activeRevisionId ?? undefined);
    }

    return {
      candidateCount: events.length,
      appliedCount: applicableEvents.length,
      skippedCount: skippedEvents.length,
      revisionId: updatedProfile.activeRevisionId,
    };
  }
}

function isApplicableProfileEvent(event: MateGrowthEvent): event is MateGrowthEvent & {
  targetSection: Extract<MateProfileItemSectionKey, "core" | "bond" | "work_style">;
} {
  return event.projectionAllowed &&
    event.state === "candidate" &&
    (APPLY_TARGET_SECTIONS as readonly string[]).includes(event.targetSection);
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
