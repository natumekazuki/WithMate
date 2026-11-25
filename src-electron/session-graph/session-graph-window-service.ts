import type { SessionGraphOwner } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphViewState, SessionGraphWindowPayload } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { sameSessionGraphOwner, type SessionGraphApplicationService, type SessionGraphChange, type SessionGraphReadOperation } from "./session-graph-application-service.js";
import type { SessionGraphUiReadRequest } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { SESSION_SUMMARY_OPEN_ID_MAX } from "../session/session-summary-query.js";
import type { V6StorageWorkerBundle } from "../storage/storage-worker-bundle.js";
import type { SessionWindowBridge, SessionWindowLike } from "../windows/session-window-bridge.js";

export type GraphWindow = {
  isDestroyed(): boolean; close(): void; show(): void; focus(): void; isMinimized(): boolean; restore(): void;
  on(event: "closed", listener: () => void): unknown;
};
type Entry<W> = { window: W; owner: SessionGraphOwner; generation: object | string; payload: SessionGraphWindowPayload; title: string; sessionTitle: string };
export class SessionGraphWindowService<W extends GraphWindow> {
  private readonly entries = new Map<string, Entry<W>>();
  constructor(private readonly deps: {
    application: SessionGraphApplicationService;
    createWindow(): W; load(window: W, token: string): Promise<void>; token(): string;
    changed(): void; notify(window: W, sessionId: string): void;
    title?(window: W, title: string): void;
  }) {}
  async open(sessionId: string, state: SessionGraphViewState, guard: () => boolean, expected?: { owner: SessionGraphOwner; generation: object | string }) {
    const resolved = await this.deps.application.resolveSession(sessionId, { kind: "main" });
    if (!resolved || !guard() || (expected && (!sameSessionGraphOwner(expected.owner, resolved.owner) || expected.generation !== resolved.generation))) throw new Error("Session Graph owner is unavailable.");
    const token = this.deps.token();
    const window = this.deps.createWindow();
    const payload = { token, ownerSessionId: resolved.owner.sessionId, windowTitle: `Session Graph — ${resolved.identity.sessionTitle ?? "Session"}`, state: structuredClone(state) };
    const entry = { window, owner: resolved.owner, generation: resolved.generation, payload, title: "Graph", sessionTitle: resolved.identity.sessionTitle ?? "Session" };
    this.entries.set(token, entry);
    window.on("closed", () => { this.entries.delete(token); this.deps.changed(); });
    try {
      await this.deps.load(window, token);
      await this.authorize(window, token);
      if (!guard()) throw new Error("Session Graph authority changed.");
      window.show(); this.deps.changed();
      return { token };
    } catch (error) { this.close(token); throw error; }
  }
  async authorize(window: W, token: string) {
    const entry = this.entries.get(token);
    if (!entry || entry.window !== window || window.isDestroyed()) throw new Error("Session Graph window is unavailable.");
    const current = await this.deps.application.resolveSession(entry.owner.sessionId, { kind: "main", incarnationId: entry.owner.incarnationId });
    if (this.entries.get(token) !== entry || !current || current.generation !== entry.generation || !sameSessionGraphOwner(current.owner, entry.owner) || window.isDestroyed()) {
      throw new Error("Session Graph authority changed.");
    }
    const sessionTitle = current.identity.sessionTitle ?? "Session";
    if (entry.sessionTitle !== sessionTitle) {
      entry.sessionTitle = sessionTitle;
      this.refreshTitle(entry);
    }
    return entry;
  }
  async payload(window: W, token: string) {
    return structuredClone((await this.authorize(window, token)).payload);
  }
  async read<K extends SessionGraphReadOperation>(window: W, token: string, operation: K, request: SessionGraphUiReadRequest<K>) {
    if ((operation as string) === "apply") throw new Error("Graph windows are read-only.");
    const entry = await this.authorize(window, token);
    const result = await this.deps.application.readTrusted(entry.owner.sessionId, operation, request,
      () => this.entries.get(token) === entry && !window.isDestroyed(), entry.owner);
    await this.authorize(window, token);
    return result;
  }
  async update(window: W, token: string, state: SessionGraphViewState, title?: string) {
    const entry = await this.authorize(window, token);
    entry.payload.state = structuredClone(state);
    if (title !== undefined) {
      entry.title = title;
      this.refreshTitle(entry);
    }
  }
  private refreshTitle(entry: Entry<W>) {
    const title = `${entry.title} — ${entry.sessionTitle}`;
    if (entry.payload.windowTitle === title) return;
    entry.payload.windowTitle = title;
    this.deps.title?.(entry.window, title);
    this.deps.changed();
  }
  async notify(change: SessionGraphChange, isCurrent: () => boolean) {
    for (const [token, entry] of [...this.entries]) {
      if (!isCurrent()) return;
      if (entry.generation !== change.generation || !sameSessionGraphOwner(entry.owner, change.owner)) continue;
      try {
        await this.authorize(entry.window, token);
        if (isCurrent() && this.entries.get(token) === entry && !entry.window.isDestroyed()) {
          this.deps.notify(entry.window, change.owner.sessionId);
        }
      } catch { /* Revoked or closed views are not notification targets. */ }
    }
  }
  isCurrent(token: string, window: W) { return this.entries.get(token)?.window === window && !window.isDestroyed(); }
  list() { return [...this.entries].map(([token, entry]) => ({ token, title: entry.title, ownerSessionId: entry.owner.sessionId, state: entry.payload.state })); }
  focus(token: string) { const w = this.entries.get(token)?.window; if (w && !w.isDestroyed()) { if(w.isMinimized()) w.restore(); w.show(); w.focus(); } }
  close(token: string) { const entry = this.entries.get(token); this.entries.delete(token); if (entry && !entry.window.isDestroyed()) entry.window.close(); this.deps.changed(); }
  closeOwner(sessionId: string) { for (const [token, entry] of this.entries) if (entry.owner.sessionId === sessionId) this.close(token); }
  closeAll() { for (const token of this.entries.keys()) this.close(token); }
}

