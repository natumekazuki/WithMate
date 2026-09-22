export type CharacterAffectTurnOwnershipOperation<T> = () => T | Promise<T>;
import {
  createStorageOperationDiagnosticContext,
  emitStorageOperationDiagnostic,
  runWithStorageOperationCorrelation,
  type StorageOperationDiagnosticSink,
} from "../storage/storage-operation-diagnostics.js";

export type RunCharacterAffectTurnOwnershipExclusive = <T>(
  operation: CharacterAffectTurnOwnershipOperation<T>,
) => Promise<T>;

export class CharacterAffectTurnOwnershipCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly diagnosticSink?: StorageOperationDiagnosticSink,
    private readonly generationId?: string,
  ) {}

  async runExclusive<T>(operation: CharacterAffectTurnOwnershipOperation<T>, operationName = "character-affect-ownership-exclusive"): Promise<T> {
    const context = createStorageOperationDiagnosticContext();
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation: operationName,
      correlationId: context.correlationId,
      ...(this.generationId ? { generationId: this.generationId } : {}),
      stage: "queued",
      outcome: "pending",
    });
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    context.startedAt = context.clock();
    emitStorageOperationDiagnostic(this.diagnosticSink, {
      operation: operationName,
      correlationId: context.correlationId,
      ...(this.generationId ? { generationId: this.generationId } : {}),
      stage: "started",
      outcome: "pending",
      waitMs: Math.max(0, context.startedAt - context.queuedAt),
    });
    try {
      const result = await runWithStorageOperationCorrelation(context.correlationId, () => operation());
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: operationName,
        correlationId: context.correlationId,
        ...(this.generationId ? { generationId: this.generationId } : {}),
        stage: "completed",
        outcome: "success",
        waitMs: Math.max(0, context.startedAt - context.queuedAt),
        holdMs: Math.max(0, context.clock() - context.startedAt),
      });
      return result;
    } catch (error) {
      emitStorageOperationDiagnostic(this.diagnosticSink, {
        operation: operationName,
        correlationId: context.correlationId,
        ...(this.generationId ? { generationId: this.generationId } : {}),
        stage: "completed",
        outcome: "failure",
        waitMs: Math.max(0, context.startedAt - context.queuedAt),
        holdMs: Math.max(0, context.clock() - context.startedAt),
      });
      throw error;
    } finally {
      release();
    }
  }
}
