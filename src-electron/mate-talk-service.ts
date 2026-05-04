import type { MateProfile, MateTalkTurnInput, MateTalkTurnResult } from "../src/mate-state.js";

export type ScheduleMateTalkMemoryGenerationInput = {
  userMessage: string;
  assistantText: string;
};

export type MateTalkServiceDeps = {
  getMateProfile(): MateProfile | null;
  generateAssistantMessage?: (input: {
    userMessage: string;
    mateProfile: {
      id: string;
      displayName: string;
      description: string;
      themeMain: string;
      themeSub: string;
    };
  }) => Promise<string>;
  scheduleMemoryGeneration?(input: ScheduleMateTalkMemoryGenerationInput): void;
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

    const mateProfile = this.deps.getMateProfile();
    if (!mateProfile) {
      throw new Error("Mate が見つかりません。");
    }

    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    const assistantMessage = await (this.deps.generateAssistantMessage?.({
      userMessage,
      mateProfile: {
        id: mateProfile.id,
        displayName: mateProfile.displayName,
        description: mateProfile.description,
        themeMain: mateProfile.themeMain,
        themeSub: mateProfile.themeSub,
      },
    }) ?? Promise.resolve(MateTalkService.fallbackMessage));

    this.deps.scheduleMemoryGeneration?.({
      userMessage,
      assistantText: assistantMessage,
    });

    return {
      mateId: mateProfile.id,
      userMessage,
      assistantMessage,
      createdAt,
    };
  }
}
