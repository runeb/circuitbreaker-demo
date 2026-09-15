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

describe('calls that outlive the state that admitted them', () => {
  it('does not count a failure that lands after the breaker already tripped', async () => {
    const stale = controlled();
    const inFlight = breaker.call(stale.fn);

    await trip();
    const before = breaker.snapshot();

    stale.reject(new Error('late'));
    await expect(inFlight).rejects.toThrow('late');

    const after = breaker.snapshot();
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
    expect(after.consecutiveFailures).toBe(CONFIG.failureThreshold);
  });

  it('does not let a stale failure push the count past the threshold', async () => {
    const stale = [controlled(), controlled(), controlled()];
    const inFlight = stale.map((c) => breaker.call(c.fn).catch(() => {}));

    await trip();
    stale.forEach((c) => c.reject(new Error('late')));
    await Promise.all(inFlight);

    // The panel reads "N / threshold"; N climbing past the threshold is nonsense.
    expect(breaker.snapshot().consecutiveFailures).toBe(CONFIG.failureThreshold);
  });

  it('does not let a stale failure restart the cooldown', async () => {
    const stale = controlled();
    const inFlight = breaker.call(stale.fn).catch(() => {});

    await trip();
    // Stay inside the call timeout so the rejection below is what settles it.
    await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs / 2);
    const remaining = breaker.snapshot().msUntilHalfOpen;

    stale.reject(new Error('late'));
    await inFlight;

    expect(breaker.snapshot().msUntilHalfOpen).toBe(remaining);
  });

  it('does not let a stale success clear the failures that tripped it', async () => {
    const stale = controlled();
    const inFlight = breaker.call(stale.fn);

    await trip();
    stale.resolve('late');
    await expect(inFlight).resolves.toBe('late');

    const s = breaker.snapshot();
    expect(s.state).toBe('OPEN');
    expect(s.consecutiveFailures).toBe(CONFIG.failureThreshold);
  });

  it('ignores a probe that succeeds after a sibling probe re-opened the breaker', async () => {
    await trip();
    await coolDown();

    const winner = controlled();
    const loser = controlled();
    const probeA = breaker.call(winner.fn);
    const probeB = breaker.call(loser.fn);

    loser.reject(new Error('boom'));
    await expect(probeB).rejects.toThrow('boom');
    expect(breaker.snapshot().state).toBe('OPEN');

    winner.resolve('ok');
    await expect(probeA).resolves.toBe('ok');

    const s = breaker.snapshot();
    expect(s.state).toBe('OPEN');
    expect(s.consecutiveSuccesses).toBe(0);
  });

  it('does not let a stale probe free a slot in a later window', async () => {
    // A cooldown shorter than the call timeout lets a probe outlive its window,
    // so its slot release can land while a later window is using the slots.
    const shortCooldown = new CircuitBreaker({ ...CONFIG, openMs: 200, timeoutMs: 5000 });
    const fail = fails();
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      await expect(shortCooldown.call(fail)).rejects.toThrow();
    }

    await vi.advanceTimersByTimeAsync(200);
    const orphan = controlled();
    const orphaned = shortCooldown.call(orphan.fn).catch(() => {});

    // End that window and open a fresh one, then fill it.
    await expect(shortCooldown.call(fail)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    const current = Array.from({ length: CONFIG.halfOpenMaxProbes }, () => controlled());
    const inFlight = current.map((p) => shortCooldown.call(p.fn));
    expect(shortCooldown.snapshot().probesInFlight).toBe(CONFIG.halfOpenMaxProbes);

    orphan.resolve('late');
    await orphaned;

    // The orphan's slot was never this window's to give back.
    expect(shortCooldown.snapshot().probesInFlight).toBe(CONFIG.halfOpenMaxProbes);
    const overflow = ok();
    await expect(shortCooldown.call(overflow)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(overflow).not.toHaveBeenCalled();

    current.forEach((p) => p.resolve('ok'));
    await Promise.all(inFlight);
  });

  it('ignores a call that settles after a full round trip back to CLOSED', async () => {
    // Its timeout has to outlive the cooldown, or the call settles while OPEN
    // and never reaches the round trip this test is about.
    const patient = new CircuitBreaker({ ...CONFIG, timeoutMs: CONFIG.openMs * 10 });
    const stale = controlled();
    const inFlight = patient.call(stale.fn).catch(() => {});

    const fail = fails();
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      await expect(patient.call(fail)).rejects.toThrow();
    }
    await vi.advanceTimersByTimeAsync(CONFIG.openMs);
    for (let i = 0; i < CONFIG.successesToClose; i++) {
      await expect(patient.call(ok())).resolves.toBe('ok');
    }
    expect(patient.snapshot().state).toBe('CLOSED');

    // Same state name, but a different epoch: those probes closed the breaker on
    // newer evidence than this call, which was admitted before the outage.
    stale.reject(new Error('late'));
    await inFlight;

    expect(patient.snapshot().consecutiveFailures).toBe(0);
    expect(patient.snapshot().state).toBe('CLOSED');
  });

  it('leaves no probe slots held once a window closes the breaker', async () => {
    await trip();
    await coolDown();

    const probe = controlled();
    const inFlight = breaker.call(probe.fn);
    for (let i = 0; i < CONFIG.successesToClose; i++) {
      await expect(breaker.call(ok())).resolves.toBe('ok');
    }
    expect(breaker.snapshot().state).toBe('CLOSED');

    probe.resolve('ok');
    await inFlight;
    expect(breaker.snapshot().probesInFlight).toBe(0);
  });

  it('keeps a stale probe out of the next half-open window', async () => {
    // A cooldown shorter than the call timeout lets a probe outlive its own
    // window entirely, so its result can arrive during a later one.
    const shortCooldown = new CircuitBreaker({ ...CONFIG, openMs: 200, timeoutMs: 5000 });
    const fail = fails();
    for (let i = 0; i < CONFIG.failureThreshold; i++) {
      await expect(shortCooldown.call(fail)).rejects.toThrow();
    }

    await vi.advanceTimersByTimeAsync(200);
    expect(shortCooldown.snapshot().state).toBe('HALF_OPEN');

    const orphan = controlled();
    const probe = shortCooldown.call(orphan.fn).catch(() => {});

    // Its window ends: a sibling probe fails, and a fresh cooldown elapses.
    await expect(shortCooldown.call(fail)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    expect(shortCooldown.snapshot().state).toBe('HALF_OPEN');

    orphan.resolve('ok');
    await probe;

    // Counting it here would be one success toward closing a window it never ran in.
    expect(shortCooldown.snapshot().consecutiveSuccesses).toBe(0);
    expect(shortCooldown.snapshot().state).toBe('HALF_OPEN');
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
