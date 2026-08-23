export type RelatedSessionSummary = {
  sessionId: string;
  taskTitle: string;
};

export type RelatedSessionDetails =
  | { sessionId: string; status: "loading" }
  | { sessionId: string; status: "found"; taskTitle: string }
  | { sessionId: string; status: "missing" }
  | { sessionId: string; status: "error"; taskTitle?: string };
