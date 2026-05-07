import type {
  MateGrowthEvent,
  MateGrowthStorage,
} from "./mate-growth-storage.js";
import { createHash, randomUUID } from "node:crypto";
import type { MateGrowthApplyResult } from "../src/mate-growth-apply-result.js";
import type {
  MateProfileItem,
  MateProfileItemCategory,
  MateProfileItemSectionKey,
  MateProfileItemStorage,
  UpsertMateProfileItemInput,
} from "./mate-profile-item-storage.js";
import { renderMateProfileFiles } from "./mate-profile-file-renderer.js";
import type { MateStorage } from "./mate-storage.js";
import type { ProjectDigestProjectionWriter } from "./mate-project-digest-storage.js";

type ApplyPendingGrowthOptions = {
  runId?: number;
  limit?: number;
};

export type ApplyPendingGrowthResult = MateGrowthApplyResult;

const APPLY_TARGET_SECTIONS = ["core", "bond", "work_style", "project_digest"] as const;
const APPLYABLE_CORE_GROWTH_SOURCE_TYPES = ["explicit_user_instruction", "user_correction"] as const;

const APPLYABLE_CORE_SOURCE_TYPES = ["mate_talk"] as const;
const APPLY_PENDING_GROWTH_WAIT_MS = 50;
const APPLY_PENDING_GROWTH_MAX_ATTEMPTS = 30;

type SemanticEmbeddingIndexService = {
  indexGrowthEvent: (event: MateGrowthEvent) => Promise<unknown>;
  indexProfileItem: (item: MateProfileItem) => Promise<unknown>;
};

type ProviderInstructionTargetInvalidator = {
  markEnabledTargetsStale(): number;
};

type ProjectDigestLookupService = {
  hasProjectDigest(projectDigestId: string): boolean;
} & ProjectDigestProjectionWriter;

type ProjectDigestContextRenderer = {
  buildProjectDigestProjectionText(
    projectDigestId: string,
    options?: { items?: readonly MateProfileItem[] },
  ): string;
};

export class MateGrowthApplyService {
  private readonly projectDigestContextService: ProjectDigestContextRenderer;

  constructor(
    private readonly growthStorage: MateGrowthStorage,
    private readonly profileItemStorage: MateProfileItemStorage,
    private readonly mateStorage: MateStorage,
    private readonly semanticEmbeddingIndexService?: SemanticEmbeddingIndexService,
    private readonly providerInstructionTargetInvalidator?: ProviderInstructionTargetInvalidator,
    private readonly projectDigestLookupService?: ProjectDigestLookupService,
    projectDigestContextService?: ProjectDigestContextRenderer,
  ) {
    this.projectDigestContextService = projectDigestContextService ?? new DefaultProjectDigestContextRenderer(profileItemStorage);
  }

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

    const applicableEvents = events.filter((event) =>
      isApplicableProfileEvent(event, this.projectDigestLookupService));
    const skippedEvents = events.filter((event) =>
      !isApplicableProfileEvent(event, this.projectDigestLookupService));
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

      const profileItems = this.profileItemStorage.listProfileItems({ state: "active" });
      const upsertInputs = applicableEvents.map(buildUpsertInputFromGrowthEvent);
      const projectedProfileItems = buildProjectedProfileItems(profileItems, upsertInputs);
      const renderedFiles = renderMateProfileFiles(profile, projectedProfileItems);
      const updatedProfile = await this.mateStorage.applyProfileFiles({
        sourceGrowthEventId: applicableEvents[0].id,
        summary: `growth apply: ${applicableEvents.length} item(s)`,
        files: renderedFiles,
      });
      updatedProfileRevisionId = updatedProfile.activeRevisionId;

      const profileItemsByClaimKey = new Map(
        profileItems
          .map((item) => [buildProjectedProfileItemLookupKey(item), item.id] as const),
      );
      for (let i = 0; i < applicableEvents.length; i += 1) {
        const upsertInput = {
          ...upsertInputs[i],
          sourceGrowthEventId: applicableEvents[i].id,
          ...(profileItemsByClaimKey.has(buildProjectedProfileItemLookupKey(upsertInputs[i])) ? {
            updatedRevisionId: updatedProfileRevisionId ?? undefined,
          } : {
            createdRevisionId: updatedProfileRevisionId ?? undefined,
          }),
        };

        const upsertedItem = this.profileItemStorage.upsertProfileItem(upsertInput);
        profileItemsByClaimKey.set(buildProjectedProfileItemLookupKey(upsertedItem), upsertedItem.id);
        appliedIndexTargets.push({ event: applicableEvents[i], profileItem: upsertedItem });
      }

