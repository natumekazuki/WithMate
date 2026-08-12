type QuitEventLike = {
  preventDefault(): void;
};

type SessionRuntimeQuitBarrierDeps = {
  stopRuntime(): Promise<void>;
  drainExecutions(): Promise<void>;
  closePersistentStores(): void;
  quitApp(): void;
};

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

export class SessionRuntimeQuitBarrier {
  private state: "idle" | "stopping" | "stopped" = "idle";

  constructor(private readonly deps: SessionRuntimeQuitBarrierDeps) {}

  handleWillQuit(event: QuitEventLike): void {
    if (this.state === "stopped") {
      return;
    }

    event.preventDefault();
    if (this.state === "stopping") {
      return;
    }

    this.state = "stopping";
    void Promise.resolve()
      .then(() => this.deps.stopRuntime())
      .catch(() => undefined)
      .then(() => this.deps.drainExecutions())
      .catch(() => undefined)
      .finally(() => {
        this.deps.closePersistentStores();
        this.state = "stopped";
        this.deps.quitApp();
      });
  }
}
