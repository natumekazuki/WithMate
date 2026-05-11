import {
  getMateMemoryGenerationSettings,
  getProviderAppSettings,
  type AppSettings,
  type MateMemoryGenerationProviderSettings,
} from "../src/provider-settings-state.js";
import { DEFAULT_REASONING_EFFORT, type ModelReasoningEffort } from "../src/model-catalog.js";
import type { MateGrowthSettings } from "../src/mate/mate-state.js";
import type { MateMemoryGenerationPrompt } from "./mate-memory-generation-prompt.js";
import {
  getMateTalkBackgroundStructuredPromptCapability,
  type ProviderBackgroundAdapter,
  type RunBackgroundStructuredPromptInput,
} from "./provider-runtime.js";
import type {
  MateGrowthModelPort,
  MateGrowthModelPortInput,
  MateGrowthModelPortResult,
} from "./mate-growth-model-port.js";

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
  getMateGrowthSettings(): MateGrowthSettings | null;
  onProviderFailure?: (error: Error, candidate: FailureCandidate) => void;
};

type RunnerCandidate = {
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  depth: string;
  timeoutSeconds: number;
};

const REASONING_EFFORT_SET = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function normalizeReasoningEffort(value: unknown, fallback: ModelReasoningEffort): ModelReasoningEffort {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return fallback;
  }

  if (REASONING_EFFORT_SET.has(normalized as ModelReasoningEffort)) {
    return normalized as ModelReasoningEffort;
  }

  return fallback;
}

function selectTimeoutSeconds(
  candidates: ReadonlyArray<MateMemoryGenerationProviderSettings>,
  provider: string,
  model: string,
): number {
  return candidates.find((candidate) => candidate.provider === provider && candidate.model === model)?.timeoutSeconds
    ?? candidates.find((candidate) => candidate.provider === provider)?.timeoutSeconds
    ?? candidates[0]?.timeoutSeconds
    ?? 30;
}

function buildCandidateFromAppSettings(
  appCandidates: ReadonlyArray<MateMemoryGenerationProviderSettings>,
): RunnerCandidate[] {
  return appCandidates.map((candidate) => ({
    provider: candidate.provider,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    depth: candidate.reasoningEffort,
    timeoutSeconds: candidate.timeoutSeconds,
  }));
}

function buildCandidatesFromGrowthSettings(
  growthSettings: MateGrowthSettings,
  appCandidates: ReadonlyArray<MateMemoryGenerationProviderSettings>,
): RunnerCandidate[] {
  const candidates = growthSettings.modelPreferences
    .map((preference, index) => ({ preference, index }))
    .filter((entry) => entry.preference.purpose === "memory_candidate" && entry.preference.enabled)
    .sort((left, right) => {
      if (left.preference.priority === right.preference.priority) {
        return left.index - right.index;
      }

      return left.preference.priority - right.preference.priority;
    })
    .map((entry) => {
      const reasoningEffort = normalizeReasoningEffort(entry.preference.depth, DEFAULT_REASONING_EFFORT);
      return {
        provider: entry.preference.provider,
        model: entry.preference.model,
        reasoningEffort,
        depth: reasoningEffort,
        timeoutSeconds: selectTimeoutSeconds(
          appCandidates,
          entry.preference.provider,
          entry.preference.model,
        ),
      };
    });

  return candidates;
}

function buildRunnerCandidates(
  appSettings: AppSettings,
  getMateGrowthSettings: MateMemoryGenerationRunnerDeps["getMateGrowthSettings"],
): RunnerCandidate[] {
  const appCandidates = getMateMemoryGenerationSettings(appSettings).priorityList;
  const appRunnerCandidates = buildCandidateFromAppSettings(appCandidates);
  const growthSettings = getMateGrowthSettings();
  const growthCandidates = growthSettings
    ? buildCandidatesFromGrowthSettings(growthSettings, appCandidates)
    : [];

  return growthCandidates.length > 0
    ? [...growthCandidates, ...appRunnerCandidates]
    : appRunnerCandidates;
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

function createNoProviderError(): NoProviderCandidateError {
  const error = new Error("有効な Mate Memory 生成 provider が見つかりませんでした。") as NoProviderCandidateError;
  error.code = "NO_MATE_MEMORY_PROVIDER";
  return error;
}

function assertMemoryCandidatePurpose(input: MateGrowthModelPortInput): void {
  if (input.purpose !== "memory_candidate") {
    throw new Error(`Mate Memory 生成 runner は ${input.purpose} purpose に対応していません。`);
  }
}

function toError(value: unknown): Error {
  return isError(value) ? value : new Error(String(value));
}

function normalizeResult(input: {
  candidate: RunnerCandidate;
  providerResult: Awaited<ReturnType<ProviderBackgroundAdapter["runBackgroundStructuredPrompt"]>>;
}): MateGrowthModelPortResult {
  const { candidate, providerResult } = input;

  return {
    rawText: providerResult.rawText,
    parsedJson: providerResult.parsedJson ?? providerResult.structuredOutput ?? providerResult.output ?? undefined,
    usage: providerResult.usage,
    threadId: providerResult.threadId,
    rawItemsJson: providerResult.rawItemsJson,
    provider: candidate.provider,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    depth: candidate.reasoningEffort,
  };
}

function buildBackgroundInput(
  candidate: RunnerCandidate,
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
): MateGrowthModelPort {
  return {
    async runStructuredGeneration(input: MateGrowthModelPortInput): Promise<MateGrowthModelPortResult> {
      const appSettings = deps.getAppSettings();
      const candidates = buildRunnerCandidates(appSettings, deps.getMateGrowthSettings);
      const workspacePath = deps.getWorkspacePath();
      let lastFailure: Error | null = null;

      assertMemoryCandidatePurpose(input);
      void input.logicalPrompt;

      for (const candidate of candidates) {
        const providerAppSettings = getProviderAppSettings(appSettings, candidate.provider);
        if (!providerAppSettings.enabled) {
          continue;
        }

        try {
          const adapter = deps.getProviderBackgroundAdapter(candidate.provider);
          const capability = getMateTalkBackgroundStructuredPromptCapability(adapter);
          if (!capability.compatible) {
            throw new Error(
              `provider ${candidate.provider} の background structured prompt が未対応です: ${capability.reasons.join(", ")}`,
            );
          }

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
    },
  };
}
