import type { SessionExecutionOptions } from "./session-execution-options.js";

export type SetSessionExecutionOptionsRequest = {
  sessionId: string;
  incarnationId: string;
  executionOptions: SessionExecutionOptions;
};

export type SetExecutionOptionsResult =
  | { status: "accepted"; checkpointSaved: boolean }
  | { status: "superseded" };

export type SetSessionTitleRequest = {
  sessionId: string;
  incarnationId: string;
  title: string;
};

export type SetSessionMessageBookmarkRequest = {
  sessionId: string;
  incarnationId: string;
  messageIndex: number;
  isBookmarked: boolean;
};

export type AuxiliarySessionMutationIdentity = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
};

export type SetAuxiliaryExecutionOptionsRequest = AuxiliarySessionMutationIdentity & {
  executionOptions: SessionExecutionOptions;
};

export type SetAuxiliaryTitleRequest = AuxiliarySessionMutationIdentity & {
  title: string;
};

export type SetAuxiliaryMessageBookmarkRequest = AuxiliarySessionMutationIdentity & {
  messageIndex: number;
  isBookmarked: boolean;
};
