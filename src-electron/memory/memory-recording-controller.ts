import { setTimeout, clearTimeout } from "node:timers";
import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import type { ProviderAgentRuntimeAuthoritySnapshot } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import type { BackgroundMemoryTarget } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { getMemoryRecordingTrigger, type MemoryRecordingPurpose } from "../../src-shared/memory-recording/memory-recording-frequency.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { BackgroundProductionRuntime, BackgroundRuntimeEvent } from "../providers/background-production-runtime.js";
import { runBackgroundMemoryRegistration } from "./background-memory-registration.js";

const purposes = ["character-memory", "target-memory"] as const;
type Position = { lastStarted: number | null; checking: boolean; dirty: boolean; timer?: ReturnType<typeof setTimeout> };
type Clock = { now(): number; setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>; clearTimeout(timer: ReturnType<typeof setTimeout>): void };
type SourceState = {
  source: BackgroundSourceRef; session: Session; running: boolean; idleSince: number | null;
  initial: { seq: number } | { turn: number }; initializing?: Promise<void>;
  positions: Record<MemoryRecordingPurpose, Position>;
};
const key = (source: Pick<BackgroundSourceRef, "kind" | "sessionId">) => JSON.stringify([source.kind, source.sessionId]);
const sameSource = (a: BackgroundSourceRef, b: BackgroundSourceRef) => a.incarnationId === b.incarnationId
  && (a.kind !== "auxiliary" || (b.kind === "auxiliary" && a.parent.sessionId === b.parent.sessionId && a.parent.incarnationId === b.parent.incarnationId));

/** Frequency boundaries and coalesced triggers only; execution and registration remain shared. */
export class MemoryRecordingController {
  private readonly sources = new Map<string, SourceState>();
  private unsubscribe?: () => void;
  private readonly clock: Clock;

