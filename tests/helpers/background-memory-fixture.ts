import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { MemoryTargetSelector } from "../../src-shared/memory/memory-contract.js";
import { CharacterContextApplicationService } from "../../src-electron/character/character-context-application-service.js";
import { BackgroundMemoryApplicationService, type BackgroundMemoryContext } from "../../src-electron/memory/background-memory-application-service.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";
import type { StorageOperationDiagnosticSink } from "../../src-electron/storage/storage-operation-diagnostics.js";
import { backgroundAffectFixture, completedAt } from "./background-affect-fixture.js";

export const characterTarget: MemoryTargetSelector = { owner: "character", scope: "character", character: { type: "id", id: "character" } };
export const generalTarget: MemoryTargetSelector = { owner: "user", scope: "global" };
export type MemoryPurpose = "character-memory" | "target-memory";

/** Reuses isolated saved Main data and real Worker; Provider, source-read wiring and notifications are injected. */
export async function backgroundMemoryFixture(diagnosticSink?: StorageOperationDiagnosticSink) {
  const f = await backgroundAffectFixture(diagnosticSink);
  const memory = new MemoryV6Service({ storage: f.worker.storage });
  const character = new CharacterContextApplicationService({ memoryService: memory, affectService: f.affect,
    resolveCharacterRuntimeSnapshot: (characterId) => ({ characterId, name: "Character", description: "", iconFilePath: "",
      theme: { main: "#123456", sub: "#abcdef" }, definitionMarkdown: "Character", definitionSha256: "fixture",
      definitionByteSize: 9, snapshotAt: completedAt }),
  });
  const deps: ConstructorParameters<typeof BackgroundMemoryApplicationService>[0] = {
    bindings: f.bindings, turns: f.turns, readMainSource: f.deps.readMainSource, memoryService: memory, characterService: character,
  };
  function scope(purpose: MemoryPurpose, kind: "main" | "auxiliary" = "main"): BackgroundExecutionScope {
    return { ...f.scope(kind), purpose, memoryTargets: [purpose === "character-memory" ? characterTarget : generalTarget] };
  }
  function context(capturedScope: BackgroundExecutionScope): BackgroundMemoryContext {
    const source = capturedScope.history.source;
    const rows = source.kind === "main" ? f.db.prepare(`SELECT seq FROM session_messages_v6 WHERE session_id = ?
      AND seq BETWEEN ? AND ?`).all(source.sessionId, capturedScope.history.fromMessageSeq, capturedScope.history.throughMessageSeq) as { seq: number }[] : [];
    const terminal = f.db.prepare(`SELECT assistant_message_seq AS seq FROM session_turns_v6 WHERE session_id = ?
      AND phase != 'running' AND id > ? AND id <= ?`).all(source.sessionId,
      capturedScope.processing.afterTurnId ?? 0, capturedScope.processing.throughTurnId) as { seq: number }[];
    return { history: capturedScope.history, processing: capturedScope.processing,
      messages: rows.map(({ seq }) => ({ seq, processing: terminal.some((turn) => turn.seq === seq), operations: [], runChecks: [] })),
      allowedTargets: new Map(capturedScope.purpose === "target-memory" ? [["general", generalTarget]] : []),
    };
  }
  return { ...f, memory, character, deps, memoryScope: scope, memoryContext: context,
    app: new BackgroundMemoryApplicationService(deps) };
}

export function memoryFinal(purpose: MemoryPurpose, count = 1): unknown {
  const grounding = [{ basis: "shared_exchange", refs: [{ kind: "message", seq: 1 }] }];
  const content = (index: number) => ({ title: ` Memory ${index} `, body: ` Saved content ${index} `, preview: ` Content ${index} ` });
  return purpose === "character-memory"
    ? { outcome: "candidates", episodes: Array.from({ length: count }, (_, index) => ({
      episode: { ...content(index), observedFact: `Fact ${index}`, characterObservation: `Observation ${index}`, motif: "topic" }, grounding,
    })) }
    : { outcome: "candidates", entries: Array.from({ length: count }, (_, index) => ({ ...content(index),
      targetSlot: "general", kind: "note", tags: [{ type: " Topic ", value: " V6 " }, { type: "topic", value: "v6" }], grounding,
    })) };
}
