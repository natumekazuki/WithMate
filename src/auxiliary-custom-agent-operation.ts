import type { AuxiliarySession } from "./auxiliary-session-state.js";

export type AuxiliaryCustomAgentSelectionResult =
  | "noop"
  | "unchanged"
  | "updated";

export async function runAuxiliaryCustomAgentSelectionOperation(input: {
  activeSession: Pick<AuxiliarySession, "provider" | "customAgentName"> | null;
  customAgentName: string;
  updateCustomAgent: (customAgentName: string) => Promise<void>;
  closeAgentPicker: () => void;
}): Promise<AuxiliaryCustomAgentSelectionResult> {
  if (!input.activeSession || input.activeSession.provider !== "copilot") {
    return "noop";
  }

  if (input.customAgentName === input.activeSession.customAgentName) {
    input.closeAgentPicker();
    return "unchanged";
  }

  await input.updateCustomAgent(input.customAgentName);
  input.closeAgentPicker();
  return "updated";
}