      for (const event of applicableEvents) {
        this.growthStorage.markEventApplied(event.id, updatedProfileRevisionId ?? undefined);
      }
      await this.rewriteProjectDigestProjectionsBestEffort({
        events: applicableEvents,
        projectedProfileItems,
        activeRevisionId: updatedProfileRevisionId,
        projectDigestStorage: this.projectDigestLookupService,
        userDataPath: this.mateStorage.getUserDataPath(),
      });
      this.markProviderInstructionTargetsStaleBestEffort();
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

  private async rewriteProjectDigestProjectionsBestEffort(params: {
    events: MateGrowthEvent[];
    projectedProfileItems: readonly MateProfileItem[];
    activeRevisionId: string | null;
    projectDigestStorage?: ProjectDigestLookupService;
    userDataPath: string;
  }): Promise<void> {
    try {
      await this.rewriteProjectDigestProjections(params);
    } catch (error) {
      console.warn("Failed to rewrite project digest projection after growth apply", error);
      // Project Digest の Markdown 投影は参照用キャッシュなので、Growth apply 本体の成功は維持する。
    }
  }

  private async rewriteProjectDigestProjections(params: {
    events: MateGrowthEvent[];
    projectedProfileItems: readonly MateProfileItem[];
    activeRevisionId: string | null;
    projectDigestStorage?: ProjectDigestLookupService;
    userDataPath: string;
  }): Promise<void> {
    const projectDigestEvents = params.events.filter((event): event is MateGrowthEvent & {
      targetSection: "project_digest";
      projectDigestId: string;
    } => (
      event.targetSection === "project_digest" &&
      typeof event.projectDigestId === "string" &&
      event.projectDigestId.trim().length > 0
    ));

    if (projectDigestEvents.length === 0) {
      return;
    }

    if (!params.projectDigestStorage) {
      throw new Error("project digest projection 用ストレージが未指定です");
    }

    const latestEventByDigest = new Map<string, string>();
    for (const event of projectDigestEvents) {
      latestEventByDigest.set(event.projectDigestId, event.id);
    }

    const projectDigestIds = new Set(projectDigestEvents.map((event) => event.projectDigestId));
    for (const projectDigestId of projectDigestIds) {
      const projectionText = this.projectDigestContextService.buildProjectDigestProjectionText(projectDigestId, {
        items: params.projectedProfileItems.filter((item) => item.sectionKey === "project_digest" && item.projectDigestId === projectDigestId),
      });

      try {
        await params.projectDigestStorage.rewriteProjectDigestProjection({
          projectDigestId,
          userDataPath: params.userDataPath,
          content: projectionText,
          activeRevisionId: params.activeRevisionId,
          lastGrowthEventId: latestEventByDigest.get(projectDigestId) ?? null,
        });
      } catch (error) {
        console.warn(`Failed to rewrite project digest projection: ${projectDigestId}`, error);
      }
    }
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

  private markProviderInstructionTargetsStaleBestEffort(): void {
    try {
      this.providerInstructionTargetInvalidator?.markEnabledTargetsStale();
    } catch (error) {
      console.warn("Failed to mark provider instruction targets stale after growth apply", error);
      // Provider instruction sync state は後続通知なので、profile apply の成功は維持する。
    }
  }
}

class DefaultProjectDigestContextRenderer implements ProjectDigestContextRenderer {
  constructor(private readonly profileItemStorage: MateProfileItemStorage) {}

