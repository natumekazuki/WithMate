import type { AffectCompositionInput } from "../../src-shared/character-affect/affect-composition.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundProductionRuntime, BackgroundRuntimeEvent } from "../providers/background-production-runtime.js";
import { runBackgroundAffectCall } from "./background-affect-call.js";

type TerminalEvent = Extract<BackgroundRuntimeEvent, { kind: "terminal_saved" }>;
type SourcePosition = {
  source: BackgroundSourceRef; ownerIdentity?: string; lastStarted?: number;
  pending?: TerminalEvent; draining: boolean;
};

/** Coalesced terminal triggers only; registration and execution ownership remain shared. */
export class BackgroundAffectController {
  readonly #positions = new Map<string, SourcePosition>();
  #unsubscribe?: () => void;

  constructor(private readonly deps: {
    runtime: Pick<BackgroundProductionRuntime, "subscribe" | "prepare" | "calls" | "reportFailure" | "forgetSource">;
    captureSource(source: BackgroundSourceRef): Promise<CapturedBackgroundSource | null>;
    readMaterials(session: Session, source: CapturedBackgroundSource): Promise<Omit<AffectCompositionInput, "instructionBody">>;
  }) {}

  start(): void {
    if (this.#unsubscribe) return;
    const subscription = this.deps.runtime.subscribe((event) => {
      if (event.kind === "stopped") { this.stop(); return; }
      if (event.kind !== "terminal_saved") return;
      this.onTerminal(event, subscription);
    });
    this.#unsubscribe = subscription;
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#positions.clear();
  }

  forgetSource(kind: BackgroundSourceRef["kind"], sessionId: string): void {
    this.deps.runtime.forgetSource(kind, sessionId);
    for (const [key, position] of this.#positions) {
      const source = position.source;
      if ((source.kind === kind && source.sessionId === sessionId)
        || (kind === "main" && source.kind === "auxiliary" && source.parent.sessionId === sessionId)) {
        this.#positions.delete(key);
      }
    }
  }

  private onTerminal(event: TerminalEvent, subscription: () => void): void {
    const source = event.source;
    const key = JSON.stringify([source.kind, source.sessionId, source.incarnationId,
      ...(source.kind === "auxiliary" ? [source.parent.sessionId, source.parent.incarnationId] : [])]);
    for (const [previousKey, previous] of this.#positions) {
      if ((previous.source.kind === source.kind && previous.source.sessionId === source.sessionId && previousKey !== key)
        || (source.kind === "main" && previous.source.kind === "auxiliary"
          && previous.source.parent.sessionId === source.sessionId && previous.source.parent.incarnationId !== source.incarnationId)) {
        this.#positions.delete(previousKey);
        this.deps.runtime.forgetSource(previous.source.kind, previous.source.sessionId);
      }
    }
    let position = this.#positions.get(key);
    if (!position) {
      position = { source: event.source, draining: false };
      this.#positions.set(key, position);
    }
    if (event.terminal.turnId <= (position.lastStarted ?? 0)) return;
    if (!position.pending || event.terminal.turnId >= position.pending.terminal.turnId) position.pending = event;
    if (position.draining) return;
    position.draining = true;
    const current = () => this.#unsubscribe === subscription && this.#positions.get(key) === position;
    void (async () => {
      try {
        while (current() && position.pending) {
          const pending = position.pending;
          position.pending = undefined;
          try { await this.evaluate(pending, position, current); }
          catch (error) {
            if (current()) this.deps.runtime.reportFailure({ purpose: "affect", source, stage: "capture", error });
          }
        }
      } finally { position.draining = false; }
    })();
  }

  private async evaluate(event: TerminalEvent, position: SourcePosition, current: () => boolean): Promise<void> {
    const captured = await this.deps.captureSource(event.source);
    if (!current()) return;
    if (!captured) { this.forgetSource(event.source.kind, event.source.sessionId); return; }
    if (position.ownerIdentity !== undefined && position.ownerIdentity !== captured.snapshot.ownerIdentity) {
      this.deps.runtime.forgetSource(event.source.kind, event.source.sessionId);
      position.lastStarted = undefined;
    }
    position.ownerIdentity = captured.snapshot.ownerIdentity;
    if (position.pending || event.terminal.turnId <= (position.lastStarted ?? 0)) return;
    const prepared = await this.deps.runtime.prepare({ purpose: "affect", source: event.source,
      session: event.session, memoryTargets: [
        { owner: "character", scope: "character", character: { type: "id", id: captured.snapshot.session.characterId } },
      ] });
    if (!current() || position.pending) return;
    if (prepared.status !== "ready") {
      return;
    }
    if (prepared.call.context.scope.history.source.ownerIdentity !== captured.snapshot.ownerIdentity) return;
    let materials: Omit<AffectCompositionInput, "instructionBody">;
    try { materials = await this.deps.readMaterials(event.session, captured); }
    catch (error) {
      if (current()) this.deps.runtime.reportFailure({ purpose: "affect", source: event.source, selection: prepared.call.selection, stage: "materials", error });
      return;
    }
    if (!current() || position.pending) return;
    await runBackgroundAffectCall(this.deps.runtime.calls, { ...prepared.call, ...materials,
      instructionBody: prepared.instructionText,
      onAdmitted: () => {
        if (current()) position.lastStarted = event.terminal.turnId;
      },
    });
  }
}
