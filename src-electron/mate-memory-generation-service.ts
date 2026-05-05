import type { AuditLogicalPrompt, AuditLogUsage } from "../src/app-state.js";
import { parseMateMemoryGenerationResponse, type MateMemoryGenerationParseDefaults } from "./mate-memory-generation-schema.js";
import {
  buildMateMemoryGenerationLogicalPrompt,
  buildMateMemoryGenerationPrompt,
  type MateMemoryGenerationPrompt,
  type MateMemoryGenerationPromptInput,
  type MateMemoryGenerationRelevantMemory,
  type MateMemoryGenerationRelevantProfileItem,
  type MateMemoryGenerationForgottenTombstone,
} from "./mate-memory-generation-prompt.js";
import type { MemoryRuntimeInstructionFile, MemoryRuntimeWorkspaceService } from "./memory-runtime-workspace.js";
import { MateMemoryStorage } from "./mate-memory-storage.js";
import type { MateGrowthEventInput, MateGrowthRunInput, MateGrowthStorage } from "./mate-growth-storage.js";

type TagCatalogEntry = MateMemoryGenerationPromptInput["existingTagCatalog"][number];

export type StructuredGenerationResult = {
  rawText: string;
  parsedJson?: unknown;
  usage?: AuditLogUsage | null;
  provider?: string;
  model?: string;
  threadId?: string | null;
  rawItemsJson?: string;
};

export type RunStructuredGenerationInput = {
  prompt: MateMemoryGenerationPrompt;
  logicalPrompt: AuditLogicalPrompt;
};

export type GetInstructionFilesInput = {
  prompt: MateMemoryGenerationPrompt;
  logicalPrompt: AuditLogicalPrompt;
  recentConversationText: string;
  existingTagCatalog: readonly TagCatalogEntry[];
  relevantMemories: readonly MateMemoryGenerationRelevantMemory[];
  relevantProfileItems: readonly MateMemoryGenerationRelevantProfileItem[];
  forgottenTombstones: readonly MateMemoryGenerationForgottenTombstone[];
  providerIds: readonly string[];
  sourceDefaults?: MateMemoryGenerationParseDefaults;
};

export type MateMemoryGenerationServiceDeps = {
  workspace: MemoryRuntimeWorkspaceService;
  storage: MateMemoryStorage;
  growthStorage?: Pick<MateGrowthStorage, "createRun" | "upsertEvent" | "finishRun" | "failRun">;
  getRelevantMemories?: () => Promise<readonly MateMemoryGenerationRelevantMemory[]>;
  getRelevantProfileItems?: () => Promise<readonly MateMemoryGenerationRelevantProfileItem[]>;
  getForgottenTombstones?: () => Promise<readonly MateMemoryGenerationForgottenTombstone[]>;
  runStructuredGeneration(input: RunStructuredGenerationInput): Promise<StructuredGenerationResult>;
  getTagCatalog(): Promise<readonly TagCatalogEntry[]>;
  getInstructionFiles(input: GetInstructionFilesInput): Promise<readonly MemoryRuntimeInstructionFile[]>;
  getRecentConversationText(): Promise<string>;
};

export type MateMemoryGenerationRunInput = {
  recentConversationText?: string;
  providerIds?: readonly string[];
  sourceDefaults?: MateMemoryGenerationParseDefaults;
  mateName?: string;
  mateSummary?: string;
};

export type MateMemoryGenerationRunResult = {
  skipped: boolean;
  savedCount: number;
  usage?: AuditLogUsage | null;
  provider?: string;
  model?: string;
  threadId?: string | null;
  rawText?: string;
  rawItemsJson?: string;
};

const MATE_GROWTH_TRIGGER_REASON = "mate-memory-generation";
type GrowthTargetSection = MateGrowthEventInput["targetSection"];
type GrowthCandidateSeed = {
  sourceType: MateGrowthEventInput["sourceType"];
  sourceSessionId?: MateGrowthEventInput["sourceSessionId"];
  sourceAuditLogId?: MateGrowthEventInput["sourceAuditLogId"];
  projectDigestId?: MateGrowthEventInput["projectDigestId"];
  growthSourceType: MateGrowthEventInput["growthSourceType"];
  kind: MateGrowthEventInput["kind"];
  targetSection: MateGrowthEventInput["targetSection"];
  statement: MateGrowthEventInput["statement"];
  confidence: number;
  salienceScore: number;
  projectionAllowed?: MateGrowthEventInput["projectionAllowed"];
  sourceGrowthRunId?: MateGrowthEventInput["sourceGrowthRunId"];
};

const GROWTH_TARGET_SECTIONS: readonly GrowthTargetSection[] = ["bond", "work_style", "project_digest", "core", "none"];

function isGrowthTargetSection(value: unknown): value is GrowthTargetSection {
  return typeof value === "string" && GROWTH_TARGET_SECTIONS.includes(value as GrowthTargetSection);
}

function buildGrowthRunInput(seed: GrowthCandidateSeed, runCount: number, provider?: string, model?: string): MateGrowthRunInput {
  return {
    sourceType: seed.sourceType,
    sourceSessionId: seed.sourceSessionId,
    sourceAuditLogId: seed.sourceAuditLogId,
    projectDigestId: seed.projectDigestId,
    triggerReason: MATE_GROWTH_TRIGGER_REASON,
    providerId: provider,
    model,
    candidateCount: runCount,
  };
}

function resolveGrowthTarget(memory: GrowthCandidateSeed): {
  targetSection: GrowthTargetSection;
  projectionAllowed: boolean;
} {
  const targetSection = isGrowthTargetSection(memory.targetSection) ? memory.targetSection : "none";
  const projectionAllowed = targetSection === "none" ? false : (memory.projectionAllowed ?? true);
  return { targetSection, projectionAllowed };
}

