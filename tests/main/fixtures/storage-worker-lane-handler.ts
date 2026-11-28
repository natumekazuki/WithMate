import type { StorageWorkerCommandHandlers } from "../../../src-electron/storage/storage-worker-dispatcher.js";
import type { StorageWorkerEntryData } from "../../../src-electron/storage/storage-worker-protocol.js";

/** 実行待ちの操作と、その待機を解除するための関数をストアごとに保持する。 */
type LaneState = { gate: Promise<void>; release: (() => void) | null };

const laneStates = new Map<string, LaneState>();
let started = 0;
let completed = 0;

/** 次の操作が改めて待機するよう、未解決のゲートを登録する。 */
function resetGate(store: string): LaneState {
  let releaseResolver: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const state: LaneState = { gate, release: releaseResolver };
  laneStates.set(store, state);
  return state;
}

/** ストアのゲートを取得し、未登録の場合は初回の待機を用意する。 */
function laneState(store: string): LaneState {
  return laneStates.get(store) ?? resetGate(store);
}

for (const store of ["character", "mate"]) {
  resetGate(store);
}

/** 対象ストアのゲートを開き、同じ解除関数への参照を破棄する。 */
function release(store: string): void {
  const state = laneState(store);
  state.release?.();
  state.release = null;
}

/** 通常はゲートを待ち、Mateだけは共有メモリの解除通知でも進める。 */
function waitFor(
  store: string,
  externalRelease: Int32Array | null,
): Promise<void> {
  const gate = laneState(store).gate;
  if (store !== "mate" || !externalRelease) return gate;
  return new Promise<void>((resolve) => {
    let settled = false;
    /** 複数経路からの解除が重なっても、監視停止と解決を一度に限る。 */
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve();
    };
    const timer = setInterval(() => {
      if (Atomics.load(externalRelease, 0) === 1) {
        release(store);
        finish();
      }
    }, 5);
    void gate.then(finish);
  });
}

/** 完了済み操作の解除が、次の待機操作に引き継がれないようにする。 */
function resetAfterCompletion(store: string): void {
  resetGate(store);
}

/** ペイロードから文字列のストア名を取り出し、形式不一致は空名として扱う。 */
function storeName(payload: unknown): string {
  const input = payload as { store?: unknown };
  return typeof input.store === "string" ? input.store : "";
}

/** 待機テストで扱うCharacterとMate以外のストアを拒否する。 */
function assertKnownStore(store: string): void {
  if (store !== "character" && store !== "mate") {
    throw new Error(`unexpected store: ${store}`);
  }
}

/** レーンの並行性を外部から観測・制御するためのワーカーコマンドを組み立てる。 */
export function createStorageWorkerCommandHandlers(
  entryData: StorageWorkerEntryData,
): StorageWorkerCommandHandlers {
  const externalReleaseBuffer = (
    entryData as StorageWorkerEntryData & {
      laneReleaseBuffer?: SharedArrayBuffer;
    }
  ).laneReleaseBuffer;
  const externalRelease = externalReleaseBuffer
    ? new Int32Array(externalReleaseBuffer)
    : null;
  return {
    /** 待機操作は開始・完了を計数し、短い操作はカウンターだけを返す。 */
    "store.call": async (payload) => {
      const input = payload as { store?: string; method?: string };
      if (input.method === "wait") {
        started += 1;
        const store = storeName(payload);
        assertKnownStore(store);
        await waitFor(store, externalRelease);
        completed += 1;
        resetAfterCompletion(store);
        return { started, completed };
      }
      if (input.method === "short") {
        return { started, completed };
      }
      throw new Error(`unexpected method: ${input.method ?? ""}`);
    },
    /** 指定ストアで保留中の操作を先へ進める。 */
    release: (payload) => {
      release(storeName(payload));
      return true;
    },
    /** 待機を発生させずに通算の開始・完了件数を取得する。 */
    state: () => ({ started, completed }),
  };
}
