import type { DiscoveredCustomAgent, DiscoveredSkill } from "./runtime-state.js";

type AgentSelectionSession = {
  provider: string;
  customAgentName: string;
};

export type SkillMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type CustomAgentMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

export type SelectedCustomAgentDisplay = {
  label: string;
  title?: string;
};

export type SkillPromptInsertionState = {
  draft: string;
  caret: number;
  isActionDockPinnedExpanded: true;
  isSkillPickerOpen: false;
};

export type ComposerPickerToggleTarget = "agent" | "skill";

export type ComposerPickerOpenState = {
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
};

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

export function buildSkillPromptSnippet(providerId: string, skillName: string): string {
  return providerId === "codex"
    ? `$${skillName}`
    : `Use the skill "${skillName}" for this task.`;
}

export function buildSkillPromptInsertionState(
  providerId: string,
  skillName: string,
  draft: string,
): SkillPromptInsertionState {
  const snippet = buildSkillPromptSnippet(providerId, skillName);
  const trimmedDraft = draft.trimStart();
  const nextDraft = trimmedDraft ? `${snippet}\n\n${trimmedDraft}` : `${snippet}\n`;

  return {
    draft: nextDraft,
    caret: nextDraft.length,
    isActionDockPinnedExpanded: true,
    isSkillPickerOpen: false,
  };
}

export function buildSkillMatchDisplay(skill: DiscoveredSkill): SkillMatchDisplay {
  return {
    primaryLabel: skill.name,
    secondaryLabel: `${skill.sourceLabel}${skill.description ? ` · ${skill.description}` : ""}`,
    title: `${skill.name}\n${skill.sourcePath}`,
  };
}

export function buildCustomAgentMatchDisplay(agent: DiscoveredCustomAgent): CustomAgentMatchDisplay {
  return {
    primaryLabel: agent.displayName || agent.name,
    secondaryLabel: `${agent.sourceLabel}${agent.description ? ` · ${agent.description}` : ""}`,
    title: `${agent.displayName || agent.name}\n${agent.sourcePath}`,
  };
}

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
      title: "Copilot の標準 agent を使う",
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
