import type { AuditLogicalPrompt, AuditLogUsage } from "../src/app-state.js";
import { parseMateMemoryGenerationResponse, type MateMemoryGenerationParseDefaults } from "./mate-memory-generation-schema.js";
import {
  buildMateMemoryGenerationLogicalPrompt,
  buildMateMemoryGenerationPrompt,
  type MateMemoryGenerationPrompt,
  type MateMemoryGenerationPromptInput,
} from "./mate-memory-generation-prompt.js";
import type { MemoryRuntimeInstructionFile, MemoryRuntimeWorkspaceService } from "./memory-runtime-workspace.js";
import { MateMemoryStorage } from "./mate-memory-storage.js";

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
  providerIds: readonly string[];
  sourceDefaults?: MateMemoryGenerationParseDefaults;
};

export type MateMemoryGenerationServiceDeps = {
  workspace: MemoryRuntimeWorkspaceService;
  storage: MateMemoryStorage;
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

    try {
      const sourceDefaults = input.sourceDefaults ?? {};
      const recentConversationText = input.recentConversationText ?? await this.deps.getRecentConversationText();
      const providerIds = input.providerIds ?? [];
      const existingTagCatalog = await this.deps.getTagCatalog();
      const prompt = buildMateMemoryGenerationPrompt({
        recentConversationText,
        existingTagCatalog,
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
        sourceDefaults,
        providerIds,
      }));

      const generationResult = await this.deps.runStructuredGeneration({
        prompt,
        logicalPrompt,
      });
      const parsedJson = generationResult.parsedJson ?? JSON.parse(generationResult.rawText);
      const normalized = parseMateMemoryGenerationResponse(parsedJson, sourceDefaults);
      const savedMemories = this.deps.storage.saveGeneratedMemories(normalized);

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
    } finally {
      await this.deps.workspace.completeRun();
    }
  }
}

function isWorkspaceBusyError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes("already in use")) {
    return true;
  }
  return false;
}
