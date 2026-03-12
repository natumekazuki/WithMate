import type { CreateSessionInput, Session } from "./mock-data.js";

export const WITHMATE_OPEN_SESSION_CHANNEL = "withmate:open-session";
export const WITHMATE_LIST_SESSIONS_CHANNEL = "withmate:list-sessions";
export const WITHMATE_GET_SESSION_CHANNEL = "withmate:get-session";
export const WITHMATE_CREATE_SESSION_CHANNEL = "withmate:create-session";
export const WITHMATE_UPDATE_SESSION_CHANNEL = "withmate:update-session";
export const WITHMATE_PICK_DIRECTORY_CHANNEL = "withmate:pick-directory";
export const WITHMATE_SESSIONS_CHANGED_EVENT = "withmate:sessions-changed";

export type WithMateWindowApi = {
  openSession(sessionId: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | null>;
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSession(session: Session): Promise<Session>;
  pickDirectory(): Promise<string | null>;
  subscribeSessions(listener: (sessions: Session[]) => void): () => void;
};
