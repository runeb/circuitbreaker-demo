/**
 * A mock downstream dependency whose health the user controls from the UI.
 *
 * Three independent knobs, matching the ways real dependencies misbehave:
 *   latencyMs - it's slow (the breaker's timeout decides when slow == failed)
 *   errorRate - it fails some of the time (partial degradation)
 *   down      - it's gone (every call fails immediately)
 */

export type DependencyConfig = {
  latencyMs: number;
  /** 0..1 */
  errorRate: number;
  down: boolean;
};

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

export class MockDependency {
  config: DependencyConfig = { latencyMs: 20, errorRate: 0, down: false };

  /** Calls actually made (i.e. not fast-failed by the breaker). */
  callsReceived = 0;

  async call(): Promise<{ value: string; latencyMs: number }> {
    this.callsReceived++;
    const started = Date.now();

    if (this.config.down) throw new DependencyError('connection refused');

    await new Promise((r) => setTimeout(r, this.config.latencyMs));

    if (Math.random() < this.config.errorRate) {
      throw new DependencyError('500 internal error');
    }
    return { value: 'ok', latencyMs: Date.now() - started };
  }
}
