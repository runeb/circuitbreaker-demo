const $ = (id) => document.getElementById(id);

// This tab drives its own breaker and dependency. A reload starts a clean demo;
// a second tab is a second, independent one.
const SESSION_ID = crypto.randomUUID();

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { ...options.headers, 'x-demo-session': SESSION_ID },
  });
}

const WINDOW = 50;    // responses summarised by the counters
const HISTORY = 220;  // bars kept on the timeline
const recent = [];    // { outcome, latencyMs, breaker }

let rate = 8;          // requests per second
let timer = null;
let inFlight = 0;

// ---- request loop -------------------------------------------------------

function setRate(next) {
  rate = next;
  if (timer) clearInterval(timer);
  timer = null;
  $('browser-sub').textContent = rate === 0 ? 'paused' : `${rate} req/s`;
  if (rate > 0) timer = setInterval(fire, 1000 / rate);
}

async function fire() {
  // Don't let a slow dependency build an unbounded queue in the browser.
  if (inFlight > 20) return;
  inFlight++;
  try {
    const res = await api('/api/call');
    render(await res.json());
  } catch {
    render({ ok: false, outcome: 'error', status: 0, detail: 'network error', latencyMs: 0 });
  } finally {
    inFlight--;
  }
}

// ---- rendering ----------------------------------------------------------

const TONE = { success: 'ok', error: 'err', timeout: 'warn', rejected: 'rej' };

function render(r) {
  recent.push(r);
  if (recent.length > HISTORY) recent.shift();
  addTick(r);

  const tone = TONE[r.outcome] ?? 'err';
  pulse('node-browser', tone);
  pulse('node-api', tone);
  flash('edge-client', tone);

  // A rejected call never leaves the API — the dependency edge stays dark.
  if (r.outcome !== 'rejected') {
    pulse('node-dep', tone);
    flash('edge-dep', tone);
  }

  $('last-status').textContent = r.status || '---';
  $('last-status').className = `status ${tone}`;
  $('last-response').textContent =
    ` ${r.outcome.padEnd(9)} ${String(r.latencyMs).padStart(5)}ms  ${r.detail ?? ''}`;

  const window = recent.slice(-WINDOW);
  const counts = { success: 0, error: 0, timeout: 0, rejected: 0 };
  for (const x of window) counts[x.outcome] = (counts[x.outcome] ?? 0) + 1;
  $('c-success').textContent = counts.success;
  $('c-error').textContent = counts.error;
  $('c-timeout').textContent = counts.timeout;
  $('c-rejected').textContent = counts.rejected;

  const lats = window.map((x) => x.latencyMs).sort((a, b) => a - b);
  $('c-latency').textContent = lats.length ? `${lats[Math.floor(lats.length / 2)]} ms` : '–';

  if (r.breaker) renderBreaker(r.breaker);
}

// ---- timeline -----------------------------------------------------------

const laneOutcomes = $('lane-outcomes');
const laneState = $('lane-state');

/**
 * Latency on a log scale: linear would squash a healthy 20ms response into the
 * same stub as a 0ms rejection, and telling those two apart is the whole point.
 */
function barHeight(ms, timeoutMs) {
  const fullScale = timeoutMs * 1.2;
  const frac = Math.min(1, Math.log10(1 + ms) / Math.log10(1 + fullScale));
  return Math.max(4, frac * 100);
}

function addTick(r) {
  const timeoutMs = r.breaker?.config.timeoutMs ?? 1000;
  const bar = document.createElement('div');
  bar.className = `tick ${TONE[r.outcome] ?? 'err'}`;
  bar.style.height = `${barHeight(r.latencyMs, timeoutMs)}%`;
  bar.title = `${r.status ?? '---'} ${r.outcome} @ ${r.admittedIn ?? '?'} \u00b7 ${r.latencyMs}ms`;
  laneOutcomes.append(bar);

  // The band shows the state that handled each response, not the state it left
  // behind: a probe that fails has already re-opened the breaker by then, which
  // is why HALF_OPEN was never visible here.
  const state = r.admittedIn ?? r.breaker?.state ?? 'CLOSED';
  const cell = document.createElement('div');
  cell.className = `cell ${state}`;
  cell.title = `admitted in ${state}`;
  laneState.append(cell);

  while (laneOutcomes.childElementCount > HISTORY) laneOutcomes.firstElementChild.remove();
  while (laneState.childElementCount > HISTORY) laneState.firstElementChild.remove();
}

