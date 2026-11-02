import type { BackgroundPurpose, BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { MainSourceSnapshot } from "../../src-shared/session/main-source-snapshot.js";
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
  source: MainSourceSnapshot;
  principal: MemoryV6SessionBindingPrincipal;
  admission: RuntimeTurnAdmission;
  transport: CharacterContextTransport;
}>, services: Readonly<{
  memory: Pick<MemoryV6Service, "append">;
  character: Pick<CharacterContextApplicationService, "appraise" | "appendEpisode"> | undefined;
}>) => unknown | Promise<unknown>;

/** No handler means no registration publication or dispatch; normal turn writes are never a fallback. */
export type BackgroundRegistration = Readonly<{
  readMainSource: (scope: SessionHistoryReadScope) => Promise<MainSourceSnapshot | null>;
  handlers: Readonly<Partial<Record<BackgroundPurpose, BackgroundRegistrationHandler>>>;
}>;
