export type SkillDiscoveryRequest = {
  providerId: string;
  workspacePath: string;
};

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
