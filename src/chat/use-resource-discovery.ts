import { useEffect, useState } from "react";

import type { DiscoveredCustomAgent, DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { resolveSkillDiscoveryRequest } from "../skills/skill-discovery-request.js";

type ResourceDiscoveryApi = Pick<WithMateWindowApi,
  "listSessionCustomAgents"
  | "listWorkspaceSkills"
>;

export function useResourceDiscovery({
  api,
  activeRunSessionId,
  displayedProvider,
  selectedProvider,
  selectedWorkspacePath,
  auxiliaryProvider,
  appSettingsRevision,
}: {
  api: ResourceDiscoveryApi | null;
  activeRunSessionId: string | null;
  displayedProvider: string | undefined;
  selectedProvider: string | undefined;
  selectedWorkspacePath: string | undefined;
  auxiliaryProvider: string | undefined;
  appSettingsRevision: unknown;
}) {
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [skillListError, setSkillListError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!api || !activeRunSessionId || displayedProvider !== "copilot") {
      setAvailableCustomAgents([]);
      setIsCustomAgentListLoading(false);
      return () => {
        active = false;
      };
    }
    setIsCustomAgentListLoading(true);
    void api.listSessionCustomAgents(activeRunSessionId).then((agents) => {
      if (active) {
        setAvailableCustomAgents(agents);
        setIsCustomAgentListLoading(false);
      }
    }).catch(() => {
      if (active) {
        setAvailableCustomAgents([]);
        setIsCustomAgentListLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [activeRunSessionId, api, displayedProvider]);

  useEffect(() => {
    let active = true;
    const skillDiscoveryRequest = resolveSkillDiscoveryRequest({
      parentProviderId: selectedProvider,
      parentWorkspacePath: selectedWorkspacePath,
      auxiliaryProviderId: auxiliaryProvider,
    });
    if (!api || !skillDiscoveryRequest) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      setSkillListError(null);
      return () => {
        active = false;
      };
    }
    setIsSkillListLoading(true);
    setSkillListError(null);
    void api.listWorkspaceSkills(skillDiscoveryRequest.providerId, skillDiscoveryRequest.workspacePath).then((skills) => {
      if (active) {
        setAvailableSkills(skills);
        setIsSkillListLoading(false);
        setSkillListError(null);
      }
    }).catch(() => {
      if (active) {
        setAvailableSkills([]);
        setIsSkillListLoading(false);
        setSkillListError("Could not load skills. Check Settings or the workspace.");
      }
    });
    return () => {
      active = false;
    };
  }, [api, auxiliaryProvider, appSettingsRevision, selectedProvider, selectedWorkspacePath]);

  return {
    availableSkills,
    availableCustomAgents,
    isCustomAgentListLoading,
    isSkillListLoading,
    skillListError,
  };
}
