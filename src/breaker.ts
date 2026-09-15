/**
 * A minimal circuit breaker.
 *
 * CLOSED    - calls pass through. `failureThreshold` consecutive failures trips it.
 * OPEN      - calls are rejected immediately (fast-fail) for `openMs`.
 * HALF_OPEN - a few probe calls are let through. `successesToClose` of them
 *             succeeding closes the circuit; a single failure re-opens it.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type BreakerConfig = {
  /** consecutive failures in CLOSED that trip the breaker */
  failureThreshold: number;
  /** how long the breaker stays OPEN before probing */
  openMs: number;
  /** consecutive probe successes needed to close from HALF_OPEN */
  successesToClose: number;
  /** how many probes may be in flight at once in HALF_OPEN */
  halfOpenMaxProbes: number;
  /** a call slower than this counts as a failure */
  timeoutMs: number;
};

export const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  openMs: 6000,
  successesToClose: 3,
  halfOpenMaxProbes: 2,
  timeoutMs: 500,
};

/** Thrown instead of calling the dependency when the breaker is not letting calls through. */
export class CircuitOpenError extends Error {
  constructor() {
    super('circuit open');
    this.name = 'CircuitOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export type BreakerSnapshot = {
  state: BreakerState;
  config: BreakerConfig;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  probesInFlight: number;
  /** ms until the breaker moves OPEN -> HALF_OPEN, null when not OPEN */
  msUntilHalfOpen: number | null;
  /** why the breaker last changed state */
  lastTransition: Transition | null;
};

export type Transition = { from: BreakerState; to: BreakerState; reason: string; at: number };

export class CircuitBreaker {
  config: BreakerConfig;

  /** Called on every state change, so the caller can log or emit metrics. */
  onTransition?: (t: Transition) => void;

  #state: BreakerState = 'CLOSED';
  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #probesInFlight = 0;
  #openedAt = 0;
  #generation = 0;
  #lastTransition: Transition | null = null;

  constructor(config: BreakerConfig = DEFAULT_CONFIG) {
    this.config = { ...config };
  }

  /** Run `fn` through the breaker. Rejects with CircuitOpenError without calling `fn` when open. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.#refresh();

    if (this.#state === 'OPEN') throw new CircuitOpenError();

    // In HALF_OPEN only a handful of calls get through as probes; the rest
    // keep fast-failing so a recovering dependency isn't hit by the full load.
    const isProbe = this.#state === 'HALF_OPEN';
    if (isProbe) {
      if (this.#probesInFlight >= this.config.halfOpenMaxProbes) throw new CircuitOpenError();
      this.#probesInFlight++;
    }

    const admittedGeneration = this.#generation;

    try {
      const result = await this.#withTimeout(fn());
      this.#settle(admittedGeneration, true);
      return result;
    } catch (err) {
      this.#settle(admittedGeneration, false);
      throw err;
    } finally {
      // A slot belongs to the generation that took it. Releasing it later would
      // free a slot in whatever window is running now, letting an extra probe
      // past halfOpenMaxProbes; the transition out of that window already
      // released every slot it held.
      if (isProbe && admittedGeneration === this.#generation) this.#probesInFlight--;
    }
  }

  snapshot(): BreakerSnapshot {
    this.#refresh();
    return {
      state: this.#state,
      config: { ...this.config },
      consecutiveFailures: this.#consecutiveFailures,
      consecutiveSuccesses: this.#consecutiveSuccesses,
      probesInFlight: this.#probesInFlight,
      msUntilHalfOpen:
        this.#state === 'OPEN'
          ? Math.max(0, this.#openedAt + this.config.openMs - Date.now())
          : null,
      lastTransition: this.#lastTransition,
    };
  }

  reset(): void {
    this.#transition('CLOSED', 'manual reset');
    this.#consecutiveFailures = 0;
    this.#consecutiveSuccesses = 0;
    this.#probesInFlight = 0;
  }

  async #withTimeout<T>(promise: Promise<T>): Promise<T> {
    const { timeoutMs } = this.config;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** OPEN expires on a timer, so state can change without any call happening. */
  #refresh(): void {
    if (this.#state === 'OPEN' && Date.now() - this.#openedAt >= this.config.openMs) {
      this.#consecutiveSuccesses = 0;
      this.#transition('HALF_OPEN', `${this.config.openMs}ms cooldown elapsed`);
    }
  }

  /**
   * Apply a result only if no transition has happened since the call was
   * admitted - deliberately stricter than "the breaker is in the same state".
   * A transition is the breaker changing its mind, so a result from before one
   * is evidence about a decision already made on newer information. That holds
   * even when the state name matches again after a full CLOSED -> OPEN ->
   * HALF_OPEN -> CLOSED round trip: those probes closed the breaker, and a
   * failure predating the outage should not count against them.
   *
   * A slow call can outlive its window entirely when the cooldown is shorter
   * than the call timeout, which is when this stops being cosmetic.
   */
  #settle(admittedGeneration: number, succeeded: boolean): void {
    if (admittedGeneration !== this.#generation) return;
    if (succeeded) this.#onSuccess();
    else this.#onFailure();
  }

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#consecutiveSuccesses++;
    if (this.#state === 'HALF_OPEN' && this.#consecutiveSuccesses >= this.config.successesToClose) {
      this.#transition('CLOSED', `${this.#consecutiveSuccesses} probes succeeded`);
    }
  }

  #onFailure(): void {
    this.#consecutiveSuccesses = 0;
    this.#consecutiveFailures++;

    if (this.#state === 'HALF_OPEN') {
      this.#open('probe failed');
    } else if (
      this.#state === 'CLOSED' &&
      this.#consecutiveFailures >= this.config.failureThreshold
    ) {
      this.#open(`${this.#consecutiveFailures} consecutive failures`);
    }
  }

  #open(reason: string): void {
    this.#openedAt = Date.now();
    this.#transition('OPEN', reason);
  }

  #transition(to: BreakerState, reason: string): void {
    if (this.#state === to) return;
    const transition: Transition = { from: this.#state, to, reason, at: Date.now() };
    this.#lastTransition = transition;
    this.#state = to;
    this.#generation++;
    // Probe slots belong to the window that just ended, whichever way we left it.
    this.#probesInFlight = 0;
    this.onTransition?.(transition);
  }
}
