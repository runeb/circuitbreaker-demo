const $ = (id) => document.getElementById(id);

const WINDOW = 50;
const recent = []; // { outcome, latencyMs }

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
    const res = await fetch('/api/call');
    render(await res.json());
  } catch {
    render({ ok: false, outcome: 'error', detail: 'network error', latencyMs: 0 });
  } finally {
    inFlight--;
  }
}

// ---- rendering ----------------------------------------------------------

const TONE = { success: 'ok', error: 'err', timeout: 'warn', rejected: 'rej' };

function render(r) {
  recent.push(r);
  if (recent.length > WINDOW) recent.shift();

  const tone = TONE[r.outcome] ?? 'err';
  pulse('node-browser', tone);
  pulse('node-api', tone);
  flash('edge-client', tone);

  // A rejected call never leaves the API — the dependency edge stays dark.
  if (r.outcome !== 'rejected') {
    pulse('node-dep', tone);
    flash('edge-dep', tone);
  }

  $('last-response').textContent = `${r.outcome.padEnd(9)} ${String(r.latencyMs).padStart(5)}ms  ${r.detail ?? ''}`;

  const counts = { success: 0, error: 0, timeout: 0, rejected: 0 };
  for (const x of recent) counts[x.outcome] = (counts[x.outcome] ?? 0) + 1;
  $('c-success').textContent = counts.success;
  $('c-error').textContent = counts.error;
  $('c-timeout').textContent = counts.timeout;
  $('c-rejected').textContent = counts.rejected;

  const lats = recent.map((x) => x.latencyMs).sort((a, b) => a - b);
  $('c-latency').textContent = lats.length ? `${lats[Math.floor(lats.length / 2)]} ms` : '–';

  if (r.breaker) renderBreaker(r.breaker);
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

async function pushDependency(patch) {
  await fetch('/api/dependency', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
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
  const res = await fetch('/api/reset', { method: 'POST' });
  renderBreaker(await res.json());
});

// ---- idle polling -------------------------------------------------------
// The breaker's OPEN -> HALF_OPEN transition is time-based, so keep the panel
// live (and the countdown ticking) even when no request has just returned.
setInterval(async () => {
  const res = await fetch('/api/state');
  const s = await res.json();
  renderBreaker(s.breaker);
  $('c-reached').textContent = s.callsReceived;
}, 200);

describeDependency();
setRate(rate);
