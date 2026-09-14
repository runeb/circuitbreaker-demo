import express from 'express';
import { fileURLToPath } from 'node:url';
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  DEFAULT_CONFIG,
} from './breaker.ts';
import { MockDependency } from './dependency.ts';
import { logger } from './logger.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const dependency = new MockDependency();
const breaker = new CircuitBreaker(DEFAULT_CONFIG);

// State changes are the only thing worth logging per-event: individual calls
// run at several per second and would drown everything else.
breaker.onTransition = (t) =>
  logger.warn({ from: t.from, to: t.to, reason: t.reason }, 'circuit breaker state change');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/** The client-facing endpoint the browser hammers. */
app.get('/api/call', async (_req, res) => {
  const started = Date.now();
  try {
    const result = await breaker.call(() => dependency.call());
    res.json({
      ok: true,
      outcome: 'success',
      detail: result.value,
      latencyMs: Date.now() - started,
      breaker: breaker.snapshot(),
    });
  } catch (err) {
    const outcome =
      err instanceof CircuitOpenError ? 'rejected'
      : err instanceof TimeoutError ? 'timeout'
      : 'error';
    // A rejected call never reached the dependency: that's the breaker doing its job.
    res.status(outcome === 'rejected' ? 503 : 502).json({
      ok: false,
      outcome,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      breaker: breaker.snapshot(),
    });
  }
});

/** Breaker + dependency state, for polling while idle. */
app.get('/api/state', (_req, res) => {
  res.json({
    breaker: breaker.snapshot(),
    dependency: dependency.config,
    callsReceived: dependency.callsReceived,
  });
});

/** The user's knobs on the dependency. */
app.post('/api/dependency', (req, res) => {
  const { latencyMs, errorRate, down } = req.body ?? {};
  if (typeof latencyMs === 'number') dependency.config.latencyMs = clamp(latencyMs, 0, 10_000);
  if (typeof errorRate === 'number') dependency.config.errorRate = clamp(errorRate, 0, 1);
  if (typeof down === 'boolean') dependency.config.down = down;
  logger.info({ dependency: dependency.config }, 'dependency health changed');
  res.json(dependency.config);
});

app.post('/api/reset', (_req, res) => {
  breaker.reset();
  res.json(breaker.snapshot());
});

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

app.listen(PORT, () => {
  logger.info({ port: PORT, breaker: breaker.config }, 'circuit breaker demo listening');
});