  buildProjectDigestProjectionText(
    projectDigestId: string,
    options?: { items?: readonly MateProfileItem[] },
  ): string {
    const items = (options?.items ?? this.profileItemStorage.listProfileItems({
      sectionKey: "project_digest",
      state: "active",
      projectionAllowed: true,
      projectDigestId,
    })).filter((item) =>
      item.sectionKey === "project_digest" &&
      item.projectDigestId === projectDigestId &&
      item.state === "active" &&
      item.projectionAllowed
    );

    return buildProjectDigestProjectionText(projectDigestId, items);
  }
}

function buildProjectDigestProjectionText(
  _projectDigestId: string,
  items: readonly MateProfileItem[],
): string {
  const lines = [
    "### Project Digest",
    ...items
      .slice()
      .sort((left, right) => {
        const keyOrder = left.claimKey.localeCompare(right.claimKey);
        if (keyOrder !== 0) {
          return keyOrder;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      })
      .map((item) => `- **${item.claimKey}:** ${item.renderedText}`),
  ];
  return lines.join("\n");
}

function buildProjectedProfileItemLookupKey(input: UpsertMateProfileItemInput | MateProfileItem): string {
  const claimKey = input.claimKey;
  const projectDigestId = input.sectionKey === "project_digest" ? input.projectDigestId ?? "" : "";
  return `${input.sectionKey}:${projectDigestId}:${claimKey}`;
}

function buildProjectedProfileItems(
  activeProfileItems: readonly MateProfileItem[],
  upsertInputs: readonly UpsertMateProfileItemInput[],
): MateProfileItem[] {
  const now = new Date().toISOString();
  const profileItemsByKey = new Map(
    activeProfileItems.map((item) => [buildProjectedProfileItemLookupKey(item), item] as const),
  );
  const updatedItems = activeProfileItems.map((item) => ({ ...item, tags: [...item.tags] }));

  for (const upsertInput of upsertInputs) {
    const key = buildProjectedProfileItemLookupKey(upsertInput);
    const existingItem = profileItemsByKey.get(key);

    const claimValue = upsertInput.claimValue ?? "";
    const claimValueNormalized = claimValue.trim().toLowerCase();
    const normalizedClaim = upsertInput.normalizedClaim ?? (claimValueNormalized || upsertInput.claimKey);
    const projectionAllowed = upsertInput.projectionAllowed === true;
    const recurrenceCount = upsertInput.recurrenceCount ?? 1;

    const projectedItem: MateProfileItem = existingItem ? {
      ...existingItem,
      claimValue,
      claimValueNormalized,
      renderedText: upsertInput.renderedText,
      category: upsertInput.category,
      normalizedClaim,
      confidence: upsertInput.confidence,
      salienceScore: upsertInput.salienceScore,
      recurrenceCount,
      projectionAllowed,
      sectionKey: upsertInput.sectionKey,
      projectDigestId: upsertInput.projectDigestId ?? existingItem.projectDigestId,
      lastSeenAt: now,
      updatedAt: now,
    } : {
      id: randomUUID(),
      sectionKey: upsertInput.sectionKey,
      projectDigestId: upsertInput.projectDigestId ?? null,
      category: upsertInput.category,
      claimKey: upsertInput.claimKey,
      claimValue,
      claimValueNormalized,
      renderedText: upsertInput.renderedText,
      normalizedClaim,
      confidence: upsertInput.confidence,
      salienceScore: upsertInput.salienceScore,
      recurrenceCount,
      projectionAllowed,
      state: "active",
      firstSeenAt: now,
      lastSeenAt: now,
      createdRevisionId: null,
      updatedRevisionId: null,
      disabledRevisionId: null,
      forgottenRevisionId: null,
      disabledAt: null,
      forgottenAt: null,
      createdAt: now,
      updatedAt: now,
      tags: [],
    };

    if (existingItem) {
      const index = updatedItems.findIndex((item) => item.id === existingItem.id);
      if (index >= 0) {
        updatedItems.splice(index, 1, projectedItem);
      } else {
        updatedItems.push(projectedItem);
      }
      profileItemsByKey.set(key, projectedItem);
    } else {
      updatedItems.push(projectedItem);
      profileItemsByKey.set(key, projectedItem);
    }
  }

  return updatedItems;
}

function buildUpsertInputFromGrowthEvent(
  event: MateGrowthEvent & { targetSection: MateProfileItemSectionKey },
): UpsertMateProfileItemInput {
  const baseInput: UpsertMateProfileItemInput = {
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
    tags: [
      { type: "growth_kind", value: event.kind },
      { type: "growth_source_type", value: event.growthSourceType },
    ],
  };

  if (event.targetSection === "project_digest" && event.projectDigestId) {
    baseInput.projectDigestId = event.projectDigestId;
  }

  return baseInput;
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
      projectDigestId: event.projectDigestId,
      targetClaimKey: event.targetClaimKey,
      confidence: event.confidence,
      salienceScore: event.salienceScore,
      projectionAllowed: event.projectionAllowed,
      updatedAt: event.updatedAt,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isApplicableProfileEvent(
  event: MateGrowthEvent,
  projectDigestLookupService?: ProjectDigestLookupService,
): event is
  | (MateGrowthEvent & { targetSection: Extract<MateProfileItemSectionKey, "core" | "bond" | "work_style">; })
  | (MateGrowthEvent & { targetSection: "project_digest"; projectDigestId: string; }) {
  const targetSection = event.targetSection;
  if (!event.projectionAllowed || event.state !== "candidate") {
    return false;
  }
  if (targetSection === "project_digest") {
    return isProjectDigestGrowthEvent(event, projectDigestLookupService);
  }
  if (!(APPLY_TARGET_SECTIONS as readonly string[]).includes(targetSection)) {
    return false;
  }
  return targetSection !== "core" || isManualCoreGrowthEvent(event);
}

function isProjectDigestGrowthEvent(
  event: MateGrowthEvent,
  projectDigestLookupService?: ProjectDigestLookupService,
): event is MateGrowthEvent & {
  targetSection: "project_digest";
  projectDigestId: string;
} {
  if (event.targetSection !== "project_digest" ||
    typeof event.projectDigestId !== "string" ||
    event.projectDigestId.trim().length === 0) {
    return false;
  }

  return projectDigestLookupService?.hasProjectDigest(event.projectDigestId) ?? true;
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
