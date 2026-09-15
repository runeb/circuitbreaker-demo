import express from 'express';
import { fileURLToPath } from 'node:url';
import { CircuitOpenError, TimeoutError, DEFAULT_CONFIG } from './breaker.ts';
import { SessionStore, type Session } from './sessions.ts';
import { logger } from './logger.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const sessions = new SessionStore({
  // State changes are the only per-call event worth logging: individual calls run
  // at several per second and would drown everything else.
  onTransition: (session, t) =>
    logger.warn(
      { session: short(session.id), from: t.from, to: t.to, reason: t.reason },
      'circuit breaker state change',
    ),
});

/**
 * Each viewer drives their own breaker and dependency, keyed by an id the page
 * generates on load. Reloading gets you a clean demo; a second tab is a second,
 * independent one.
 */
function sessionFor(req: express.Request): Session {
  const raw = req.get('x-demo-session');
  const id = typeof raw === 'string' && /^[\w-]{8,64}$/.test(raw) ? raw : 'anonymous';
  return sessions.get(id);
}

function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * Each outcome gets the status code it actually deserves, so the demo teaches
 * the right vocabulary: 503 is us shedding load on purpose, and it is the only
 * one of the three that says nothing about the dependency's health.
 */
const STATUS = {
  success: 200,
  error: 502, // Bad Gateway - the dependency answered badly
  timeout: 504, // Gateway Timeout - the dependency was too slow
  rejected: 503, // Service Unavailable - we never called it
} as const;

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/**
 * Every API response is a fresh observation; none of it is reusable.
 *
 * Saying so matters more than it looks. Without it the browser treats
 * concurrent GETs to the same URL as candidates for the same cache entry and
 * serialises them, waiting to see whether the first response can satisfy the
 * rest. With a slow dependency that turns the demo's parallel request stream
 * into a queue: at 940ms latency, six calls took 5.7s instead of 1s, the state
 * polls stalled behind them, and the countdown visibly stuttered.
 */
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/** The client-facing endpoint the browser hammers. */
app.get('/api/call', async (req, res) => {
  const { breaker, dependency } = sessionFor(req);
  const started = Date.now();

  // Snapshot before the call, not just after. Taking it first also applies any
  // due OPEN -> HALF_OPEN transition, so this names the state that actually
  // decides this request's fate. A probe that fails re-opens the breaker before
  // the call returns, so the state on the way out has already forgotten that
  // this request was ever admitted as a probe.
  const admittedIn = breaker.snapshot().state;

  try {
    const result = await breaker.call(() => dependency.call());
    res.status(STATUS.success).json({
      ok: true,
      outcome: 'success',
      status: STATUS.success,
      admittedIn,
      detail: result.value,
      latencyMs: Date.now() - started,
      breaker: breaker.snapshot(),
    });
  } catch (err) {
    const outcome =
      err instanceof CircuitOpenError ? 'rejected'
      : err instanceof TimeoutError ? 'timeout'
      : 'error';
    const breakerState = breaker.snapshot();

    // A rejected call never reached the dependency: that's the breaker doing its
    // job. Say when it's worth trying again, as a real shedding service would.
    if (outcome === 'rejected' && breakerState.msUntilHalfOpen !== null) {
      res.set('Retry-After', String(Math.ceil(breakerState.msUntilHalfOpen / 1000)));
    }

    res.status(STATUS[outcome]).json({
      ok: false,
      outcome,
      status: STATUS[outcome],
      admittedIn,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      breaker: breakerState,
    });
  }
});

/** Breaker + dependency state, for polling while idle. */
app.get('/api/state', (req, res) => {
  const { breaker, dependency } = sessionFor(req);
  res.json({
    breaker: breaker.snapshot(),
    dependency: dependency.config,
    callsReceived: dependency.callsReceived,
    viewers: sessions.size,
  });
});

/** The user's knobs on their own dependency. */
app.post('/api/dependency', (req, res) => {
  const session = sessionFor(req);
  const { latencyMs, errorRate, down } = req.body ?? {};
  const config = session.dependency.config;

  if (typeof latencyMs === 'number') config.latencyMs = clamp(latencyMs, 0, 10_000);
  if (typeof errorRate === 'number') config.errorRate = clamp(errorRate, 0, 1);
  if (typeof down === 'boolean') config.down = down;

  logger.info({ session: short(session.id), dependency: config }, 'dependency health changed');
  res.json(config);
});

app.post('/api/reset', (req, res) => {
  const { breaker } = sessionFor(req);
  breaker.reset();
  res.json(breaker.snapshot());
});

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

app.listen(PORT, () => {
  logger.info({ port: PORT, breaker: DEFAULT_CONFIG }, 'circuit breaker demo listening');
});
