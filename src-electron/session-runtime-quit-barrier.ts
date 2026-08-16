type SessionRuntimeShutdownParticipant = {
  beginShutdown(): void;
};

export function closeSessionRuntimeAdmission(args: {
  executionService: SessionRuntimeShutdownParticipant | null;
  applicationService: SessionRuntimeShutdownParticipant | null;
}): void {
  args.executionService?.beginShutdown();
  args.applicationService?.beginShutdown();
}
