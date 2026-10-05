import type { LiveSessionRunState } from "../../../src-shared/session/runtime-state.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";

type LiveState = LiveSessionRunState | null;
export type SessionLiveIngressApi = {
  getLiveSessionRun?: (sessionId: string) => Promise<LiveState>;
  subscribeLiveSessionRun: (listener: (sessionId: string, state: LiveState) => void) => () => void;
};
type Selection = { detail: boolean; apply: (state: LiveState) => void; onError?: (error: unknown) => void };
type Owner = {
  fullState: LiveState | undefined;
  actionState: LiveState;
  controls: SessionRunControls;
  revision: number;
  pending: boolean;
  selections: Set<Selection>;
};
type Ingress = {
  owners: Map<string, Owner>;
  events: Set<(id: string, state: LiveState) => void>;
  dispose: (() => void) | null;
  revision: number;
};
const ingresses = new WeakMap<SessionLiveIngressApi, Ingress>();

export function projectSessionRunControls(state: LiveState) {
  return {
    hasLiveRun: Boolean(state),
    hasAssistantText: Boolean(state?.assistantText),
    hasApprovalRequest: Boolean(state?.approvalRequest),
    hasElicitationRequest: Boolean(state?.elicitationRequest),
    hasBlockingElicitationRequest: Boolean(state?.elicitationRequest && state.elicitationRequest.blocking !== false),
    hasInProgressStep: Boolean(state?.steps.some((step) => step.status === "in_progress")),
    errorMessage: state?.errorMessage ?? "",
    cancellationState: state?.cancellationState,
    inputTurnId: state?.inputAvailable === true && !state.cancellationState ? state.turnId : undefined,
  };
}
export type SessionRunControls = ReturnType<typeof projectSessionRunControls>;

function getIngress(api: SessionLiveIngressApi): Ingress {
  let ingress = ingresses.get(api);
  if (!ingress) {
    ingress = { owners: new Map(), events: new Set(), dispose: null, revision: 0 };
    ingresses.set(api, ingress);
  }
  return ingress;
}

function publish(ingress: Ingress, owner: Owner, state: LiveState): void {
  ++ingress.revision;
  ++owner.revision;
  // Action updaters need identity and pending requests, not conversation detail.
  owner.actionState = state ? { ...state, assistantText: "", reasoningText: "", steps: [], backgroundTasks: [], usage: null } : null;
  owner.controls = projectSessionRunControls(state);
  owner.fullState = [...owner.selections].some((selection) => selection.detail) ? state : undefined;
  for (const selection of owner.selections) selection.apply(state);
}

function connect(api: SessionLiveIngressApi, ingress: Ingress): void {
  if (ingress.dispose) return;
  ingress.dispose = api.subscribeLiveSessionRun((id, state) => {
    const owner = ingress.owners.get(id);
    if (owner) publish(ingress, owner, state);
    for (const listener of ingress.events) listener(id, state);
  });
}

function disconnectUnused(ingress: Ingress): void {
  if (ingress.owners.size || ingress.events.size) return;
  ingress.dispose?.();
  ingress.dispose = null;
}

function loadOwner(api: SessionLiveIngressApi, ingress: Ingress, id: string, owner: Owner): void {
  if (owner.pending || !api.getLiveSessionRun) return;
  owner.pending = true;
  const revision = owner.revision;
  void api.getLiveSessionRun(id).then((state) => {
    if (ingress.owners.get(id) === owner && owner.revision === revision) publish(ingress, owner, state);
  }).catch((error: unknown) => {
    if (ingress.owners.get(id) === owner && owner.revision === revision) {
      for (const selection of owner.selections) selection.onError?.(error);
    }
  }).finally(() => {
    owner.pending = false;
    // A detail surface may join after an event invalidates a controls-only get.
    if (ingress.owners.get(id) === owner && owner.revision !== revision
      && owner.fullState === undefined && [...owner.selections].some((selection) => selection.detail)) {
      loadOwner(api, ingress, id, owner);
    }
  });
}

type SelectionInput<T> = {
  api: SessionLiveIngressApi;
  sessionId: string;
  detail: boolean;
  select: (state: LiveState) => T;
  equal?: (left: T, right: T) => boolean;
  onChange: (value: T) => void;
  onError?: (error: unknown) => void;
};
function subscribeSelection<T>(input: SelectionInput<T>, initial: (owner: Owner) => T): () => void {
  const ingress = getIngress(input.api);
  let owner = ingress.owners.get(input.sessionId);
  const created = !owner;
  if (!owner) {
    owner = { fullState: undefined, actionState: null, controls: projectSessionRunControls(null), revision: 0, pending: false, selections: new Set() };
    ingress.owners.set(input.sessionId, owner);
  }
  let current: T;
  let initialized = false;
  const selection: Selection = {
    detail: input.detail,
    onError: input.onError,
    apply: (state) => {
      const next = input.select(state);
      if (initialized && (input.equal ?? Object.is)(current, next)) return;
      current = next;
      initialized = true;
      input.onChange(next);
    },
  };
  owner.selections.add(selection);
  current = initial(owner);
  initialized = true;
  input.onChange(current);
  connect(input.api, ingress);
  if (created || (input.detail && owner.fullState === undefined)) loadOwner(input.api, ingress, input.sessionId, owner);
  return () => {
    owner.selections.delete(selection);
    if (![...owner.selections].some((subscriber) => subscriber.detail)) owner.fullState = undefined;
    if (!owner.selections.size) ingress.owners.delete(input.sessionId);
    disconnectUnused(ingress);
  };
}

export function subscribeSessionLiveSelection<T>(input: Omit<SelectionInput<T>, "detail">): () => void {
  return subscribeSelection({ ...input, detail: true }, (owner) => input.select(owner.fullState ?? null));
}

export function subscribeSessionRunControls(input: {
  api: SessionLiveIngressApi;
  sessionId: string;
  onChange: (controls: SessionRunControls) => void;
}): () => void {
  return subscribeSelection({ ...input, detail: false, select: projectSessionRunControls,
    equal: (left, right) => (Object.keys(left) as Array<keyof SessionRunControls>).every((key) => left[key] === right[key]),
  }, (owner) => owner.controls);
}

/** Event observers do not retain payloads or create snapshot owners. */
export function subscribeSessionLiveEvents(api: SessionLiveIngressApi, listener: (id: string, state: LiveState) => void): () => void {
  const ingress = getIngress(api);
  ingress.events.add(listener);
  connect(api, ingress);
  return () => { ingress.events.delete(listener); disconnectUnused(ingress); };
}

export function getSessionLiveRevision(api: SessionLiveIngressApi): number {
  return getIngress(api).revision;
}

export function updateSessionLiveState(api: SessionLiveIngressApi, id: string, update: OwnedLiveSessionRunState | ((current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState)): void {
  const ingress = getIngress(api);
  const owner = ingress.owners.get(id);
  if (!owner) return;
  const previous = { ownerSessionId: id, state: owner.fullState ?? owner.actionState };
  const next = typeof update === "function" ? update(previous) : update;
  if (next === previous || next.ownerSessionId !== id) return;
  publish(ingress, owner, next.state);
}
