import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './sessions.ts';

const IDLE_MS = 60_000;

let store: SessionStore;

beforeEach(() => {
  vi.useFakeTimers();
  store = new SessionStore({ idleMs: IDLE_MS });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  it('creates a session on first sight and reuses it after', () => {
    const first = store.get('viewer-a');
    const second = store.get('viewer-a');
    expect(second).toBe(first);
    expect(store.size).toBe(1);
  });

  it('gives each viewer an independent breaker and dependency', () => {
    const a = store.get('viewer-a');
    const b = store.get('viewer-b');

    expect(a.breaker).not.toBe(b.breaker);
    expect(a.dependency).not.toBe(b.dependency);

    a.dependency.config.down = true;
    expect(b.dependency.config.down).toBe(false);
  });

  it('evicts a session once it has been idle past the timeout', () => {
    store.get('viewer-a');
    expect(store.size).toBe(1);

    vi.advanceTimersByTime(IDLE_MS + 1);
    store.sweep(Date.now(), true);
    expect(store.size).toBe(0);
  });

  it('keeps a session alive while it is still being used', () => {
    store.get('viewer-a');

    // Three-quarters of the timeout, twice over: idle would have evicted it.
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(IDLE_MS * 0.75);
      store.get('viewer-a');
    }

    store.sweep(Date.now(), true);
    expect(store.size).toBe(1);
  });

  it('evicts only the idle viewers', () => {
    store.get('stale');
    vi.advanceTimersByTime(IDLE_MS + 1);
    store.get('fresh');

    store.sweep(Date.now(), true);
    expect(store.size).toBe(1);
    expect(store.get('fresh').id).toBe('fresh');
  });

  it('reports transitions tagged with the session that produced them', async () => {
    const seen: Array<{ id: string; from: string; to: string }> = [];
    const tracked = new SessionStore({
      idleMs: IDLE_MS,
      onTransition: (session, t) => seen.push({ id: session.id, from: t.from, to: t.to }),
    });

    const a = tracked.get('viewer-a');
    tracked.get('viewer-b'); // a bystander, which must not appear in the log

    const fails = async () => {
      throw new Error('boom');
    };
    for (let i = 0; i < a.breaker.config.failureThreshold; i++) {
      await expect(a.breaker.call(fails)).rejects.toThrow('boom');
    }

    expect(seen).toEqual([{ id: 'viewer-a', from: 'CLOSED', to: 'OPEN' }]);
  });

  it('starts a rebuilt session from clean state after eviction', () => {
    store.get('viewer-a').dependency.config.down = true;

    vi.advanceTimersByTime(IDLE_MS + 1);
    store.sweep(Date.now(), true);

    expect(store.get('viewer-a').dependency.config.down).toBe(false);
  });
});
