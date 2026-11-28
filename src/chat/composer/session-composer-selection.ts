import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
} from "../../../src-shared/session/runtime-state.js";

/** 選択中のエージェント表示を解決するためのプロバイダーと保存済みの名前。 */
type AgentSelectionSession = {
  provider: string;
  customAgentName: string;
};

/** スキル検索結果に表示する名前、出所・説明、および参照元パスを含むツールチップ。 */
export type SkillMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

/** カスタムエージェント検索結果の表示名、出所・説明、および参照元パスを含むツールチップ。 */
export type CustomAgentMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

/** 選択欄に表示するエージェント名と、表示対象がある場合の補足。 */
export type SelectedCustomAgentDisplay = {
  label: string;
  title?: string;
};

/** スキル指示を挿入した下書きとキャレット、挿入後に適用する操作欄の状態。 */
export type SkillPromptInsertionState = {
  draft: string;
  caret: number;
  isActionDockPinnedExpanded: true;
  isSkillPickerOpen: false;
};

/** 操作欄で開閉を切り替えるピッカーの種別。 */
export type ComposerPickerToggleTarget = "agent" | "skill";

/** エージェントとスキルの各ピッカーの開閉状態。 */
export type ComposerPickerOpenState = {
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
};

/** 指定ピッカーの開閉を反転し、もう一方は必ず閉じる。 */
export function buildExclusiveComposerPickerToggleState(
  target: ComposerPickerToggleTarget,
  isTargetPickerOpen: boolean,
): ComposerPickerOpenState {
  if (target === "agent") {
    return {
      isAgentPickerOpen: !isTargetPickerOpen,
      isSkillPickerOpen: false,
    };
  }

  return {
    isAgentPickerOpen: false,
    isSkillPickerOpen: !isTargetPickerOpen,
  };
}

/** Codexにはスキル参照を、Claudeで出所が分かる場合は選択元のSKILL.mdを明示する指示を返す。 */
export function buildSkillPromptSnippet(
  providerId: string,
  skillName: string,
  sourcePath?: string,
): string {
  if (providerId === "codex") return `$${skillName}`;
  if (providerId === "claude" && sourcePath) {
    return `Use the skill "${skillName}" from "${sourcePath}/SKILL.md" for this task.`;
  }
  return `Use the skill "${skillName}" for this task.`;
}

/** スキル指示を既存本文の前へ追加し、入力末尾にキャレットを置いてピッカーを閉じる。 */
export function buildSkillPromptInsertionState(
  providerId: string,
  skillName: string,
  draft: string,
  sourcePath?: string,
): SkillPromptInsertionState {
  const snippet = buildSkillPromptSnippet(providerId, skillName, sourcePath);
  const trimmedDraft = draft.trimStart();
  const nextDraft = trimmedDraft
    ? `${snippet}\n\n${trimmedDraft}`
    : `${snippet}\n`;

  return {
    draft: nextDraft,
    caret: nextDraft.length,
    isActionDockPinnedExpanded: true,
    isSkillPickerOpen: false,
  };
}

/** スキルの検索結果用に、名前、出所と任意の説明、パスを含むツールチップを組み立てる。 */
export function buildSkillMatchDisplay(
  skill: DiscoveredSkill,
): SkillMatchDisplay {
  return {
    primaryLabel: skill.name,
    secondaryLabel: `${skill.sourceLabel}${skill.description ? ` · ${skill.description}` : ""}`,
    title: `${skill.name}\n${skill.sourcePath}`,
  };
}

/** 表示名がなければ登録名を使い、カスタムエージェントの出所と参照元を表示用に組み立てる。 */
export function buildCustomAgentMatchDisplay(
  agent: DiscoveredCustomAgent,
): CustomAgentMatchDisplay {
  return {
    primaryLabel: agent.displayName || agent.name,
    secondaryLabel: `${agent.sourceLabel}${agent.description ? ` · ${agent.description}` : ""}`,
    title: `${agent.displayName || agent.name}\n${agent.sourcePath}`,
  };
}

/** Copilotでの現在の選択を表示し、検出一覧にない保存済みエージェント名も表示に残す。 */
export function buildSelectedCustomAgentDisplay(
  session: AgentSelectionSession | null,
  selectedAgent: DiscoveredCustomAgent | null,
): SelectedCustomAgentDisplay {
  if (!session || session.provider !== "copilot") {
    return {
      label: "",
    };
  }

  if (!session.customAgentName.trim()) {
    return {
      label: "Default Agent",
      title: "Use the default Copilot agent",
    };
  }

  if (selectedAgent) {
    return {
      label: selectedAgent.displayName || selectedAgent.name,
      title: `${selectedAgent.displayName || selectedAgent.name}\n${selectedAgent.sourcePath}`,
    };
  }

  return {
    label: session.customAgentName.trim(),
    title: session.customAgentName.trim(),
  };
}
