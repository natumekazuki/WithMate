import type { AuditLogicalPrompt } from "../src/app-state.js";
import type { MateMemoryGenerationPrompt } from "./mate-memory-generation-prompt.js";
import type { MemoryRuntimeInstructionFile } from "./memory-runtime-workspace.js";
import { resolveProviderInstructionFilePath } from "./mate-provider-instruction-sync.js";

export type MateMemoryRuntimeInstructionMetadata = {
  appName?: string;
  mateName?: string;
  mateSummary?: string;
};

export type BuildMateMemoryRuntimeInstructionFilesInput = {
  providerIds: readonly string[];
  prompt: MateMemoryGenerationPrompt;
  logicalPrompt: AuditLogicalPrompt;
  metadata?: MateMemoryRuntimeInstructionMetadata;
  providerInstructionContents?: Readonly<Record<string, string>>;
};

const RESERVED_SECRETS = [
  "API key",
  "APIキー",
  "API token",
  "token",
  "password",
  "パスワード",
  "secret",
  "path",
  "URL",
];

export function buildMateMemoryRuntimeInstructionFiles(
  input: BuildMateMemoryRuntimeInstructionFilesInput,
): readonly MemoryRuntimeInstructionFile[] {
  const instructionFiles: MemoryRuntimeInstructionFile[] = [];
  const seen = new Set<string>();

  for (const providerId of input.providerIds) {
    const relativePath = resolveProviderInstructionFilePath(providerId);
    if (seen.has(relativePath)) {
      continue;
    }

    const normalizedProviderId = providerId.trim().toLowerCase();
    const providerContent = input.providerInstructionContents?.[normalizedProviderId]
      ?? buildDefaultMateMemoryRuntimeInstructionText({
        providerId: normalizedProviderId,
        prompt: input.prompt,
        logicalPrompt: input.logicalPrompt,
        metadata: input.metadata,
      });

    seen.add(relativePath);
    instructionFiles.push({
      relativePath,
      content: providerContent,
    });
  }

  return instructionFiles;
}

function buildDefaultMateMemoryRuntimeInstructionText(input: {
  providerId: string;
  prompt: MateMemoryGenerationPrompt;
  logicalPrompt: AuditLogicalPrompt;
  metadata?: MateMemoryRuntimeInstructionMetadata;
}): string {
  const appName = input.metadata?.appName?.trim() || "WithMate";
  const mateName = input.metadata?.mateName?.trim() || "(指定なし)";
  const mateSummary = input.metadata?.mateSummary?.trim() || "(指定なし)";
  const hasOutputSchema = Boolean(input.prompt.outputSchema);
  const hasLogicalPrompt = input.logicalPrompt.composedText.trim().length > 0;

  return [
    `# ${appName} Mate Memory Runtime Instructions`,
    `## Target: ${input.providerId}`,
    "",
    "- この workspace は Memory 生成専用です。",
    "- DB 保存前提のため、秘密情報/API key/password/token/path/URL などは memory として返さないでください。",
    "- output は指定 schema に厳密準拠し、structured output のみ（JSON）を返してください。",
    "- ファイル編集は禁止。生成結果は structured output のみを返し、ファイルへの書き戻しは行わない。",
    "",
    "## Context",
    `- Mate name: ${mateName}`,
    `- Mate summary: ${mateSummary}`,
    `- Structured output schema supplied: ${hasOutputSchema ? "yes" : "no"}`,
    `- Runtime prompt supplied: ${hasLogicalPrompt ? "yes" : "no"}`,
    "- 生成対象は runtime prompt で渡されます。このファイルへ入力本文を書き戻さないでください。",
    "",
    "## Forbidden",
    `- 次の語を含む内容を保存候補に含めない: ${RESERVED_SECRETS.join(", ")}`,
    "- repo 外の絶対パスは含めない。",
  ].join("\n");
}
