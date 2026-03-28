export function getCharacterUpdateInstructionFileName(providerId: string): string {
  return providerId === "copilot" ? "copilot-instructions.md" : "AGENTS.md";
}

export const CHARACTER_UPDATE_SKILL_NAME = "character-definition-update";
export const CHARACTER_UPDATE_SKILL_DIRECTORY = `skills/${CHARACTER_UPDATE_SKILL_NAME}`;
export const CHARACTER_UPDATE_SKILL_FILE_PATH = `${CHARACTER_UPDATE_SKILL_DIRECTORY}/SKILL.md`;

export function buildCharacterUpdateInstructionText(characterName: string): string {
  return [
    "# Character Update Workspace",
    "",
    `- この workspace は ${characterName} の character 定義を育てるために使う`,
    `- この workspace では ${CHARACTER_UPDATE_SKILL_NAME} skill を最優先で使う`,
    `- 更新手順、外部調査の扱い、自己チェックは ${CHARACTER_UPDATE_SKILL_NAME} skill に従う`,
    "",
    "## Workspace Files",
    "",
    "- 主な編集対象は character.md と character-notes.md の 2 つとする",
    `- 更新作業では workspace 内の ${CHARACTER_UPDATE_SKILL_NAME} skill を前提に進める`,
    "- character.md はコーディングエージェントや対話 AI で使うキャラクターロール定義の正本である",
    "- character-notes.md は更新判断の補助情報であり、prompt の直接入力ではない",
    "",
    "## Prompt Shape",
    "",
    "- character.md は prompt の Character section に入る前提で更新する",
    "- 実行時には app 側が # Character 見出しを付け、その下に character.md 全体がそのまま本文として入る",
    "- そのため character.md 単体で読んでも、キャラクター定義として完結している必要がある",
    "",
    "## Update Policy",
    "",
    "- 明示的に要求されていない unrelated file は編集しない",
    "- character-notes.md には採用理由、出典、未確定事項、改稿メモ、競合する解釈を残す",
    "- Character Memory extract や外部資料を使った場合も、採用理由は character-notes.md に残す",
    "",
    "## 自己チェック",
    "",
    "- 詳細な自己チェック項目は skill に従う",
    "",
    "## 返答",
    "",
    "- 更新後は、何をどう更新したか、未確定事項があるかを短く説明する",
  ].join("\n");
}

export function buildCharacterUpdateSkillMarkdown(): string {
  return [
    "---",
    `name: ${CHARACTER_UPDATE_SKILL_NAME}`,
    "description: character.md と character-notes.md を使ってキャラクター定義を更新する時の固定 workflow。",
    "---",
    "",
    "# Character Definition Update",
    "",
    "## 目的",
    "",
    "- character.md を、コーディングエージェントや対話 AI で使うキャラクターロール定義として改善する",
    "- character-notes.md に、採用理由、出典、未確定事項、改稿履歴を残す",
    "",
    "## 役割分担",
    "",
    "- character.md",
    "  - prompt の Character section にそのまま入る正本",
    "  - 実行時の振る舞い、口調、関係性、判断規則を書く",
    "- character-notes.md",
    "  - 採用理由、出典、未確定事項、競合解釈、改稿履歴を残す",
    "  - prompt の直接入力にはしない",
    "",
    "## 基本ルール",
    "",
    "- まず現在の character.md と character-notes.md を読む",
    "- 既存の定義を無意味に全消ししない",
    "- ユーザーの今回の指示を最優先する",
    "- 調査ログや長い判断メモを character.md に混ぜない",
    "- 根拠が弱い内容は断定せず、必要なら character-notes.md に逃がす",
    "",
    "## 外部調査",
    "",
    "- ユーザーが検索不要と明示していない限り、精度確保に必要なら web や wiki を参照してよい",
    "- 外部資料は 公式、一次情報に近い資料、出典付き wiki を優先する",
    "- 単独の弱い情報源だけで中核定義を更新しない",
    "- 採用した根拠は character-notes.md の Sources や Evidence & Notes に残す",
    "",
    "## 更新手順",
    "",
    "1. ユーザー指示、character.md、character-notes.md を確認する。",
    "2. 必要なら追加の web / wiki / 添付資料を調査する。",
    "3. 維持する定義、更新する定義、未確定事項を分ける。",
    "4. character.md には最終的に採用する定義だけを反映する。",
    "5. character-notes.md に根拠、保留、競合解釈、改稿メモを残す。",
    "6. 変更後は更新内容と未確定事項を短く要約する。",
    "",
    "## character.md で重視すること",
    "",
    "- キャラの中核価値観、感情表現、ユーザーとの距離感、口調、行動原則を安定して再現できること",
    "- 禁止、許可、判断基準、優先順位が分かる粒度で書くこと",
    "- character.md 全体が単体で読んでもキャラクター定義として完結していること",
    "",
    "## 自己チェック",
    "",
    "- 呼称、敬語、距離感、ユーザーとの関係性に矛盾がないか",
    "- 実行可能な規則になっているか",
    "- notes に逃がすべき内容を character.md に混ぜていないか",
    "- 弱い根拠だけで中核定義を変えていないか",
  ].join("\n");
}

export function buildCharacterMarkdownTemplate(characterName: string): string {
  return [
    "---",
    `name: "${characterName}"`,
    'description: "会話上の役割と雰囲気が分かる短い説明"',
    "---",
    "",
    "## Character Overview",
    "- 作品:",
    "- 媒体:",
    "- 会話用途:",
    "",
    "## Core Persona",
    "- 中核となる価値観",
    "- 動機",
    "- 感情の出し方",
    "",
    "## Relationship With User",
    "- ユーザーをどう認識するか",
    "- 呼称",
    "- 距離感",
    "- 信頼の置き方",
    "",
    "## Voice And Style",
    "- 一人称 / 二人称",
    "- 語尾",
    "- 語彙",
    "- 敬語度",
    "- 話し方のテンポ",
    "",
    "## Behavioral Rules",
    "- 判断基準",
    "- 問題解決の型",
    "- 失敗時の振る舞い",
    "- 長期対話で維持したい一貫性",
    "",
    "## Boundaries",
    "- やらないこと",
    "- 崩してはいけない解釈",
    "- 優先順位",
    "",
    "## Example Lines",
    "- [初対面] ...",
    "- [相談] ...",
    "- [失敗時] ...",
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

export function buildCharacterUpdateWorkspaceFiles(characterName: string): Array<{
  fileName: string;
  content: string;
}> {
  return [
    ...buildCharacterUpdateInstructionFiles(characterName),
    { fileName: CHARACTER_UPDATE_SKILL_FILE_PATH, content: buildCharacterUpdateSkillMarkdown() },
  ];
}
