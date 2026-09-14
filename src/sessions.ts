import { CircuitBreaker, DEFAULT_CONFIG, type Transition } from './breaker.ts';
import { MockDependency } from './dependency.ts';

/**
 * One breaker and one dependency per viewer.
 *
 * A real circuit breaker is per API instance and shared by everyone hitting it;
 * that is the whole point of it holding state. This demo gives each viewer their
 * own so two people poking at it don't silently trip each other's breaker.
 */
export type Session = {
  id: string;
  breaker: CircuitBreaker;
  dependency: MockDependency;
  lastSeen: number;
};

const IDLE_TIMEOUT_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 1000;

export class SessionStore {
  #sessions = new Map<string, Session>();
  #idleMs: number;
  #lastSweep = 0;
  #onTransition?: (session: Session, t: Transition) => void;

  constructor(options: {
    idleMs?: number;
    onTransition?: (session: Session, t: Transition) => void;
  } = {}) {
    this.#idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
    this.#onTransition = options.onTransition;
  }

  /** Fetch a viewer's session, creating it on first sight. */
  get(id: string, now = Date.now()): Session {
    this.sweep(now);

    let session = this.#sessions.get(id);
    if (!session) {
      session = {
        id,
        breaker: new CircuitBreaker(DEFAULT_CONFIG),
        dependency: new MockDependency(),
        lastSeen: now,
      };
      session.breaker.onTransition = (t) => this.#onTransition?.(session!, t);
      this.#sessions.set(id, session);
    }

    session.lastSeen = now;
    return session;
  }

  /** Drop sessions nobody has touched recently, so closed tabs don't accumulate. */
  sweep(now = Date.now(), force = false): number {
    if (!force && now - this.#lastSweep < SWEEP_INTERVAL_MS) return 0;
    this.#lastSweep = now;

    let evicted = 0;
    for (const [id, session] of this.#sessions) {
      if (now - session.lastSeen > this.#idleMs) {
        this.#sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.#sessions.size;
  }
}