/** Deliver a committed change without enumerating saved Sessions. isCurrent must check the captured store and maintenance state. */
export async function notifySessionGraphWindows<W extends SessionWindowLike & GraphWindow>(
  change: SessionGraphChange,
  deps: {
    sessionStorage: Pick<V6StorageWorkerBundle["stores"]["session"], "listSessionSummaryPage" | "getSessionSummary">;
    sessionWindows: Pick<SessionWindowBridge<W>, "listOpenSessionWindowIds" | "getWindow" | "getWindowIncarnation" | "getWindowStorageGeneration">;
    graphWindows: Pick<SessionGraphWindowService<W>, "notify">;
    isCurrent(): boolean;
    send(window: W, recipientSessionId: string): void;
  },
): Promise<void> {
  const { sessionWindows, sessionStorage, isCurrent } = deps;
  if (!isCurrent()) return;
  try {
    const candidates = new Map(sessionWindows.listOpenSessionWindowIds().flatMap((id) => {
      const window = sessionWindows.getWindow(id);
      const incarnationId = window && sessionWindows.getWindowIncarnation(window);
      return window && incarnationId && sessionWindows.getWindowStorageGeneration(window) === change.generation
        ? [[id, { window, incarnationId }] as const] : [];
    }));

    // Open scope preserves the ready filter without reading any closed member's summary.
    const ids = [...candidates.keys()];
    for (let start = 0; start < ids.length; start += SESSION_SUMMARY_OPEN_ID_MAX) {
      const sessionIds = ids.slice(start, start + SESSION_SUMMARY_OPEN_ID_MAX);
      const page = await sessionStorage.listSessionSummaryPage({ scope: "open", sessionIds });
      if (!isCurrent()) return;
      const readyIds = page.entries.map(({ id }) => id).filter((id) => {
        const candidate = candidates.get(id);
        return candidate && sessionWindows.getWindow(id) === candidate.window;
      });
      if (readyIds.length === 0) continue;

      const ownerId = change.owner.sessionId;
      const [owner, ...members] = await Promise.all([
        sessionStorage.getSessionSummary(ownerId),
        ...readyIds.filter((id) => id !== ownerId).map((id) => sessionStorage.getSessionSummary(id)),
      ]);
      if (!isCurrent()) return;
      if (!owner || owner.id !== ownerId || getSessionIncarnationId(owner) !== change.owner.incarnationId
        || (owner.rootSessionId ?? owner.id) !== ownerId || owner.parentSessionId) return;
      for (const member of readyIds.includes(ownerId) ? [owner, ...members] : members) {
        if (!isCurrent()) return;
        if (!member || (member.rootSessionId ?? member.id) !== ownerId) continue;
        const candidate = candidates.get(member.id);
        if (candidate && getSessionIncarnationId(member) === candidate.incarnationId
          && sessionWindows.getWindow(member.id) === candidate.window) {
          deps.send(candidate.window, member.id);
        }
      }
    }
  } finally {
    // Independent Graph views don't depend on the existence (or lookup success) of Session windows.
    await deps.graphWindows.notify(change, isCurrent);
  }
}
