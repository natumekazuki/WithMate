import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { BackgroundSourceSnapshot } from "../../src-shared/session/background-source-snapshot.js";
import type { SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import type { CharacterContextApplicationService, CharacterContextTransport } from "../character/character-context-application-service.js";
import type { MemoryV6SessionBindingPrincipal } from "../memory/memory-v6-permission.js";
import type { MemoryV6Service } from "../memory/memory-v6-service.js";
import type { RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";

/** A purpose adapter validates its tool input/source references before using the existing services. */
export type BackgroundRegistrationHandler = (input: Readonly<{
  /** Actor identity and Character conversation authority are server-owned; domain values still require validation. */
  body: unknown;
  scope: BackgroundExecutionScope;
  source: BackgroundSourceSnapshot;
  principal: MemoryV6SessionBindingPrincipal;
  admission: RuntimeTurnAdmission;
  transport: CharacterContextTransport;
}>, services: Readonly<{
  memory: Pick<MemoryV6Service, "append" | "appendEntries">;
  character: Pick<CharacterContextApplicationService, "appraise" | "appendEpisode" | "appendEpisodes"> | undefined;
}>) => unknown | Promise<unknown>;

/** Both a handler and explicit source-kind support are required; normal turn writes are never a fallback. */
export type BackgroundRegistration = Readonly<{
  readBackgroundSource: (scope: SessionHistoryReadScope) => Promise<BackgroundSourceSnapshot | null>;
  handlers: Readonly<Partial<Record<BackgroundPurpose, BackgroundRegistrationHandler>>>;
  sourceKinds: Readonly<Partial<Record<BackgroundPurpose, readonly SessionHistoryReadScope["source"]["kind"][]>>>;
}>;

export function supportsBackgroundRegistration(registration: BackgroundRegistration | undefined, purpose: BackgroundPurpose,
  kind: SessionHistoryReadScope["source"]["kind"]): boolean {
  return Boolean(registration?.handlers[purpose] && registration.sourceKinds[purpose]?.includes(kind));
}
