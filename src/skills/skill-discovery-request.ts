/** スキル探索に使う実行 Provider と親 Session のワークスペース。 */
export type SkillDiscoveryRequest = {
  providerId: string;
  workspacePath: string;
};

/** 親のワークスペースと、Auxiliary があればその Provider を使う。必要な値が揃わなければ探索しない。 */
export function resolveSkillDiscoveryRequest(input: {
  parentProviderId?: string | null;
  parentWorkspacePath?: string | null;
  auxiliaryProviderId?: string | null;
}): SkillDiscoveryRequest | null {
  const providerId = input.auxiliaryProviderId ?? input.parentProviderId;
  const workspacePath = input.parentWorkspacePath;
  if (!providerId || !workspacePath) {
    return null;
  }

  return {
    providerId,
    workspacePath,
  };
}
