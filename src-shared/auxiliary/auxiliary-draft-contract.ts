import type { AuxiliarySession } from "./auxiliary-session-state.js";

/** Durable draft state exchanged between the renderer and Main process. */
export type AuxiliaryDraftRecord = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  durableRevision: number;
  text: string;
  updatedAt: string;
};

export type AuxiliaryDraftSaveInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  expectedDurableRevision: number;
  text: string;
  updatedAt: string;
};

export type AuxiliaryDraftAck = Pick<AuxiliaryDraftRecord, "auxiliarySessionId" | "incarnation" | "durableRevision" | "updatedAt">;

export type AuxiliaryDraftSaveResult = {
  outcome: "saved" | "stale" | "not-found" | "rejected";
  ack?: AuxiliaryDraftAck;
};

export type AuxiliaryDraftConsumeInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  expectedDurableRevision: number;
};

export type AuxiliaryDraftConsumeResult = {
  outcome: "consumed" | "stale" | "not-found" | "rejected";
  ack?: AuxiliaryDraftAck;
};

export type AuxiliarySessionStatus = {
  id: string;
  parentSessionId: string;
  status: "active" | "closed";
  createdAt: string;
  incarnation: string;
  runState: AuxiliarySession["runState"];
};