function renderBreaker(b) {
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
    b.state === 'HALF_OPEN'
      ? `${b.consecutiveSuccesses} / ${b.config.successesToClose}`
      : '–';
  $('stat-countdown').textContent =
    b.msUntilHalfOpen === null ? '–' : `${(b.msUntilHalfOpen / 1000).toFixed(1)}s`;
  $('stat-timeout').textContent = `${b.config.timeoutMs} ms`;
}

function pulse(id, tone) {
  const el = $(id);
  el.className = `node pulse-${tone}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'node'), 220);
}

function flash(id, tone) {
  const el = $(id);
  const cut = el.classList.contains('cut');
  el.className = `edge flow-${tone}${cut ? ' cut' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = `edge${cut ? ' cut' : ''}`), 220);
}

// ---- controls -----------------------------------------------------------

/** Coalesce rapid changes into one request: a single slider drag emits dozens. */
function throttle(fn, ms) {
  let timer = null;
  let last = 0;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      fn();
    }, Math.max(0, ms - (Date.now() - last)));
  };
}

let pendingPatch = {};

const flushDependency = throttle(() => {
  const patch = pendingPatch;
  pendingPatch = {};
  api('/api/dependency', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}, 80);

function pushDependency(patch) {
  Object.assign(pendingPatch, patch);
  flushDependency();
}


/** The server owns the dependency's health, so the controls start from it. */
function syncControls(dep) {
  const errorPercent = Math.round(dep.errorRate * 100);
  setControl($('in-latency'), $('out-latency'), dep.latencyMs, `${dep.latencyMs} ms`);
  setControl($('in-error'), $('out-error'), errorPercent, `${errorPercent} %`);
  if ($('in-down').checked !== dep.down) $('in-down').checked = dep.down;
  describeDependency();
}

/** Only write when the value actually differs; this runs several times a second. */
function setControl(input, output, value, label) {
  if (Number(input.value) !== value) input.value = value;
  if (output.textContent !== label) output.textContent = label;
}

function describeDependency() {
  const down = $('in-down').checked;
  const err = Number($('in-error').value);
  const lat = Number($('in-latency').value);
  $('dep-sub').textContent =
    down ? 'down' : err > 0 ? `${err}% errors, ${lat}ms` : `healthy, ${lat}ms`;
}

$('in-latency').addEventListener('input', (e) => {
  $('out-latency').textContent = `${e.target.value} ms`;
  describeDependency();
  pushDependency({ latencyMs: Number(e.target.value) });
});

$('in-error').addEventListener('input', (e) => {
  $('out-error').textContent = `${e.target.value} %`;
  describeDependency();
  pushDependency({ errorRate: Number(e.target.value) / 100 });
});

$('in-down').addEventListener('change', (e) => {
  describeDependency();
  pushDependency({ down: e.target.checked });
});

$('in-rate').addEventListener('input', (e) => {
  $('out-rate').textContent = `${e.target.value} /s`;
  setRate(Number(e.target.value));
});

$('reset').addEventListener('click', async () => {
  const res = await api('/api/reset', { method: 'POST' });
  renderBreaker(await res.json());
});

// ---- idle polling -------------------------------------------------------
// The breaker's OPEN -> HALF_OPEN transition is time-based, so keep the panel
// live (and the countdown ticking) even when no request has just returned.
setInterval(async () => {
  const res = await api('/api/state');
  const s = await res.json();
  renderBreaker(s.breaker);
  $('c-reached').textContent = s.callsReceived;
}, 200);

// Another tab (or a curl) may already have changed the dependency; don't show
// hardcoded defaults that disagree with the server.
api('/api/state')
  .then((r) => r.json())
  .then((s) => {
    syncControls(s.dependency);
    renderBreaker(s.breaker);
  })
  .catch(() => describeDependency());

setRate(rate);
