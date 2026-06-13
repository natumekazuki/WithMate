import type { MateProfile, MateTalkTurnInput, MateTalkTurnResult } from "../src/mate/mate-state.js";
import type { ModelReasoningEffort } from "../src/model-catalog.js";

export type MateTalkServiceDeps = {
  getMateProfile(): MateProfile | null;
  getMateProfileContextText?(profile: MateProfile): string | null | Promise<string | null>;
  generateAssistantMessage?: (input: {
    userMessage: string;
    provider?: string;
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
    mateProfile: {
      id: string;
      displayName: string;
      description: string;
      themeMain: string;
      themeSub: string;
      contextText?: string;
    };
    attachments?: MateTalkTurnInput["attachments"];
    additionalDirectories?: MateTalkTurnInput["additionalDirectories"];
    approvalMode?: MateTalkTurnInput["approvalMode"];
    codexSandboxMode?: MateTalkTurnInput["codexSandboxMode"];
  }) => Promise<string>;
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
    let mateProfileContextText: string | null | undefined;
    try {
      mateProfileContextText = this.deps.getMateProfileContextText
        ? await this.deps.getMateProfileContextText(profile)
        : null;
    } catch {
      mateProfileContextText = null;
    }
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

    const assistantMessageRaw = await (this.deps.generateAssistantMessage?.({
      userMessage,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.additionalDirectories ? { additionalDirectories: input.additionalDirectories } : {}),
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      ...(input.codexSandboxMode ? { codexSandboxMode: input.codexSandboxMode } : {}),
      mateProfile,
    }) ?? Promise.resolve(MateTalkService.fallbackMessage));
    const assistantMessage = assistantMessageRaw.trim() || MateTalkService.fallbackMessage;

    return {
      mateId: profile.id,
      userMessage,
      assistantMessage,
      createdAt,
    };
  }
}
