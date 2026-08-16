export const COMPANION_MODE_RETIRED_MESSAGE =
  "Companion Mode is retired. Existing history can still be reviewed, merged, or discarded.";

export const COMPANION_PROVIDER_EXECUTION_RETIRED_MESSAGE =
  "Companion provider execution is retired.";

export function shouldShowRetiredCompanionAuxiliaryHeaderActions(input: {
  hasSnapshot: boolean;
  hasActiveAuxiliarySession: boolean;
}): boolean {
  return input.hasSnapshot && input.hasActiveAuxiliarySession;
}
