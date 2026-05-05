import type { MateProfile, MateTalkTurnInput, MateTalkTurnResult } from "../src/mate-state.js";

export type ScheduleMateTalkMemoryGenerationInput = {
  userMessage: string;
  assistantText: string;
};

export type MateTalkServiceDeps = {
  getMateProfile(): MateProfile | null;
  getMateProfileContextText?(profile: MateProfile): string | null | Promise<string | null>;
  generateAssistantMessage?: (input: {
    userMessage: string;
    mateProfile: {
      id: string;
      displayName: string;
      description: string;
      themeMain: string;
      themeSub: string;
      contextText?: string;
    };
  }) => Promise<string>;
  scheduleMemoryGeneration?(input: ScheduleMateTalkMemoryGenerationInput): unknown;
  onMemoryGenerationScheduleError?(error: unknown): void | Promise<void>;
  now?(): Date;
};

export class MateTalkService {
  private static readonly fallbackMessage = "受け取ったよ。";

  constructor(private readonly deps: MateTalkServiceDeps) {}

  async runTurn(input: MateTalkTurnInput): Promise<MateTalkTurnResult> {
    const userMessage = input.message.trim();
    if (!userMessage) {
      throw new Error("メッセージを入力してね。");
    }

    const profile = this.deps.getMateProfile();
    if (!profile) {
      throw new Error("Mate が見つかりません。");
    }

    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    const mateProfileContextText = this.deps.getMateProfileContextText
      ? await this.deps.getMateProfileContextText(profile)
      : null;
    const normalizedContextText = mateProfileContextText?.trim();
    const includeContextText = normalizedContextText ? normalizedContextText : null;

    const mateProfile = {
      id: profile.id,
      displayName: profile.displayName,
      description: profile.description,
      themeMain: profile.themeMain,
      themeSub: profile.themeSub,
      ...(includeContextText ? { contextText: includeContextText } : {}),
    };

    const assistantMessage = await (this.deps.generateAssistantMessage?.({
      userMessage,
      mateProfile,
    }) ?? Promise.resolve(MateTalkService.fallbackMessage));

    try {
      void Promise.resolve(this.deps.scheduleMemoryGeneration?.({
        userMessage,
        assistantText: assistantMessage,
      })).catch((error) => this.notifyMemoryGenerationScheduleError(error));
    } catch (error) {
      this.notifyMemoryGenerationScheduleError(error);
    }

    return {
      mateId: profile.id,
      userMessage,
      assistantMessage,
      createdAt,
    };
  }

  private notifyMemoryGenerationScheduleError(error: unknown): void {
    try {
      void Promise.resolve(this.deps.onMemoryGenerationScheduleError?.(error)).catch(() => {
        // Memory generation scheduling is background work and must not break the visible turn.
      });
    } catch {
      // Memory generation scheduling is background work and must not break the visible turn.
    }
  }
}
