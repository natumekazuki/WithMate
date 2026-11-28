import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

/** 実行主体とプロバイダーにひも付く Turn の認可情報。失効状態は既に受理した処理にも共有する。 */
export type ProviderAgentRuntimeTurnHandle = Readonly<{
  actorSessionId: string;
  providerId: string;
  capability: string;
  revocationState: SharedArrayBuffer;
  executionOptions?: SessionExecutionOptions;
}>;

/** 実行主体とプロバイダーの組で、同時に有効な Turn の格納先を決める。 */
function turnKey(actorSessionId: string, providerId: string): string {
  return `${actorSessionId}\0${providerId}`;
}

/** 欠落と長さの不一致を拒否し、同じ長さの UTF-8 バイト列を定時間で比較する。 */
function equalCapability(
  actual: string | null | undefined,
  expected: string,
): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/** 実行主体・プロバイダーごとに一つの Turn を有効にし、その認可と失効を管理する。 */
export class ProviderAgentRuntimeTurnCoordinator {
  readonly #activeByActor = new Map<string, ProviderAgentRuntimeTurnHandle>();

  /** 実行枠を予約し、Turn 専用の認可文字列を発行する。同じ組で実行中なら拒否する。 */
  begin(input: {
    actorSessionId: string;
    providerId: string;
    executionOptions?: SessionExecutionOptions;
  }): ProviderAgentRuntimeTurnHandle {
    const key = turnKey(input.actorSessionId, input.providerId);
    if (this.#activeByActor.has(key)) {
      throw new Error(
        "A provider Session turn is already active for this actor.",
      );
    }
    const handle = Object.freeze({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
      ...(input.executionOptions
        ? { executionOptions: Object.freeze({ ...input.executionOptions }) }
        : {}),
      capability: randomBytes(32).toString("base64url"),
      revocationState: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    });
    this.#activeByActor.set(key, handle);
    return handle;
  }

  /** 現在の実行枠と認可文字列が一致する場合だけ、処理側へ共有ハンドルを渡す。 */
  admit(input: {
    actorSessionId: string;
    providerId: string;
    turnCapability: string | null | undefined;
  }):
    | { ok: true; handle: ProviderAgentRuntimeTurnHandle }
    | { ok: false; reason: "inactive" } {
    const handle = this.#activeByActor.get(
      turnKey(input.actorSessionId, input.providerId),
    );
    if (
      !handle ||
      handle.actorSessionId !== input.actorSessionId ||
      handle.providerId !== input.providerId ||
      !equalCapability(input.turnCapability, handle.capability)
    ) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, handle };
  }

  /** まだ同じハンドルが有効な場合だけ、失効を通知して実行枠を解放する。 */
  end(handle: ProviderAgentRuntimeTurnHandle): void {
    const key = turnKey(handle.actorSessionId, handle.providerId);
    if (this.#activeByActor.get(key) === handle) {
      Atomics.store(new Int32Array(handle.revocationState), 0, 1);
      this.#activeByActor.delete(key);
    }
  }
}
