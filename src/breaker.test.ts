import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  type BreakerConfig,
} from './breaker.ts';

const CONFIG: BreakerConfig = {
  failureThreshold: 3,
  openMs: 5000,
  successesToClose: 2,
  halfOpenMaxProbes: 2,
  timeoutMs: 1000,
};

/** A call that always succeeds, counting how many times it actually ran. */
function ok(value = 'ok') {
  const fn = vi.fn(async () => value);
  return fn;
}

/** A call that always fails. */
function fails(message = 'boom') {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

/** A call whose settlement the test controls. */
function controlled() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const gate = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const fn = vi.fn(() => gate);
  return { fn, resolve, reject };
}

let breaker: CircuitBreaker;

beforeEach(() => {
  vi.useFakeTimers();
  breaker = new CircuitBreaker(CONFIG);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Drive the breaker to OPEN via consecutive failures. */
async function trip() {
  const fn = fails();
  for (let i = 0; i < CONFIG.failureThreshold; i++) {
    await expect(breaker.call(fn)).rejects.toThrow('boom');
  }
  expect(breaker.snapshot().state).toBe('OPEN');
}

/** Move an OPEN breaker past its cooldown. */
async function coolDown() {
  await vi.advanceTimersByTimeAsync(CONFIG.openMs);
}

describe('CLOSED', () => {
  it('passes calls through and returns the result', async () => {
    const fn = ok('value');
    await expect(breaker.call(fn)).resolves.toBe('value');
    expect(fn).toHaveBeenCalledOnce();
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('propagates the dependency error rather than masking it', async () => {
    await expect(breaker.call(fails('upstream 500'))).rejects.toThrow('upstream 500');
  });

  it('stays closed below the failure threshold', async () => {
    const fn = fails();
    for (let i = 0; i < CONFIG.failureThreshold - 1; i++) {
      await expect(breaker.call(fn)).rejects.toThrow();
    }
    const s = breaker.snapshot();
    expect(s.state).toBe('CLOSED');
    expect(s.consecutiveFailures).toBe(CONFIG.failureThreshold - 1);
  });

  it('requires failures to be consecutive: one success resets the count', async () => {
    await expect(breaker.call(fails())).rejects.toThrow();
    await expect(breaker.call(fails())).rejects.toThrow();
    await expect(breaker.call(ok())).resolves.toBe('ok');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);

    // Two more failures would have tripped it without the success in between.
    await expect(breaker.call(fails())).rejects.toThrow();
    await expect(breaker.call(fails())).rejects.toThrow();
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('trips to OPEN on the threshold-th consecutive failure', async () => {
    await trip();
    expect(breaker.snapshot().lastTransition).toMatchObject({
      from: 'CLOSED',
      to: 'OPEN',
      reason: `${CONFIG.failureThreshold} consecutive failures`,
    });
  });

  it('counts timeouts toward the threshold', async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r('late'), 60_000));
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      // Catch up front: the rejection lands while the clock is being advanced.
      const call = breaker.call(slow).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
      expect(await call).toBeInstanceOf(TimeoutError);
    }
    expect(breaker.snapshot().state).toBe('OPEN');
  });
});

describe('OPEN', () => {
  beforeEach(trip);

  it('rejects without ever invoking the dependency', async () => {
    const fn = ok();
    await expect(breaker.call(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fast-fails: no timers need to advance for the rejection to settle', async () => {
    // If the breaker were waiting on anything, this would hang under fake timers.
    await expect(breaker.call(ok())).rejects.toThrow('circuit open');
  });

  it('reports a countdown that shrinks toward the cooldown', async () => {
    expect(breaker.snapshot().msUntilHalfOpen).toBe(CONFIG.openMs);
    await vi.advanceTimersByTimeAsync(CONFIG.openMs / 2);
    expect(breaker.snapshot().msUntilHalfOpen).toBe(CONFIG.openMs / 2);
  });

  it('moves to HALF_OPEN on time alone, with no call to drive it', async () => {
    await coolDown();
    const s = breaker.snapshot();
    expect(s.state).toBe('HALF_OPEN');
    expect(s.msUntilHalfOpen).toBeNull();
    expect(s.lastTransition).toMatchObject({ from: 'OPEN', to: 'HALF_OPEN' });
  });
});

describe('HALF_OPEN', () => {
  beforeEach(async () => {
    await trip();
    await coolDown();
    expect(breaker.snapshot().state).toBe('HALF_OPEN');
  });

  it('admits at most halfOpenMaxProbes concurrent probes and rejects the rest', async () => {
    const probes = Array.from({ length: CONFIG.halfOpenMaxProbes }, () => controlled());
    const inFlight = probes.map((p) => breaker.call(p.fn));

    expect(breaker.snapshot().probesInFlight).toBe(CONFIG.halfOpenMaxProbes);

    const overflow = ok();
    await expect(breaker.call(overflow)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(overflow).not.toHaveBeenCalled();

    probes.forEach((p) => p.resolve('ok'));
    await Promise.all(inFlight);
  });

  it('releases probe slots once probes settle', async () => {
    const probe = controlled();
    const inFlight = breaker.call(probe.fn);
    expect(breaker.snapshot().probesInFlight).toBe(1);

    probe.reject(new Error('boom'));
    await expect(inFlight).rejects.toThrow('boom');
    expect(breaker.snapshot().probesInFlight).toBe(0);
  });

  it('closes after successesToClose successful probes', async () => {
    for (let i = 0; i < CONFIG.successesToClose; i++) {
      await expect(breaker.call(ok())).resolves.toBe('ok');
    }
    const s = breaker.snapshot();
    expect(s.state).toBe('CLOSED');
    expect(s.lastTransition).toMatchObject({
      from: 'HALF_OPEN',
      to: 'CLOSED',
      reason: `${CONFIG.successesToClose} probes succeeded`,
    });
  });

  it('stays half-open while it still needs more successes', async () => {
    await expect(breaker.call(ok())).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('HALF_OPEN');
  });

  it('re-opens on a single probe failure, however many succeeded first', async () => {
    await expect(breaker.call(ok())).resolves.toBe('ok');
    await expect(breaker.call(fails())).rejects.toThrow('boom');

    const s = breaker.snapshot();
    expect(s.state).toBe('OPEN');
    expect(s.lastTransition).toMatchObject({ to: 'OPEN', reason: 'probe failed' });
  });

  it('restarts the full cooldown when a probe fails', async () => {
    await expect(breaker.call(fails())).rejects.toThrow();
    expect(breaker.snapshot().msUntilHalfOpen).toBe(CONFIG.openMs);
  });

  it('drops the success count when a probe fails, so recovery starts over', async () => {
    await expect(breaker.call(ok())).resolves.toBe('ok');
    await expect(breaker.call(fails())).rejects.toThrow();
    await coolDown();

    // One success is no longer enough — it must reach successesToClose again.
    await expect(breaker.call(ok())).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('HALF_OPEN');
  });
});

describe('reset', () => {
  it('forces an OPEN breaker closed and clears the counters', async () => {
    await trip();
    breaker.reset();

    const s = breaker.snapshot();
    expect(s.state).toBe('CLOSED');
    expect(s.consecutiveFailures).toBe(0);
    expect(s.probesInFlight).toBe(0);
    expect(s.msUntilHalfOpen).toBeNull();

    const fn = ok();
    await expect(breaker.call(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('transitions', () => {
  it('notifies onTransition exactly once per state change', async () => {
    const seen: string[] = [];
    breaker.onTransition = (t) => seen.push(`${t.from}->${t.to}`);

    await trip();
    await coolDown();
    for (let i = 0; i < CONFIG.successesToClose; i++) await breaker.call(ok());

    expect(seen).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  it('does not fire while the state is unchanged', async () => {
    const onTransition = vi.fn();
    breaker.onTransition = onTransition;

    await breaker.call(ok());
    await expect(breaker.call(fails())).rejects.toThrow();
    expect(onTransition).not.toHaveBeenCalled();
  });
});
