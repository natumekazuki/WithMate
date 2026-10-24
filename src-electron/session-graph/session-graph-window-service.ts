import type { SessionGraphOwner } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphViewState, SessionGraphWindowPayload } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { sameSessionGraphOwner, type SessionGraphApplicationService, type SessionGraphReadOperation } from "./session-graph-application-service.js";
import type { SessionGraphRequest } from "../../src-shared/session-graph/session-graph-contract.js";

export type GraphWindow = {
  isDestroyed(): boolean; close(): void; show(): void; focus(): void; isMinimized(): boolean; restore(): void;
  on(event: "closed", listener: () => void): unknown;
};
type Entry<W> = { window: W; owner: SessionGraphOwner; generation: object | string; payload: SessionGraphWindowPayload; title: string };
export class SessionGraphWindowService<W extends GraphWindow> {
  private readonly entries = new Map<string, Entry<W>>();
  constructor(private readonly deps: {
    application: SessionGraphApplicationService;
    createWindow(): W; load(window: W, token: string): Promise<void>; token(): string;
    changed(): void; notify(window: W, sessionId: string): void;
    title?(window: W, title: string): void;
  }) {}
  async open(sessionId: string, state: SessionGraphViewState, guard: () => boolean, expected?: { owner: SessionGraphOwner; generation: object | string }) {
    const resolved = await this.deps.application.resolveSession(sessionId);
    if (!resolved || !guard() || (expected && (!sameSessionGraphOwner(expected.owner, resolved.owner) || expected.generation !== resolved.generation))) throw new Error("Session Graph owner is unavailable.");
    const token = this.deps.token();
    const window = this.deps.createWindow();
    const payload = { token, ownerSessionId: resolved.owner.sessionId, windowTitle: "Session Graph", state: structuredClone(state) };
    const entry = { window, owner: resolved.owner, generation: resolved.generation, payload, title: "Graph" };
    this.entries.set(token, entry);
    window.on("closed", () => { this.entries.delete(token); this.deps.changed(); });
    try {
      await this.deps.load(window, token);
      await this.authorize(window, token);
      await this.refreshTitle(window, token);
      if (!guard()) throw new Error("Session Graph authority changed.");
      window.show(); this.deps.changed();
      return { token };
    } catch (error) { this.close(token); throw error; }
  }
  async authorize(window: W, token: string) {
    const entry = this.entries.get(token);
    if (!entry || entry.window !== window || window.isDestroyed()) throw new Error("Session Graph window is unavailable.");
    const current = await this.deps.application.resolveSession(entry.owner.sessionId);
    if (this.entries.get(token) !== entry || !current || current.generation !== entry.generation || !sameSessionGraphOwner(current.owner, entry.owner) || window.isDestroyed()) {
      throw new Error("Session Graph authority changed.");
    }
    return entry;
  }
  async payload(window: W, token: string) {
    await this.refreshTitle(window, token);
    return structuredClone((await this.authorize(window, token)).payload);
  }
  async read<K extends SessionGraphReadOperation>(window: W, token: string, operation: K, request: SessionGraphRequest<K>) {
    if ((operation as string) === "apply") throw new Error("Graph windows are read-only.");
    const entry = await this.authorize(window, token);
    const result = await this.deps.application.executeTrusted(entry.owner.sessionId, operation, request,
      () => this.entries.get(token) === entry && !window.isDestroyed(), undefined, entry.owner);
    await this.authorize(window, token);
    return result;
  }
  async update(window: W, token: string, state: SessionGraphViewState) {
    const entry = await this.authorize(window, token);
    const titleChanged = entry.payload.state.topicId !== state.topicId || entry.payload.state.selectedId !== state.selectedId;
    entry.payload.state = structuredClone(state);
    if (titleChanged) await this.refreshTitle(window, token);
  }
  async notify(sessionId: string) {
    for (const [token, entry] of this.entries) {
      if (entry.owner.sessionId !== sessionId) continue;
      try {
        await this.authorize(entry.window, token);
        this.deps.notify(entry.window, sessionId);
        await this.refreshTitle(entry.window, token);
      } catch { /* Revoked or closed views are not notification targets. */ }
    }
  }
  isCurrent(token: string, window: W) { return this.entries.get(token)?.window === window && !window.isDestroyed(); }
  private async refreshTitle(window: W, token: string) {
    const entry = await this.authorize(window, token);
    const state = entry.payload.state;
    let topicTitle = "";
    if (state.topicId) {
      for (let offset = 0; ; offset += 200) {
        const topics = await this.read(window, token, "list_topics", { offset, limit: 200 });
        if (topics.status !== "ok") break;
        topicTitle = topics.items.find((topic) => topic.id === state.topicId)?.title ?? "";
        if (topicTitle || !topics.hasMore) break;
      }
    }
    let recordTitle = "";
    if (state.selectedId) {
      const records = await this.read(window, token, "get", { ids: [state.selectedId] });
      if (records.status === "ok") recordTitle = records.items[0]?.title ?? "";
    }
    const current = await this.authorize(window, token);
    if (current.payload.state.topicId !== state.topicId || current.payload.state.selectedId !== state.selectedId) return;
    entry.title = [topicTitle, recordTitle].filter(Boolean).join(" · ") || "Overview";
    const owner = await this.deps.application.resolveSession(entry.owner.sessionId);
    await this.authorize(window, token);
    if (entry.payload.state.topicId !== state.topicId || entry.payload.state.selectedId !== state.selectedId) return;
    entry.payload.windowTitle = `${entry.title} — ${owner?.identity.sessionTitle ?? "Session"}`;
    this.deps.title?.(window, entry.payload.windowTitle); this.deps.changed();
  }
  list() { return [...this.entries].map(([token, entry]) => ({ token, title: entry.title, ownerSessionId: entry.owner.sessionId, state: entry.payload.state })); }
  focus(token: string) { const w = this.entries.get(token)?.window; if (w && !w.isDestroyed()) { if(w.isMinimized()) w.restore(); w.show(); w.focus(); } }
  close(token: string) { const entry = this.entries.get(token); this.entries.delete(token); if (entry && !entry.window.isDestroyed()) entry.window.close(); this.deps.changed(); }
  closeOwner(sessionId: string) { for (const [token, entry] of this.entries) if (entry.owner.sessionId === sessionId) this.close(token); }
  closeAll() { for (const token of this.entries.keys()) this.close(token); }
}