  constructor(private readonly deps: {
    runtime: Pick<BackgroundProductionRuntime, "subscribe" | "prepare" | "calls" | "reportFailure" | "forgetSource">;
    captureSource(source: BackgroundSourceRef): Promise<CapturedBackgroundSource | null>;
    getSettings(): AppSettings | Promise<AppSettings>;
    resolveAuthority(session: Session): ProviderAgentRuntimeAuthoritySnapshot | null;
    readCharacterDefinition(characterId: string): Promise<string>;
    clock?: Clock;
  }) {
    this.clock = deps.clock ?? { now: Date.now, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (timer) => clearTimeout(timer) };
  }

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.deps.runtime.subscribe((event) => this.receive(event));
  }

  stop(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const state of this.sources.values()) this.clearTimers(state);
    this.sources.clear();
  }

  forget(kind: "main" | "auxiliary", sessionId: string): void {
    this.deps.runtime.forgetSource(kind, sessionId);
    for (const [id, state] of this.sources) {
      if ((state.source.kind === kind && state.source.sessionId === sessionId)
        || (kind === "main" && state.source.kind === "auxiliary" && state.source.parent.sessionId === sessionId)) {
        this.clearTimers(state); this.sources.delete(id);
      }
    }
  }

  private current(state: SourceState): boolean { return this.sources.get(key(state.source)) === state; }
  private clearTimers(state: SourceState): void {
    for (const position of Object.values(state.positions)) {
      if (position.timer !== undefined) this.clock.clearTimeout(position.timer);
      position.timer = undefined;
    }
  }

  private receive(event: BackgroundRuntimeEvent): void {
    if (event.kind === "stopped") { this.stop(); return; }
    if (event.kind === "settings_changed") {
      for (const state of this.sources.values()) for (const purpose of purposes) this.check(state, purpose);
      return;
    }
    let state = this.sources.get(key(event.source));
    if (state && !sameSource(state.source, event.source)) {
      this.forget(event.source.kind, event.source.sessionId); state = undefined;
    }
    if (!state) {
      if (event.kind === "run_state" && !event.running) return;
      state = { source: event.source, session: event.session,
        running: event.kind === "run_state" ? event.running : false,
        idleSince: event.kind === "terminal_saved" ? this.clock.now() : null,
        // The saved start contains the new user message, never its future assistant reply.
        // A first terminal notification is excluded from the initial frequency boundary, not discarded.
        initial: event.kind === "terminal_saved" ? { turn: event.terminal.turnId }
          : { seq: (event.session.messageCount ?? event.session.messages.length) - 1 },
        positions: { "character-memory": { lastStarted: null, checking: false, dirty: false },
          "target-memory": { lastStarted: null, checking: false, dirty: false } } };
      this.sources.set(key(event.source), state);
    }
    state.session = event.session;
    if (event.kind === "terminal_saved" && !state.running) state.idleSince = this.clock.now();
    if (event.kind === "run_state") {
      if (event.running) { state.idleSince = null; this.clearTimers(state); }
      else if (state.running) state.idleSince = this.clock.now();
      state.running = event.running;
    }
    for (const purpose of purposes) this.check(state, purpose);
  }

  private check(state: SourceState, purpose: MemoryRecordingPurpose): void {
    const position = state.positions[purpose]; position.dirty = true;
    if (position.checking) return;
    position.checking = true;
    void (async () => {
      try {
        while (position.dirty && this.current(state)) {
          position.dirty = false;
          try {
            if (position.lastStarted === null) {
              state.initializing ??= this.initialize(state).finally(() => { state.initializing = undefined; });
              await state.initializing;
            }
            if (!this.current(state)) return;
            await this.evaluate(state, purpose);
          } catch (error) {
            if (this.current(state)) this.deps.runtime.reportFailure({ purpose, source: state.source, stage: "capture", error });
          }
        }
      }
      finally { position.checking = false; }
    })();
  }

  private async initialize(state: SourceState): Promise<void> {
    const captured = await this.deps.captureSource(state.source);
    if (!this.current(state)) return;
    if (!captured) { this.forget(state.source.kind, state.source.sessionId); return; }
    const before = captured.snapshot.turns.filter((turn) => turn.phase !== "running" && turn.completedAt
      && turn.assistantMessageSeq !== undefined && ("turn" in state.initial
        ? turn.id < state.initial.turn : turn.assistantMessageSeq <= state.initial.seq));
    const lastStarted = before.reduce((latest, turn) => Math.max(latest, turn.id), 0);
    for (const position of Object.values(state.positions)) position.lastStarted = lastStarted;
  }

  private async evaluate(state: SourceState, purpose: MemoryRecordingPurpose): Promise<void> {
    const position = state.positions[purpose];
    if (position.timer !== undefined) this.clock.clearTimeout(position.timer);
    position.timer = undefined;
    const [captured, settings] = await Promise.all([this.deps.captureSource(state.source), this.deps.getSettings()]);
    if (!this.current(state)) return;
    if (!captured) { this.forget(state.source.kind, state.source.sessionId); return; }
    const pending = captured.snapshot.turns.filter((turn) => turn.id > position.lastStarted!
      && turn.phase !== "running" && turn.completedAt && turn.assistantMessageSeq !== undefined);
    const frequency = settings.memoryRecordingFrequencies[purpose];
    const trigger = getMemoryRecordingTrigger({ pendingTurnCount: pending.length, frequency,
      isConversationRunning: state.running, idleMinutes: state.idleSince === null ? 0 : (this.clock.now() - state.idleSince) / 60_000 });
    if (trigger === "none") {
      if (pending.length && !state.running && state.idleSince !== null) {
        const delay = state.idleSince + frequency.idleMinutes * 60_000 - this.clock.now();
        if (delay > 0) position.timer = this.clock.setTimeout(() => { position.timer = undefined; this.check(state, purpose); }, Math.min(delay, 2_147_483_647));
      }
      return;
    }
    const authority = this.deps.resolveAuthority(state.session);
    if (!authority) {
      this.deps.runtime.reportFailure({ purpose, source: state.source, stage: "prepare", error: { code: "BACKGROUND_AUTHORITY_UNAVAILABLE" } });
      return;
    }
    const character: BackgroundMemoryTarget = { owner: "character", scope: "character", character: { type: "id", id: authority.characterId } };
    const memoryTargets: BackgroundMemoryTarget[] = purpose === "character-memory" ? [character]
      : [character, ...authority.allowedProjectIds.map((id): BackgroundMemoryTarget => ({ owner: "project", scope: "project", project: { type: "id", id } }))];
    const lastTerminalId = pending.reduce((latest, turn) => Math.max(latest, turn.id), 0);
    const prepared = await this.deps.runtime.prepare({ purpose, source: state.source, session: state.session,
      memoryTargets });
    if (!this.current(state) || position.dirty || prepared.status !== "ready") return;
    const { scope } = prepared.call.context;
    if (scope.purpose !== "character-memory" && scope.purpose !== "target-memory") throw new Error("Memory purpose preparation returned another purpose.");
    let characterDefinition: string | undefined;
    if (scope.purpose === "character-memory") {
      try { characterDefinition = await this.deps.readCharacterDefinition(authority.characterId); }
      catch (error) {
        if (this.current(state)) this.deps.runtime.reportFailure({ purpose, source: state.source, selection: prepared.call.selection, stage: "materials", error });
        return;
      }
      if (!this.current(state) || position.dirty) return;
    }
    await runBackgroundMemoryRegistration(this.deps.runtime.calls, { ...prepared.call,
      context: { ...prepared.call.context, scope: { ...scope, purpose: scope.purpose } },
      instructionText: prepared.instructionText,
      characterDefinition,
      materials: "保存済み会話と必要な操作結果は、この実行に接続されたsession_history toolから固定history範囲内で取得できる。",
      onAdmitted: () => { if (this.current(state)) position.lastStarted = lastTerminalId; },
    }).catch((error) => {
      this.deps.runtime.reportFailure({ purpose, source: state.source, selection: prepared.call.selection, stage: "setup", error });
    });
  }
}
