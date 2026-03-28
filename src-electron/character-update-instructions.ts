export function getCharacterUpdateInstructionFileName(providerId: string): string {
  return providerId === "copilot" ? "copilot-instructions.md" : "AGENTS.md";
}

export function buildCharacterUpdateInstructionText(characterName: string): string {
  return [
    "# Character Update Workspace",
    "",
    `- この workspace は ${characterName} の character.md を改善するために使う`,
    "- 主な編集対象は character.md とする",
    "- ユーザーの今回の指示を最優先する",
    "- 明示された外部資料や wiki があれば、それを優先して反映する",
    "- 現在の character.md と、ユーザーが貼り付けた Character Memory extract を材料として使う",
    "- 根拠が弱い内容は断定せず、必要なら保留や TODO に留める",
    "- unrelated file は編集しない",
    "- 変更後は、何をどう更新したかを短く説明する",
  ].join("\n");
}

export function buildCharacterUpdateInstructionFiles(characterName: string): Array<{
  fileName: string;
  content: string;
}> {
  const content = buildCharacterUpdateInstructionText(characterName);
  return [
    { fileName: "AGENTS.md", content },
    { fileName: "copilot-instructions.md", content },
  ];
}
