export type SessionExecutionAdmission = {
  release(): void;
};

export class SessionExecutionAdmissionGate {
  private accepting = true;
  private activeAdmissions = 0;
  private readonly drainWaiters = new Set<() => void>();

  tryAdmit(): SessionExecutionAdmission | null {
    if (!this.accepting) {
      return null;
    }
    this.activeAdmissions += 1;
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeAdmissions -= 1;
        if (this.activeAdmissions === 0) {
          for (const resolve of this.drainWaiters) {
            resolve();
          }
          this.drainWaiters.clear();
        }
      },
    };
  }

  async runMaintenance<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) {
      throw new Error("Session execution maintenance is already active.");
    }
    this.accepting = false;
    try {
      await this.waitForAdmissionsToDrain();
      return await operation();
    } finally {
      this.accepting = true;
    }
  }

  private async waitForAdmissionsToDrain(): Promise<void> {
    if (this.activeAdmissions === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }
}
