type QuitEventLike = {
  preventDefault(): void;
};

type SessionRuntimeQuitBarrierDeps = {
  stopRuntime(): Promise<void>;
  quitApp(): void;
};

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
      .finally(() => {
        this.state = "stopped";
        this.deps.quitApp();
      });
  }
}
