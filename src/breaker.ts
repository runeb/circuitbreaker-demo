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
  timeoutMs: 1000,
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

    try {
      const result = await this.#withTimeout(fn());
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure();
      throw err;
    } finally {
      if (isProbe) this.#probesInFlight = Math.max(0, this.#probesInFlight - 1);
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
      this.#probesInFlight = 0;
      this.#transition('HALF_OPEN', `${this.config.openMs}ms cooldown elapsed`);
    }
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
    this.#probesInFlight = 0;
    this.#transition('OPEN', reason);
  }

  #transition(to: BreakerState, reason: string): void {
    if (this.#state === to) return;
    const transition: Transition = { from: this.#state, to, reason, at: Date.now() };
    this.#lastTransition = transition;
    this.#state = to;
    this.onTransition?.(transition);
  }
}
