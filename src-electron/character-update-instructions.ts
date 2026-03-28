export function getCharacterUpdateInstructionFileName(providerId: string): string {
  return providerId === "copilot" ? "copilot-instructions.md" : "AGENTS.md";
}

export function buildCharacterUpdateInstructionText(characterName: string): string {
  return [
    "# Character Update Workspace",
    "",
    `- この workspace は ${characterName} の character.md を改善するために使う`,
    "- 主な編集対象は character.md と character-notes.md とする",
    "- ユーザーの今回の指示を最優先する",
    "- 明示された外部資料や wiki があれば、それを優先して反映する",
    "- 現在の character.md、character-notes.md、ユーザーが貼り付けた Character Memory extract を材料として使う",
    "- 実行時 prompt に直接効く定義は character.md に書く",
    "- 採用理由、出典、未確定事項、改稿メモは character-notes.md に書く",
    "- 根拠が弱い内容は断定せず、必要なら保留や TODO に留める",
    "- unrelated file は編集しない",
    "- 変更後は、何をどう更新したかを短く説明する",
  ].join("\n");
}

export function buildCharacterNotesTemplate(characterName: string): string {
  return [
    `# ${characterName} Notes`,
    "",
    "## Evidence & Notes",
    "- 採用した定義の根拠を書く",
    "",
    "## Sources",
    "- [high] 参照元",
    "",
    "## Open Questions",
    "- 未確定事項を書く",
    "",
    "## Revision Notes",
    "- 初回作成",
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
