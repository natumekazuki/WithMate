import {
  getMateMemoryGenerationSettings,
  getProviderAppSettings,
  type AppSettings,
  type MateMemoryGenerationProviderSettings,
} from "../src/provider-settings-state.js";
import type { MateMemoryGenerationPrompt } from "./mate-memory-generation-prompt.js";
import type { ProviderBackgroundAdapter, RunBackgroundStructuredPromptInput } from "./provider-runtime.js";
import type {
  MateMemoryGenerationServiceDeps,
  RunStructuredGenerationInput,
  StructuredGenerationResult,
} from "./mate-memory-generation-service.js";

type FailureCandidate = {
  provider: string;
  model: string;
};

type NoProviderCandidateError = Error & {
  code: "NO_MATE_MEMORY_PROVIDER";
};

export type MateMemoryGenerationRunnerDeps = {
  getAppSettings(): AppSettings;
  getProviderBackgroundAdapter(providerId: string): ProviderBackgroundAdapter;
  getWorkspacePath(): string;
  onProviderFailure?: (error: Error, candidate: FailureCandidate) => void;
};

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

function createNoProviderError(): NoProviderCandidateError {
  const error = new Error("有効な Mate Memory 生成 provider が見つかりませんでした。") as NoProviderCandidateError;
  error.code = "NO_MATE_MEMORY_PROVIDER";
  return error;
}

function toError(value: unknown): Error {
  return isError(value) ? value : new Error(String(value));
}

function normalizeResult(input: {
  candidate: MateMemoryGenerationProviderSettings;
  providerResult: Awaited<ReturnType<ProviderBackgroundAdapter["runBackgroundStructuredPrompt"]>>;
}): StructuredGenerationResult {
  const { candidate, providerResult } = input;

  return {
    rawText: providerResult.rawText,
    parsedJson: providerResult.parsedJson ?? providerResult.output ?? undefined,
    usage: providerResult.usage,
    threadId: providerResult.threadId,
    rawItemsJson: providerResult.rawItemsJson,
    provider: candidate.provider,
    model: candidate.model,
  };
}

function buildBackgroundInput(
  candidate: MateMemoryGenerationProviderSettings,
  prompt: MateMemoryGenerationPrompt,
  appSettings: AppSettings,
  workspacePath: string,
): RunBackgroundStructuredPromptInput {
  return {
    providerId: candidate.provider,
    workspacePath,
    appSettings,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    timeoutMs: candidate.timeoutSeconds * 1000,
    prompt: {
      systemText: prompt.systemText,
      userText: prompt.userText,
      outputSchema: prompt.outputSchema,
    },
  };
}

export function createMateMemoryGenerationRunner(
  deps: MateMemoryGenerationRunnerDeps,
): MateMemoryGenerationServiceDeps["runStructuredGeneration"] {
  return async (input: RunStructuredGenerationInput): Promise<StructuredGenerationResult> => {
    const appSettings = deps.getAppSettings();
    const workspacePath = deps.getWorkspacePath();
    const settings = getMateMemoryGenerationSettings(appSettings);
    let lastFailure: Error | null = null;

    for (const candidate of settings.priorityList) {
      const providerAppSettings = getProviderAppSettings(appSettings, candidate.provider);
      if (!providerAppSettings.enabled) {
        continue;
      }

      const adapter = deps.getProviderBackgroundAdapter(candidate.provider);
      try {
        const structuredInput = buildBackgroundInput(
          candidate,
          input.prompt,
          appSettings,
          workspacePath,
        );
        const providerResult = await adapter.runBackgroundStructuredPrompt(structuredInput);
        return normalizeResult({ candidate, providerResult });
      } catch (error: unknown) {
        const failure = toError(error);
        lastFailure = failure;
        if (deps.onProviderFailure) {
          try {
            deps.onProviderFailure(failure, { provider: candidate.provider, model: candidate.model });
          } catch {
            // ここで onProviderFailure のエラーは握り潰して次候補へ進む
          }
        }
      }
    }

    if (lastFailure) {
      throw lastFailure;
    }

    throw createNoProviderError();
  };
}
