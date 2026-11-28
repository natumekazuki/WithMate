import { useEffect, useState } from "react";

import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
} from "../../src-shared/session/runtime-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { resolveSkillDiscoveryRequest } from "../skills/skill-discovery-request.js";

/** リソース候補の取得に使うウィンドウAPIのうち、カスタムエージェントとSkillの一覧だけを取り出す。 */
type ResourceDiscoveryApi = Pick<
  WithMateWindowApi,
  "listSessionCustomAgents" | "listWorkspaceSkills"
>;

/** API・プロバイダー・ワークスペースで取得元を識別するSkill一覧と、その読み込み状態。 */
type SkillList = {
  api: ResourceDiscoveryApi;
  providerId: string;
  workspacePath: string;
  items: DiscoveredSkill[];
  loading: boolean;
  error: string | null;
};

/** 表示中のCopilot Sessionのカスタムエージェントと、選択された探索先のSkillを取得する。
 * Skillの再取得では同一対象の候補を残し、対象が変わると以前の候補や応答を混ぜない。
 */
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
  const [availableCustomAgents, setAvailableCustomAgents] = useState<
    DiscoveredCustomAgent[]
  >([]);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] =
    useState(false);
  const [skillList, setSkillList] = useState<SkillList | null>(null);
  const skillDiscoveryRequest = resolveSkillDiscoveryRequest({
    parentProviderId: selectedProvider,
    parentWorkspacePath: selectedWorkspacePath,
    auxiliaryProviderId: auxiliaryProvider,
  });
  const skillProviderId = skillDiscoveryRequest?.providerId;
  const skillWorkspacePath = skillDiscoveryRequest?.workspacePath;
  const currentSkillList =
    skillList?.api === api &&
    skillList.providerId === skillProviderId &&
    skillList.workspacePath === skillWorkspacePath
      ? skillList
      : null;

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
    void api
      .listSessionCustomAgents(activeRunSessionId)
      .then((agents) => {
        if (active) {
          setAvailableCustomAgents(agents);
          setIsCustomAgentListLoading(false);
        }
      })
      .catch(() => {
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
    if (!api || !skillProviderId || !skillWorkspacePath) {
      setSkillList(null);
      return;
    }
    let active = true;
    const owner = {
      api,
      providerId: skillProviderId,
      workspacePath: skillWorkspacePath,
    };
    setSkillList((previous) => ({
      ...owner,
      loading: true,
      error: null,
      items:
        previous?.api === api &&
        previous.providerId === skillProviderId &&
        previous.workspacePath === skillWorkspacePath
          ? previous.items
          : [],
    }));
    void api.listWorkspaceSkills(skillProviderId, skillWorkspacePath).then(
      (items) => {
        if (active)
          setSkillList({ ...owner, items, loading: false, error: null });
      },
      () => {
        if (active)
          setSkillList(
            (previous) =>
              previous && {
                ...previous,
                loading: false,
                error:
                  "Could not load skills. Check Settings or the workspace.",
              },
          );
      },
    );
    return () => {
      active = false;
    };
  }, [api, appSettingsRevision, skillProviderId, skillWorkspacePath]);

  return {
    availableSkills: currentSkillList?.items ?? [],
    availableCustomAgents,
    isCustomAgentListLoading,
    isSkillListLoading:
      currentSkillList?.loading ?? Boolean(api && skillDiscoveryRequest),
    skillListError: currentSkillList?.error ?? null,
  };
}
