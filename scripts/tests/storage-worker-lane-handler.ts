import type { StorageWorkerCommandHandlers } from "../../src-electron/storage-worker-dispatcher.js";
import type { StorageWorkerEntryData } from "../../src-electron/storage-worker-protocol.js";

type LaneState = { gate: Promise<void>; release: (() => void) | null };

const laneStates = new Map<string, LaneState>();
let started = 0;
let completed = 0;

function resetGate(store: string): LaneState {
  let releaseResolver: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const state: LaneState = { gate, release: releaseResolver };
  laneStates.set(store, state);
  return state;
}

function laneState(store: string): LaneState {
  return laneStates.get(store) ?? resetGate(store);
}

for (const store of ["character", "mate"]) {
  resetGate(store);
}

function release(store: string): void {
  const state = laneState(store);
  state.release?.();
  state.release = null;
}

function waitFor(store: string, externalRelease: Int32Array | null): Promise<void> {
  const gate = laneState(store).gate;
  if (store !== "mate" || !externalRelease) return gate;
  return new Promise<void>((resolve) => {
    let settled = false;
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

function resetAfterCompletion(store: string): void {
  resetGate(store);
}

function storeName(payload: unknown): string {
  const input = payload as { store?: unknown };
  return typeof input.store === "string" ? input.store : "";
}

function assertKnownStore(store: string): void {
  if (store !== "character" && store !== "mate") {
    throw new Error(`unexpected store: ${store}`);
  }
}

export function createStorageWorkerCommandHandlers(entryData: StorageWorkerEntryData): StorageWorkerCommandHandlers {
  const externalReleaseBuffer = (entryData as StorageWorkerEntryData & { laneReleaseBuffer?: SharedArrayBuffer }).laneReleaseBuffer;
  const externalRelease = externalReleaseBuffer ? new Int32Array(externalReleaseBuffer) : null;
  return {
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
    release: (payload) => {
      release(storeName(payload));
      return true;
    },
    state: () => ({ started, completed }),
  };
}
