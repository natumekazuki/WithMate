export const WITHMATE_OPEN_SESSION_CHANNEL = "withmate:open-session";

export type WithMateWindowApi = {
  openSession(sessionId: string): Promise<void>;
};
