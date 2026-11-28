import {
  ProviderAgentRuntimeTurnCoordinator,
  type ProviderAgentRuntimeTurnHandle,
} from "../providers/provider-agent-runtime-turn-coordinator.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

/** 能動登録の状態と、その操作を許可するプロバイダーのターンを結び付けるハンドル。 */
export type GlossaryProactiveTurnHandle = ProviderAgentRuntimeTurnHandle;

/** ターン開始時の登録上限と、初回の能動登録要求を識別する指紋。 */
type ProactiveTurnState = {
  limit: number | null | undefined;
  requestFingerprint: string | null;
};

/** プロバイダーのターンに紐付けて、能動登録の要求数と登録件数を制限する。 */
export class GlossaryProactiveTurnCoordinator {
  readonly #providerTurns: ProviderAgentRuntimeTurnCoordinator;
  readonly #stateByHandle = new WeakMap<
    GlossaryProactiveTurnHandle,
    ProactiveTurnState
  >();

  /** ターンの有効性と capability の管理を共通のプロバイダー側コーディネーターに委ねる。 */
  constructor(providerTurns: ProviderAgentRuntimeTurnCoordinator) {
    this.#providerTurns = providerTurns;
  }

  /** プロバイダーのターンを開始し、その時点の上限をハンドルに紐付ける。 */
  begin(input: {
    actorSessionId: string;
    providerId: string;
    proactiveCreateLimit: number | null | undefined;
    executionOptions?: SessionExecutionOptions;
  }): GlossaryProactiveTurnHandle {
    const handle = this.#providerTurns.begin({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
      executionOptions: input.executionOptions,
    });
    this.#stateByHandle.set(handle, {
      limit: input.proactiveCreateLimit,
      requestFingerprint: null,
    });
    return handle;
  }

  /** 能動登録の状態を消去し、対応するプロバイダーのターンを終了する。 */
  end(handle: GlossaryProactiveTurnHandle): void {
    this.#stateByHandle.delete(handle);
    this.#providerTurns.end(handle);
  }

  /** 有効なターンの初回要求を記録し、異なる再要求、無効な上限、登録禁止または上限を超えた要求を拒否する。 */
  admit(input: {
    actorSessionId: string;
    providerId: string;
    turnCapability: string | null | undefined;
    requestFingerprint: string;
    entryCount: number;
  }):
    | { ok: true; proactiveCreateLimit: number }
    | {
        ok: false;
        reason:
          "inactive" | "invalid-limit" | "limit-exceeded" | "second-request";
      } {
    const admission = this.#providerTurns.admit(input);
    const state = admission.ok
      ? this.#stateByHandle.get(admission.handle)
      : null;
    if (!admission.ok || !state) {
      return { ok: false, reason: "inactive" };
    }
    if (state.requestFingerprint === null) {
      state.requestFingerprint = input.requestFingerprint;
    } else if (state.requestFingerprint !== input.requestFingerprint) {
      return { ok: false, reason: "second-request" };
    }
    if (
      !Number.isInteger(state.limit) ||
      state.limit === null ||
      state.limit === undefined ||
      state.limit < 0 ||
      state.limit > 100
    ) {
      return { ok: false, reason: "invalid-limit" };
    }
    if (state.limit === 0 || input.entryCount > state.limit) {
      return { ok: false, reason: "limit-exceeded" };
    }
    return { ok: true, proactiveCreateLimit: state.limit };
  }
}
