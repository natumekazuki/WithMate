export type MateGrowthEventState =
  | "candidate"
  | "applied"
  | "corrected"
  | "superseded"
  | "disabled"
  | "forgotten"
  | "failed";

export type MateGrowthEventListItem = {
  id: string;
  sourceType: string;
  sourceSessionId: string | null;
  growthSourceType: string;
  kind: string;
  targetSection: string;
  statement: string;
  rationalePreview: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount: number;
  projectionAllowed: boolean;
  state: MateGrowthEventState;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MateGrowthEventListRequest = {
  states?: MateGrowthEventState[];
  limit?: number;
};

export type MateGrowthEventListResult = {
  events: MateGrowthEventListItem[];
  limit: number;
};

export type MateGrowthEventActionRequest = {
  eventId: string;
};

export type MateGrowthEventCorrectionRequest = {
  eventId: string;
  statement: string;
};

export type MateGrowthEventActionResult = {
  event: MateGrowthEventListItem | null;
  createdEvent?: MateGrowthEventListItem | null;
};
