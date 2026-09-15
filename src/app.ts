/**
 * The whole demo, running in one event loop.
 *
 * The page owns a CircuitBreaker and a MockDependency, and each request the
 * graph draws is a call into the breaker. Nothing leaves the page.
 */
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  DEFAULT_CONFIG,
  type BreakerSnapshot,
  type BreakerState,
} from './breaker.ts';
import { MockDependency } from './dependency.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let breaker = new CircuitBreaker(DEFAULT_CONFIG);
let dependency = new MockDependency();

// ---- one call through the breaker ---------------------------------------

type Outcome = 'success' | 'error' | 'timeout' | 'rejected';

/**
 * The status code each outcome would carry if this were a real API, which is
 * the vocabulary the pattern is usually discussed in. 503 is the interesting
 * one: the only code here that says nothing about the dependency's health,
 * because while the breaker is open nobody is asking.
 */
const STATUS: Record<Outcome, number> = {
  success: 200,
  error: 502,
  timeout: 504,
  rejected: 503,
};

type Result = {
  outcome: Outcome;
  status: number;
  /** The state that admitted this call, which is not always the state it left behind. */
  admittedIn: BreakerState;
  detail: string;
  latencyMs: number;
  breaker: BreakerSnapshot;
};

async function callThroughBreaker(
  breaker: CircuitBreaker,
  dependency: MockDependency,
): Promise<Result> {
  const started = performance.now();

  // Snapshot before the call. Taking it first also applies any due OPEN ->
  // HALF_OPEN transition, so it names the state that actually decides this
  // call's fate: a probe that fails re-opens the breaker before the call
  // returns, so the state on the way out has forgotten it was ever a probe.
  const admittedIn = breaker.snapshot().state;
  const elapsed = () => Math.round(performance.now() - started);

  try {
    const result = await breaker.call(() => dependency.call());
    return {
      outcome: 'success',
      status: STATUS.success,
      admittedIn,
      detail: result.value,
      latencyMs: elapsed(),
      breaker: breaker.snapshot(),
    };
  } catch (err) {
    const outcome: Outcome =
      err instanceof CircuitOpenError ? 'rejected'
      : err instanceof TimeoutError ? 'timeout'
      : 'error';
    return {
      outcome,
      status: STATUS[outcome],
      admittedIn,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: elapsed(),
      breaker: breaker.snapshot(),
    };
  }
}

// ---- request loop -------------------------------------------------------

const WINDOW = 50;   // responses summarised by the counters
const HISTORY = 220; // bars kept on the timeline
const recent: Result[] = [];

let rate = 8; // calls per second
let timer: ReturnType<typeof setInterval> | null = null;

function setRate(next: number): void {
  rate = next;
  if (timer) clearInterval(timer);
  timer = null;
  $('browser-sub').textContent = rate === 0 ? 'paused' : `${rate} req/s`;
  if (rate > 0 && !document.hidden) timer = setInterval(fire, 1000 / rate);
}

async function fire(): Promise<void> {
  const run = breaker;
  const result = await callThroughBreaker(run, dependency);
  // Identity is the epoch: if the run that admitted this call has been torn
  // down, everything the call observed belongs to that discarded run.
  if (run !== breaker) return;
  render(result);
}

// ---- rendering ----------------------------------------------------------

const TONE: Record<Outcome, string> = {
  success: 'ok',
  error: 'err',
  timeout: 'warn',
  rejected: 'rej',
};

