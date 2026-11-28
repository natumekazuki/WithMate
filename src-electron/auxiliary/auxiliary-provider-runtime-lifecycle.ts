import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 保存前後でプロバイダーの実行スレッドを無効化すべきか比較する項目。 */
type AuxiliaryRuntimeIdentity = Pick<
  AuxiliarySession,
  "id" | "provider" | "catalogRevision" | "model" | "reasoningEffort"
>;

/** プロバイダー、カタログ版、モデル、推論深度のいずれかが保存結果で変わったか判定する。 */
function hasProviderRuntimeIdentityChanged(
  current: AuxiliaryRuntimeIdentity,
  updated: AuxiliaryRuntimeIdentity,
): boolean {
  return (
    current.provider !== updated.provider ||
    current.catalogRevision !== updated.catalogRevision ||
    current.model !== updated.model ||
    current.reasoningEffort !== updated.reasoningEffort
  );
}

/** 実行中の変更を拒否し、保存後に実行の識別情報が変わった場合だけ紐付けを失効させ旧スレッドを無効化する。 */
export async function updateAuxiliarySessionWithProviderRuntimeLifecycle(input: {
  session: AuxiliarySession;
  isRunInFlight: (sessionId: string) => boolean;
  getAuxiliarySession: (
    sessionId: string,
  ) => Awaitable<AuxiliarySession | null>;
  updateAuxiliarySession: (
    session: AuxiliarySession,
  ) => Awaitable<AuxiliarySession>;
  revokeSessionAgentRuntimeBindings: (sessionId: string) => void;
  invalidateProviderSessionThread: (
    providerId: string,
    sessionId: string,
  ) => Promise<void>;
}): Promise<AuxiliarySession> {
  if (input.isRunInFlight(input.session.id)) {
    throw new Error("A running Auxiliary Session cannot be updated.");
  }
  const current = await input.getAuxiliarySession(input.session.id);
  const updated = await input.updateAuxiliarySession(input.session);
  if (!current || !hasProviderRuntimeIdentityChanged(current, updated)) {
    return updated;
  }

  input.revokeSessionAgentRuntimeBindings(updated.id);
  await input.invalidateProviderSessionThread(current.provider, updated.id);
  return updated;
}