function normalizeErrorPreview(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function resolveRunSourceType(sourceType: MateMemoryGenerationParseDefaults["sourceType"]): MateGrowthEventInput["sourceType"] {
  return sourceType === "session" || sourceType === "companion" || sourceType === "manual" || sourceType === "system" || sourceType === "mate_talk"
    ? sourceType
    : "session";
}

function buildFailedGrowthRunInput(
  sourceDefaults: MateMemoryGenerationParseDefaults,
  provider?: string,
  model?: string,
) : MateGrowthRunInput {
  return {
    sourceType: resolveRunSourceType(sourceDefaults.sourceType ?? "session"),
    sourceSessionId: sourceDefaults.sourceSessionId,
    sourceAuditLogId: sourceDefaults.sourceAuditLogId,
    projectDigestId: sourceDefaults.projectDigestId,
    triggerReason: MATE_GROWTH_TRIGGER_REASON,
    providerId: provider,
    model,
    candidateCount: 0,
  };
}

export class MateMemoryGenerationService {
  constructor(private readonly deps: MateMemoryGenerationServiceDeps) {}

  async runOnce(input: MateMemoryGenerationRunInput = {}): Promise<MateMemoryGenerationRunResult> {
    try {
      await this.deps.workspace.prepareRun();
    } catch (error) {
      if (isWorkspaceBusyError(error)) {
        return {
          skipped: true,
          savedCount: 0,
        };
      }
      throw error;
    }

    const stopHeartbeat = this.deps.workspace.startHeartbeat();
    let completed = false;

    try {
      const sourceDefaults = input.sourceDefaults ?? {};
      const recentConversationText = input.recentConversationText ?? await this.deps.getRecentConversationText();
      const providerIds = input.providerIds ?? [];
      const existingTagCatalog = await this.deps.getTagCatalog();
      const parseOptions = {
        ...sourceDefaults,
        sourceType: sourceDefaults.sourceType ?? "session",
        existingTagCatalog,
      };
      const relevantMemories = await (this.deps.getRelevantMemories?.() ?? Promise.resolve([]));
      const relevantProfileItems = await (this.deps.getRelevantProfileItems?.() ?? Promise.resolve([]));
      const forgottenTombstones = await (this.deps.getForgottenTombstones?.() ?? Promise.resolve([]));
      const prompt = buildMateMemoryGenerationPrompt({
        recentConversationText,
        existingTagCatalog,
        relevantMemories,
        relevantProfileItems,
        forgottenTombstones,
        sourceDefaults,
        mateName: input.mateName,
        mateSummary: input.mateSummary,
      });
      const logicalPrompt = buildMateMemoryGenerationLogicalPrompt(prompt);

      await this.deps.workspace.regenerateTemplateInstructionFiles(await this.deps.getInstructionFiles({
        prompt,
        logicalPrompt,
        recentConversationText,
        existingTagCatalog,
        relevantMemories,
        relevantProfileItems,
        forgottenTombstones,
        sourceDefaults,
        providerIds,
      }));

      const generationResult = await this.deps.runStructuredGeneration({
        prompt,
        logicalPrompt,
      });
      let normalized: ReturnType<typeof parseMateMemoryGenerationResponse>;
      try {
        const parsedJson = generationResult.parsedJson ?? JSON.parse(generationResult.rawText);
        normalized = parseMateMemoryGenerationResponse(parsedJson, parseOptions);
      } catch (error) {
        if (this.deps.growthStorage) {
          try {
            const runId = this.deps.growthStorage.createRun(buildFailedGrowthRunInput(
              sourceDefaults,
              generationResult.provider,
              generationResult.model,
            ));
            this.deps.growthStorage.failRun(runId, normalizeErrorPreview(error));
          } catch {
            // fail 追記自体ができなくても元の parse エラーは caller に返す
          }
        }
        throw error;
      }
      const savedMemories = this.deps.storage.saveGeneratedMemories(normalized);
      if (this.deps.growthStorage && normalized.memories.length > 0) {
        const runInput = buildGrowthRunInput(
          normalized.memories[0],
          normalized.memories.length,
          generationResult.provider,
          generationResult.model,
        );
        const runId = this.deps.growthStorage.createRun(runInput);

        try {
          for (const memory of normalized.memories) {
            const target = resolveGrowthTarget(memory);
            this.deps.growthStorage.upsertEvent({
              ...memory,
              sourceGrowthRunId: runId,
              sourceSessionId: memory.sourceSessionId ?? null,
              targetSection: target.targetSection,
              projectionAllowed: target.projectionAllowed,
            });
          }

          this.deps.growthStorage.finishRun(runId);
        } catch (error) {
          this.deps.growthStorage.failRun(runId, normalizeErrorPreview(error));
          throw error;
        }
      }

      completed = true;
      return {
        skipped: false,
        savedCount: savedMemories.length,
        usage: generationResult.usage,
        provider: generationResult.provider,
        model: generationResult.model,
        threadId: generationResult.threadId,
        rawText: generationResult.rawText,
        rawItemsJson: generationResult.rawItemsJson,
      };
    } catch (error) {
      try {
        await this.deps.workspace.failRun(normalizeErrorPreview(error));
      } catch {
        // failRun 自体の失敗は元の例外を隠さない
      }
      throw error;
    } finally {
      await stopHeartbeat();
      if (completed) {
        await this.deps.workspace.completeRun();
      }
    }
  }
}

function isWorkspaceBusyError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("already in use")) {
    return true;
  }
  return false;
}