function render(r: Result): void {
  recent.push(r);
  if (recent.length > HISTORY) recent.shift();
  addTick(r);

  // Light up only the hops the call actually made: a rejected one stops at the
  // breaker and never reaches the dependency.
  const tone = TONE[r.outcome];
  pulse('node-browser', tone);
  flash('edge-client', tone);
  pulse('node-api', tone);
  if (r.outcome !== 'rejected') {
    pulse('node-dep', tone);
    flash('edge-dep', tone);
  }

  $('last-status').textContent = String(r.status);
  $('last-status').className = `status ${tone}`;
  $('last-response').textContent =
    ` ${r.outcome.padEnd(9)} ${String(r.latencyMs).padStart(5)}ms  ${r.detail}`;

  const window = recent.slice(-WINDOW);
  const counts: Record<Outcome, number> = { success: 0, error: 0, timeout: 0, rejected: 0 };
  for (const x of window) counts[x.outcome]++;
  $('c-success').textContent = String(counts.success);
  $('c-error').textContent = String(counts.error);
  $('c-timeout').textContent = String(counts.timeout);
  $('c-rejected').textContent = String(counts.rejected);

  const lats = window.map((x) => x.latencyMs).sort((a, b) => a - b);
  $('c-latency').textContent = lats.length ? `${lats[Math.floor(lats.length / 2)]} ms` : '–';

  renderBreaker(r.breaker);
}

// ---- timeline -----------------------------------------------------------

const laneOutcomes = $('lane-outcomes');
const laneState = $('lane-state');

/**
 * Latency on a log scale: linear would squash a healthy 20ms response into the
 * same stub as a 0ms rejection, and telling those two apart is the whole point.
 */
function barHeight(ms: number, timeoutMs: number): number {
  const fullScale = timeoutMs * 1.2;
  const frac = Math.min(1, Math.log10(1 + ms) / Math.log10(1 + fullScale));
  return Math.max(4, frac * 100);
}

function addTick(r: Result): void {
  const bar = document.createElement('div');
  bar.className = `tick ${TONE[r.outcome]}`;
  bar.style.height = `${barHeight(r.latencyMs, r.breaker.config.timeoutMs)}%`;
  bar.title = `${r.status} ${r.outcome} @ ${r.admittedIn} · ${r.latencyMs}ms`;
  laneOutcomes.append(bar);

  // The band shows the state that handled each response, which is what makes
  // HALF_OPEN visible: a failing probe re-opens the breaker before the call
  // returns, so the state on the way out no longer names the one that ran it.
  const cell = document.createElement('div');
  cell.className = `cell ${r.admittedIn}`;
  cell.title = `admitted in ${r.admittedIn}`;
  laneState.append(cell);

  while (laneOutcomes.childElementCount > HISTORY) laneOutcomes.firstElementChild!.remove();
  while (laneState.childElementCount > HISTORY) laneState.firstElementChild!.remove();
}

function renderBreaker(b: BreakerSnapshot): void {
  $('state-badge').textContent = b.state;
  $('state-badge').className = `state ${b.state}`;
  $('breaker-inline').textContent = b.state;
  $('breaker-pip').className =
    'breaker-pip' + (b.state === 'OPEN' ? ' open' : b.state === 'HALF_OPEN' ? ' half' : '');
  $('edge-dep').classList.toggle('cut', b.state === 'OPEN');

  $('state-reason').textContent = b.lastTransition
    ? `${b.lastTransition.from} → ${b.lastTransition.to}: ${b.lastTransition.reason}`
    : 'no transitions yet';

  $('stat-fails').textContent = `${b.consecutiveFailures} / ${b.config.failureThreshold}`;
  $('stat-successes').textContent =
    b.state === 'HALF_OPEN' ? `${b.consecutiveSuccesses} / ${b.config.successesToClose}` : '–';
  $('stat-countdown').textContent =
    b.msUntilHalfOpen === null ? '–' : `${(b.msUntilHalfOpen / 1000).toFixed(1)}s`;
  $('stat-timeout').textContent = `${b.config.timeoutMs} ms`;
}

const restoreTimers = new Map<Element, ReturnType<typeof setTimeout>>();

function pulse(id: string, tone: string): void {
  const el = $(id);
  el.className = `node pulse-${tone}`;
  clearTimeout(restoreTimers.get(el));
  restoreTimers.set(el, setTimeout(() => (el.className = 'node'), 220));
}

