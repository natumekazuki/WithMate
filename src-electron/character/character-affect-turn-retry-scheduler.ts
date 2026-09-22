type ScheduledTask = () => void | Promise<void>;

export type CharacterAffectTurnRetrySchedulerOptions = {
  drain(): Promise<boolean>;
  onError(error: unknown): void;
  initialRetryDelayMs?: number;
  maximumRetryDelayMs?: number;
  scheduleTask?: (task: ScheduledTask, delayMs: number) => unknown;
  cancelTask?: (handle: unknown) => void;
};

export async function settleCharacterAffectTurnOrScheduleRetry(input: {
  settle(): Promise<boolean>;
  scheduleRetry(): void;
}): Promise<void> {
  try {
    if (await input.settle()) {
      return;
    }
  } catch (error) {
    input.scheduleRetry();
    throw error;
  }
  input.scheduleRetry();
}

export class CharacterAffectTurnRetryScheduler {
  readonly #drain: () => Promise<boolean>;
  readonly #onError: (error: unknown) => void;
  readonly #initialRetryDelayMs: number;
  readonly #maximumRetryDelayMs: number;
  readonly #scheduleTask: (task: ScheduledTask, delayMs: number) => unknown;
  readonly #cancelTask: (handle: unknown) => void;
  #scheduled: unknown | null = null;
  #running = false;
  #requestedWhileRunning = false;
  #retryAttempt = 0;
  #disposed = false;

  constructor(options: CharacterAffectTurnRetrySchedulerOptions) {
    this.#drain = options.drain;
    this.#onError = options.onError;
    this.#initialRetryDelayMs = options.initialRetryDelayMs ?? 1_000;
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs ?? 60_000;
    if (
      !Number.isFinite(this.#initialRetryDelayMs)
      || !Number.isFinite(this.#maximumRetryDelayMs)
      || this.#initialRetryDelayMs < 1
      || this.#maximumRetryDelayMs < this.#initialRetryDelayMs
    ) {
      throw new Error("Character affect retry delay range is invalid.");
    }
    this.#scheduleTask = options.scheduleTask ?? ((task, delayMs) => setTimeout(task, delayMs));
    this.#cancelTask = options.cancelTask ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  request(options: { immediate?: boolean; resetBackoff?: boolean } = {}): void {
    if (this.#disposed) {
      return;
    }
    if (options.resetBackoff) {
      this.#retryAttempt = 0;
    }
    if (this.#running) {
      this.#requestedWhileRunning = true;
      return;
    }
    if (this.#scheduled !== null) {
      return;
    }
    this.#schedule(options.immediate ? 0 : this.#nextRetryDelay());
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#scheduled !== null) {
      this.#cancelTask(this.#scheduled);
      this.#scheduled = null;
    }
  }

  #nextRetryDelay(): number {
    const exponent = Math.min(this.#retryAttempt, 30);
    return Math.min(this.#initialRetryDelayMs * (2 ** exponent), this.#maximumRetryDelayMs);
  }

  #schedule(delayMs: number): void {
    this.#scheduled = this.#scheduleTask(async () => {
      this.#scheduled = null;
      await this.#run();
    }, delayMs);
  }

  async #run(): Promise<void> {
    if (this.#disposed || this.#running) {
      return;
    }
    this.#running = true;
    this.#requestedWhileRunning = false;
    let retryRequired = false;
    try {
      retryRequired = await this.#drain();
    } catch (error) {
      retryRequired = true;
      try {
        this.#onError(error);
      } catch {
        // Recovery remains scheduled even when diagnostic reporting is unavailable.
      }
    } finally {
      this.#running = false;
    }
    if (this.#disposed) {
      return;
    }
    if (!retryRequired && !this.#requestedWhileRunning) {
      this.#retryAttempt = 0;
      return;
    }
    const delayMs = this.#nextRetryDelay();
    this.#retryAttempt += 1;
    this.#schedule(delayMs);
  }
}
