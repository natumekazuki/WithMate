import type { EventEmitter } from "node:events";

export function observeEmitterErrors(emitter: EventEmitter, onError: () => void): void {
  emitter.on("error", onError);
}

export function replaceWithLateErrorGuard(emitter: EventEmitter): void {
  emitter.removeAllListeners();
  emitter.on("error", ignoreLateError);
}

function ignoreLateError(): void {
  // A destroyed child-process pipe may still report a late error after transport release.
}
