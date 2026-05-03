import type { MateProfile, MateTalkTurnInput, MateTalkTurnResult } from "../src/mate-state.js";

export type ScheduleMateTalkMemoryGenerationInput = {
  userMessage: string;
  assistantText: string;
};

export type MateTalkServiceDeps = {
  getMateProfile(): MateProfile | null;
  scheduleMemoryGeneration?(input: ScheduleMateTalkMemoryGenerationInput): void;
  now?(): Date;
};

export class MateTalkService {
  constructor(private readonly deps: MateTalkServiceDeps) {}

  runTurn(input: MateTalkTurnInput): MateTalkTurnResult {
    const userMessage = input.message.trim();
    if (!userMessage) {
      throw new Error("メッセージを入力してね。");
    }

    const mateProfile = this.deps.getMateProfile();
    if (!mateProfile) {
      throw new Error("Mate が見つかりません。");
    }

    const createdAt = (this.deps.now?.() ?? new Date()).toISOString();
    const assistantMessage = "受け取ったよ。";

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
