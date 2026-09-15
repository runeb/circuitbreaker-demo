# Circuit breaker demo

An interactive demo of infrastructure that degrades predictably under stress.

**[Open the demo](https://runeb.github.io/circuitbreaker-demo/)**

A browser calls an API, which reaches a dependency through a circuit breaker.
You break the dependency; the page shows what happens to the calls and to the
breaker, as it happens.

```
Browser  ──────▶  API  ──╫──▶  Dependency
                   circuit breaker
```

All three are simulated in the page. They are objects in one event loop, and a
request is a call into the breaker. Nothing leaves the browser, so there is
nothing to deploy but static files.

## Run it

```sh
npm install
npm run dev        # http://localhost:8000, rebuilds on save
npm run build      # bundles public/bundle.js
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## What you can do

Three knobs on the dependency, matching the ways real ones misbehave:

| Control | What it shows |
| --- | --- |
| **Latency** | slow is a kind of broken. Past the call timeout, the breaker treats it as failure |
| **Error rate** | partial degradation, which is more common than a clean outage |
| **Take it down** | every call fails immediately |

Watch for the moment the breaker opens: calls stop reaching the dependency and
start failing instantly instead. The `Calls reaching dep.` counter freezes, which
is the breaker earning its keep.

## Reading the page

- **Graph**: the three nodes flash per call. When the breaker is open, the
  right-hand edge goes dashed and the Dependency node stops lighting up.
- **Timeline**: one bar per response, newest on the right, height is latency on a
  log scale. Underneath, a band showing which breaker state handled that response.
- **Responses**: outcome counts with the status code each maps to, and the latest
  response in full.
- **Breaker**: current state, why it last changed, and the countdown to its next
  probe.

Each outcome carries the status code a real service would answer with, because
that is the vocabulary the pattern is usually discussed in:

| Code | Outcome | Meaning |
| --- | --- | --- |
| `200` | success | the dependency answered |
| `502` | error | it answered badly |
| `504` | timeout | it was too slow |
| `503` | rejected | we never called it |

`503` is the interesting one. It is the only code here that says nothing about the
dependency's health, because while the breaker is open nobody is asking. The
probes in half-open are how it finds out again, cheaply.

## The breaker

Hand-rolled in [`src/breaker.ts`](src/breaker.ts), about 200 lines, with the state
machine as the only thing in it. Defaults:

| Setting | Default | |
| --- | --- | --- |
| `failureThreshold` | 5 | consecutive failures that trip it |
| `openMs` | 6000 | how long it stays open before probing |
| `successesToClose` | 3 | probes that must succeed to close it |
| `halfOpenMaxProbes` | 2 | probes allowed in flight at once |
| `timeoutMs` | 500 | a call slower than this counts as a failure |

Its invariants are covered in [`src/breaker.test.ts`](src/breaker.test.ts), which
is where to look first: the tests describe the state machine more precisely than
prose can.

## How it is put together

Three source files, no framework:

| | |
| --- | --- |
| [`src/breaker.ts`](src/breaker.ts) | the state machine, call timeout and probe limiting |
| [`src/dependency.ts`](src/dependency.ts) | a mock dependency with latency, error rate and availability |
| [`src/app.ts`](src/app.ts) | drives the calls and draws the page |

esbuild bundles `src/app.ts` into `public/bundle.js`. It strips types without
checking them, so `npm run typecheck` is a separate step, and `npm test` runs the
breaker's tests in Node against the same files the browser loads.

### It runs only while you are watching it

Browsers clamp timers in a hidden tab. Since the simulated latency is a timer, a
20ms dependency starts taking most of a second there, and the breaker's own
timeout stretches with it, so a healthy dependency would record timeouts nobody
asked for.

The demo therefore discards its run when the tab is hidden and starts a clean one
when you return. The controls carry over, since they are what a new run reads
from; the timeline does not, because those calls were never watched.
