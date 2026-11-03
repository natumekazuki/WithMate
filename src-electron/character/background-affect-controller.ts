import type { AffectCompositionInput } from "../../src-shared/character-affect/affect-composition.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundProductionRuntime, BackgroundRuntimeEvent } from "../providers/background-production-runtime.js";
import { runBackgroundAffectCall } from "./background-affect-call.js";

type SourcePosition = { source: BackgroundSourceRef; ownerIdentity?: string; afterTurnId?: number | null };
type TerminalEvent = Extract<BackgroundRuntimeEvent, { kind: "terminal_saved" }>;

/** In-memory start positions only; registration and execution ownership remain shared. */
export class BackgroundAffectController {
  readonly #positions = new Map<string, SourcePosition>();
  #unsubscribe?: () => void;

  constructor(private readonly deps: {
    runtime: Pick<BackgroundProductionRuntime, "subscribe" | "prepare" | "calls">;
    captureSource(source: BackgroundSourceRef): Promise<CapturedBackgroundSource | null>;
    readMaterials(session: Session, source: CapturedBackgroundSource): Promise<Omit<AffectCompositionInput, "instructionBody">>;
    onFailure(source: BackgroundSourceRef, error: unknown): void;
  }) {}

  start(): void {
    if (this.#unsubscribe) return;
    const subscription = this.deps.runtime.subscribe((event) => {
      if (event.kind === "stopped") { this.stop(); return; }
      if (event.kind !== "terminal_saved") return;
      return this.onTerminal(event, subscription).catch((error) => this.deps.onFailure(event.source, error));
    });
    this.#unsubscribe = subscription;
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#positions.clear();
  }

  forgetSource(kind: BackgroundSourceRef["kind"], sessionId: string): void {
    for (const [key, position] of this.#positions) {
      const source = position.source;
      if ((source.kind === kind && source.sessionId === sessionId)
        || (kind === "main" && source.kind === "auxiliary" && source.parent.sessionId === sessionId)) {
        this.#positions.delete(key);
      }
    }
  }

  private async onTerminal(event: TerminalEvent, subscription: () => void): Promise<void> {
    const source = event.source;
    const key = JSON.stringify([source.kind, source.sessionId, source.incarnationId,
      ...(source.kind === "auxiliary" ? [source.parent.sessionId, source.parent.incarnationId] : [])]);
    for (const [previousKey, previous] of this.#positions) {
      if ((previous.source.kind === source.kind && previous.source.sessionId === source.sessionId && previousKey !== key)
        || (source.kind === "main" && previous.source.kind === "auxiliary"
          && previous.source.parent.sessionId === source.sessionId && previous.source.parent.incarnationId !== source.incarnationId)) {
        this.#positions.delete(previousKey);
      }
    }
    let position = this.#positions.get(key);
    if (!position) {
      position = { source: event.source };
      this.#positions.set(key, position);
    }
    const current = () => this.#unsubscribe === subscription && this.#positions.get(key) === position;
    const captured = await this.deps.captureSource(event.source);
    if (!current()) return;
    if (!captured) { this.#positions.delete(key); return; }
    if (position.ownerIdentity !== undefined && position.ownerIdentity !== captured.snapshot.ownerIdentity) {
      position = { source, ownerIdentity: captured.snapshot.ownerIdentity };
      this.#positions.set(key, position);
    }
    position.ownerIdentity = captured.snapshot.ownerIdentity;
    const throughTurnId = event.terminal.turnId;
    if (position.afterTurnId === undefined) {
      position.afterTurnId = captured.snapshot.turns.reduce<number | null>((last, turn) =>
        turn.id < throughTurnId && turn.phase !== "running" && turn.completedAt
          ? Math.max(last ?? 0, turn.id) : last, null);
    }
    const afterTurnId = position.afterTurnId;
    if (throughTurnId <= (afterTurnId ?? 0)) return;
    const prepared = await this.deps.runtime.prepare({ purpose: "affect", source: event.source,
      session: event.session, processing: { afterTurnId, throughTurnId }, memoryTargets: [
        { owner: "character", scope: "character", character: { type: "id", id: captured.snapshot.session.characterId } },
      ] });
    if (!current()) return;
    if (prepared.status !== "ready") {
      if (prepared.status !== "not_configured") this.deps.onFailure(event.source, prepared);
      return;
    }
    if (prepared.call.context.scope.history.source.ownerIdentity !== captured.snapshot.ownerIdentity) return;
    const materials = await this.deps.readMaterials(event.session, captured);
    if (!current()) return;
    const result = await runBackgroundAffectCall(this.deps.runtime.calls, { ...prepared.call, ...materials,
      instructionBody: prepared.instructionText,
      onAdmitted: () => {
        if (current()) position.afterTurnId = Math.max(position.afterTurnId ?? 0, throughTurnId);
      },
    });
    if (result.kind !== "completed") this.deps.onFailure(event.source, result);
  }
}