const FLOW_TONES = ['flow-ok', 'flow-err', 'flow-warn', 'flow-rej'];

/**
 * Touch only the flow-* classes, so the dashed `cut` edge that renderBreaker
 * owns survives a flash. An open circuit has to stay visibly cut while calls
 * are still bouncing off it.
 */
function flash(id: string, tone: string): void {
  const el = $(id);
  clearTimeout(restoreTimers.get(el));
  el.classList.remove(...FLOW_TONES);
  el.classList.add(`flow-${tone}`);
  restoreTimers.set(el, setTimeout(() => el.classList.remove(`flow-${tone}`), 220));
}

// ---- controls -----------------------------------------------------------

function describeDependency(): void {
  const { down, errorRate, latencyMs } = dependency.config;
  const percent = Math.round(errorRate * 100);
  $('dep-sub').textContent =
    down ? 'down' : percent > 0 ? `${percent}% errors, ${latencyMs}ms` : `healthy, ${latencyMs}ms`;
}

$('in-latency').addEventListener('input', (e) => {
  const value = Number((e.target as HTMLInputElement).value);
  $('out-latency').textContent = `${value} ms`;
  dependency.config.latencyMs = value;
  describeDependency();
});

$('in-error').addEventListener('input', (e) => {
  const value = Number((e.target as HTMLInputElement).value);
  $('out-error').textContent = `${value} %`;
  dependency.config.errorRate = value / 100;
  describeDependency();
});

$('in-down').addEventListener('change', (e) => {
  dependency.config.down = (e.target as HTMLInputElement).checked;
  describeDependency();
});

$('in-rate').addEventListener('input', (e) => {
  const value = Number((e.target as HTMLInputElement).value);
  $('out-rate').textContent = `${value} /s`;
  setRate(value);
});

$('reset').addEventListener('click', () => {
  breaker.reset();
  renderBreaker(breaker.snapshot());
});

// ---- idle tick ----------------------------------------------------------
// The breaker's OPEN -> HALF_OPEN transition is time-based, so keep the panel
// live (and the countdown ticking) even when no call has just returned.
setInterval(() => {
  renderBreaker(breaker.snapshot());
  $('c-reached').textContent = String(dependency.callsReceived);
}, 200);

// ---- running only while watched -----------------------------------------

/** The controls are the source of truth for the dependency's health. */
function applyControls(): void {
  dependency.config.latencyMs = Number(($('in-latency') as HTMLInputElement).value);
  dependency.config.errorRate = Number(($('in-error') as HTMLInputElement).value) / 100;
  dependency.config.down = ($('in-down') as HTMLInputElement).checked;
  describeDependency();
}

function clearReadouts(): void {
  recent.length = 0;
  laneOutcomes.replaceChildren();
  laneState.replaceChildren();
  for (const id of ['c-success', 'c-error', 'c-timeout', 'c-rejected', 'c-reached']) {
    $(id).textContent = '0';
  }
  $('c-latency').textContent = '–';
  $('last-status').textContent = '---';
  $('last-status').className = 'status';
  $('last-response').textContent = '';
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Browsers clamp timers in a hidden tab, and this simulation is built out of
 * them: a 20ms dependency takes most of a second, and the breaker's own timeout
 * stretches with it, so a healthy dependency starts recording timeouts. None of
 * that is worth drawing, and a breaker fed on it would be lying by the time you
 * looked again.
 *
 * So the demo runs only while it is being watched. Leaving discards the run
 * outright rather than pausing it, which keeps calls that settle mid-teardown
 * from reaching a breaker anyone will see. Coming back starts a clean one, with
 * the controls carrying over because they are what the run reads from.
 */
function start(): void {
  stop();
  breaker = new CircuitBreaker(DEFAULT_CONFIG);
  dependency = new MockDependency();
  applyControls();
  clearReadouts();
  renderBreaker(breaker.snapshot());
  setRate(rate);
}

document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

start();
