# Circuit breaker demo

An interactive demo of infrastructure that degrades predictably under stress.

Your browser calls an API continuously. The API reaches a mock dependency through
a circuit breaker. You break the dependency; the page shows what happens to your
requests and to the breaker, as it happens.

```
Browser  ──────▶  API  ──╫──▶  Dependency
                    circuit breaker
```

## Run it

Needs Node 24. There is no build step — Node strips the TypeScript types itself.

```sh
npm install
npm start          # http://localhost:3000
npm run dev        # same, with --watch
npm test           # vitest
```

## What you can do

Three knobs on the dependency, matching the ways real ones misbehave:

| Control | What it shows |
| --- | --- |
| **Latency** | slow is a kind of broken — past the call timeout, the breaker treats it as failure |
| **Error rate** | partial degradation, which is more common than a clean outage |
| **Take it down** | every call fails immediately |

Watch for the moment the breaker opens: responses stop reaching the dependency and
start failing instantly instead. The `Calls reaching dep.` counter freezes — that
is the breaker earning its keep.

## Reading the page

- **Graph** — the three nodes flash per request. When the breaker is open, the
  right-hand edge goes dashed and the Dependency node stops lighting up.
- **Timeline** — one bar per response, newest on the right, height is latency on a
  log scale. Underneath, a band showing which breaker state handled that response.
- **Responses** — outcome counts with the status code each maps to, and the latest
  response in full.
- **Breaker** — current state, why it last changed, and the countdown to its next
  retry.

Each outcome gets the status code it deserves:

| Code | Outcome | Meaning |
| --- | --- | --- |
| `200` | success | the dependency answered |
| `502` | error | it answered badly |
| `504` | timeout | it was too slow |
| `503` | rejected | we never called it |

`503` is the interesting one: it is the only code here that says nothing about the
dependency's health, because while the breaker is open we have no current
information about it. While the breaker is open those responses also carry
`Retry-After`, derived from its own countdown; the few rejected because a
half-open window already has its probes carry no countdown to give.

## The breaker

Hand-rolled in [`src/breaker.ts`](src/breaker.ts), about 185 lines, with the state
machine as the only thing in it. Defaults:

| Setting | Default | |
| --- | --- | --- |
| `failureThreshold` | 5 | consecutive failures that trip it |
| `openMs` | 6000 | how long it stays open before probing |
| `successesToClose` | 3 | probes that must succeed to close it |
| `halfOpenMaxProbes` | 2 | probes allowed in flight at once |
| `timeoutMs` | 500 | a call slower than this counts as a failure |

Its invariants are covered in [`src/breaker.test.ts`](src/breaker.test.ts).

## One breaker per viewer — a demo concession

**This is not how you would build it.** A real circuit breaker is per API instance
and shared by everyone hitting that instance; holding shared state is the entire
point. A fleet of ten instances has ten breakers, and they trip at different times.

This demo gives **each viewer their own breaker and dependency** anyway, because
sharing one makes it unreadable:

- Two people poking at one breaker trip each other's, and neither can tell why.
  We did this to ourselves twice while building it, once mistaking a colleague's
  slider drag for a bug.
- A shared breaker allows only one probe per cooldown, so whoever asks first takes
  it and everyone else sees nothing. The `HALF-OPEN` state becomes invisible to
  all but one viewer.

The page generates a session id on load and sends it with every request; the server
keeps a breaker and dependency per id ([`src/sessions.ts`](src/sessions.ts)) and
drops a session five minutes after its last request. Reloading starts a clean demo,
and a second tab is an independent one — useful for running two configurations side
by side.

### Run it on one instance

All of that state lives in memory, so this must run as a **single, always-on
process**. Serverless resets it between invocations, and two replicas would
round-robin a viewer between two different breakers — the exact confusion the
session store exists to prevent. No scale-to-zero, no autoscaling.

Making it survive that (shared store, sticky sessions) is deliberately out of
scope: it would add infrastructure that teaches nothing about circuit breakers,
which is the only thing this is for.

## API

| | |
| --- | --- |
| `GET /api/call` | the call the browser hammers, through the breaker |
| `GET /api/state` | breaker snapshot + dependency health |
| `POST /api/dependency` | `{ latencyMs, errorRate, down }` |
| `POST /api/reset` | force the breaker closed |

All of them are scoped by the `x-demo-session` header.
