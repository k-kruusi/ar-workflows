# Workflow run lifecycle fixes — report

Three genesis cards, all against `src/workflows/**` + `src/http-api.ts`:

- **Task 1** (`5fbb…`) — real cancel + restart-orphan sweep
- **Task 2** (`8e1a…`) — sync runs must not self-echo their notify
- **Task 3** (`3f8a…`) — condense must fail **closed**, not open

Status: **all three done.** `npx tsc --noEmit` clean (root tsconfig); full root suite
green — **1748 tests / 72 files**, including the two new test files. Verified against the
real runner + real child processes + real OS kill/probe (not mocks). The cancel path was
then **adversarially reviewed by a fresh code-reviewer**; it found 2 MEDIUM + 2 LOW/NIT
real defects (all in the new cancel path, not style) — **all fixed** (see *Review &
fixes*). See *Honest gaps* for what a source-only change could not exercise on the live
supervisor.

---

## The shared mechanism (why one small module unlocks all three)

The task-graph engine (`dependencies/task-graph`, **out of scope**) has **no
cancellation surface**: `execute()` dispatches a level of nodes and awaits them, with no
`AbortSignal` reaching a handler and no way to tell a node its run mode. Tasks 1 and 2
both need exactly that missing channel, keyed by `correlationId`:

- **`src/workflows/run-control.ts`** — `RunControlRegistry`: a per-run `AbortController`
  + run `mode` (`sync`|`async`) + `cancelled` flag. In-memory (a restart clears it —
  those runs are dead). Plus `NOOP_RUN_CONTROL`, a null object for no-runner contexts.
- **`RunControlCaps`** (in `nodes/contract.ts`) is the slice a **node** sees as
  `caps.run`: `mode / signal / isCancelled / recordChild / clearChild`. The runner
  assembles it — `mode/signal/isCancelled` delegate to the registry; `recordChild/
  clearChild` persist through the durable run-store (so a restart can reap orphans).
- **`src/workflows/proc-kill.ts`** — `killTreeByPid` / `killChildTree` (win32
  `taskkill /PID <pid> /T /F`; posix negative-pgid `SIGKILL` for detached children) and
  `getProcessCommandLine` (CIM on win32, `ps` on posix) for PID-reuse-safe verification.

`NodeCaps` gained a required `run: RunControlCaps`; `buildCaps` / `registerNodes` take an
optional `runControl` and fall back to the null object, so nodes call `caps.run.*`
unconditionally (no optional-chaining, no "is a runner wired?" branch).

---

## Task 1 — real cancel

### core:exec (`nodes/core.ts`)
- Spawns **`detached` on posix** so the child leads its own process group → a real tree
  kill; win32 stays attached (taskkill /T handles the tree).
- On spawn, `caps.run.recordChild(cid, nodeId, child.pid, command)` → persisted on the
  run record (keyed by the **raw command** as the reuse-check signature).
- Listens on `caps.run.signal(cid)`. On abort → `killChildTree(child)`, then the child's
  own `close` fires and the node resolves **`{ ok:false, cancelled:true, exitCode,
  stdout, stderr }`** — a definite RESULT, never a hang, never a throw (per the card).
  Handles the already-aborted-before-spawn race.
- The **timeout path** now also uses `killChildTree` (was `child.kill("SIGTERM")`, which
  reached only the shell wrapper) — the card's "reuse that kill path", and strictly more
  correct for a GPU job under a shell.
- A single `cleanup()` clears the timer, detaches the abort listener, and
  `caps.run.clearChild(cid, nodeId)` on any terminal transition.

### Runner (`runner.ts`)
- `execGraph` takes a `mode`, calls `runControl.begin(cid, mode)` and `end(cid)` in a
  `finally`. After the engine settles, **a landed cancel wins**: `store.markCancelled`
  instead of `store.finish`.
- **`cancelRun(cid)`**: `runControl.cancel` (abort + flag) → `store.markCancelled`
  (status `"cancelled"`, still-unfinished nodes → `skipped`). Throws `Unknown run` (→404)
  / `not running` (→409).
- **Supervisor-restart orphan sweep** — `sweepOrphanChildren()`, fired from the
  constructor. The store surfaces (via `takeOrphans`) the exec children of runs left
  `"running"` at load. For each: `getProcessCommandLine(pid)`, and kill **only if** the
  live command line still `includes` the recorded command **and** the signature is
  ≥ 12 chars (a shorter signature is too generic to distinguish a recycled pid). Never
  kills on a bare pid; logs `reaped` / `skipped{process_gone|command_too_generic|
  command_mismatch_pid_reuse}`.
- **`deleteRun`** now throws for a `"running"` run (pointer to cancel first) — it used to
  silently orphan the tracked process. The node callbacks in `execGraph` also guard on
  `store.get(cid)` so a run **deleted mid-wind-down** no-ops instead of throwing a false
  `workflow_async_failed` (the cancel→delete race).
- **`resumeRun` refuses a still-draining run** (`runControl.isTracked(cid)`): a cancelled
  run keeps cooperatively executing non-exec downstream nodes, so resuming in that window
  would overlap two engines on one id and let the stale one's `end()`/`finish()` clobber
  the resumed run + drop its cancel signal (Review MEDIUM-1).
- **`store.finish` / `store.fail` treat `"cancelled"` as terminal** — a late settle can't
  resurrect a cancelled run to completed/failed (Review MEDIUM-2 belt-and-suspenders).

### Run-store (`run-store.ts`)
- New `"cancelled"` status; `LiveNodeState.exec?: {pid, command, startedAt}`;
  `recordExecChild` / `clearExecChild`; `markCancelled`; orphan collection on load +
  `takeOrphans()` (drains once).

### HTTP (`http-api.ts`)
- **`POST /workflow/run/:id/cancel`** → 200 `{cancelled, status}` / 404 / 409.
- **`DELETE /workflow/run/:id`** now returns **409** for a running run.

### The notify-on-cancel semantics call (documented, as asked)
`agent:notify` senses `caps.run.isCancelled(cid)` and **no-ops with `{skipped:
"run_cancelled"}`** — I chose *suppress* over *deliver a "cancelled" message*. Reason: the
only in-tree notify blueprint (`exec-notify.json`) hard-codes a `"✅ Workflow finished"`
template; firing it on a killed run would deliver a misleading success, and the operator
who hit cancel already knows. Suppression is the honest outcome; the run record carries
the truth (`status:"cancelled"`).

### Honest limitation of "downstream nodes skipped"
Because the engine has no hard cancel and honoring the card's literal contract means
core:exec **resolves** (not throws), the engine still treats a cancelled exec as
`completed` and *runs* its success-edge child. So "downstream skipped" is delivered at two
real levels — the **record** (`markCancelled` relabels still-unfinished nodes `skipped`)
and the **side-effect** (`agent:notify` suppresses) — not by engine-level edge pruning.
For the real blueprints (exec-notify = run→notify) this is complete: the child tree is
killed, no stale whisper fires, status is `cancelled`, nothing hangs. In a hypothetical
multi-exec DAG a *second* exec downstream would be started by the engine but would itself
see the aborted signal and cancel promptly. A truly engine-level skip would require
changing task-graph (out of scope).

### Research/workflow loops
Loops run on a separate path (`runResearchLoop`, not `execGraph`). They're now
**run-control-tracked** (`startResearchLoop` calls `runControl.begin/end`), so `cancelRun`
flags them and the loop **stops at the next iteration boundary** (`isCancelled` check) with
the status staying `"cancelled"` (`finish()` won't overwrite). Residual, documented: the
**current** in-flight iteration's round runs to completion and any `core:exec` inside that
round is not tree-killed (the round executes under its own engine correlationId).

---

## Review & fixes

A fresh `code-reviewer` agent adversarially reviewed the cancel path. Findings, all fixed:

- **MEDIUM-1** — `resumeRun` on a cancelled-but-still-draining run started a *second*
  engine on the same id; the stale engine's `end()`/`finish()` then clobbered the resumed
  run and dropped its cancel signal (making it uncancellable). **Fix:** refuse resume while
  `runControl.isTracked(cid)`. Test: *resumeRun refuses a cancelled run still winding down*.
- **MEDIUM-2** — cancelling a research loop returned `cancelled` but the loop kept running
  and its final `store.finish` reverted the status to `completed`. **Fix:** track loops in
  run-control + `isCancelled` break in `runResearchLoop`; `store.finish`/`fail` treat
  `cancelled` as terminal. Test: *a cancelled status is terminal — finish()/fail() never
  resurrect it*.
- **LOW** — the orphan sweep's `spawnSync` command-line probes blocked the constructor
  (not "background"). **Fix:** deferred the probe loop via `setImmediate`.
- **NIT** — `hardTruncateTail` could leave a lone surrogate (one `�`) at the truncation
  seam for astral chars. **Fix:** drop a dangling low surrogate. Test: *hardTruncateTail
  never leaves a lone surrogate at the seam*.

The reviewer confirmed clean: the core:exec abort-listener lifecycle, the orphan-sweep
PID-reuse guard, the execGraph cancel/status races, and the split regex.

---

## Task 2 — sync runs must not self-echo

`agent:notify` reads `caps.run.mode(cid)`: on a **sync** run it no-ops with
`{skipped:"sync_run"}` — a synchronous `POST /workflow` already returns the whole trace
inline, so an in-graph notify would deliver the same content a second time (the 5
redundant echoes). A node param **`always:true`** forces delivery anyway. Async runs (the
whole point of notify) are unaffected.

- `runGraph` → `"sync"` (inline `POST /workflow`, chrono); `startRun` / `startNamed` /
  `resumeRun` → `"async"`.
- **`exec-notify.json` is unchanged** — the blueprint stays the same, the node got
  smarter (as the card required).

**Checked existing sync callers before choosing skip-by-default:** `agent:notify` appears
in exactly **one** definition (`exec-notify.json`), which is dispatched **async** in
practice. `chrono` POSTs `/workflow` **sync** and consumes the returned trace itself, so
it *wants* the dedup. No existing sync caller depends on an in-graph notify firing. A
chrono/sync workflow that genuinely wants an in-graph whisper sets `always:true`.

---

## Task 3 — condense fails **closed**

`notify-condense.ts` used to pass the **full original** through on condense failure
(`condensePassThrough:"condense_failed"`) — pollution returned exactly when output was big
or weird. Now:

- **`sanitizeOutput()` ALWAYS runs before condense** (and before any fallback): normalize
  CRLF, collapse `\r` animation frames to their final line, strip ANSI escapes.
- **On condense failure/error** the fallback is deterministic: `hardTruncateTail(sanitized,
  cap)` — the sanitized **tail** (where exec results/errors live) truncated to a byte cap
  (default 4096, `NOTIFY_CONDENSE_FALLBACK_CAP`), prefixed with `[truncated N bytes]`.
  **Full raw pass-through is no longer reachable.**
- Result metadata says which path fired: `passThrough:"condense_failed"|"condense_error"`
  now denotes the fail-closed fallback (not raw), plus `droppedBytes` (0 if it fit). The
  outer `catch` and the exec-notify split path both route through the same fallback.
  Surfaced on the `agent:notify` result (`condenseDroppedBytes`) and in a
  `workflow_notify_condense_fallback` log from `fireNotify`.

A small clean message under the cap (e.g. the existing 3000-byte test) still returns
byte-identical — that isn't the pollution case; the fix bites on big/weird output.

---

## Per-test evidence

`src/__tests__/notify-condense.test.ts` (**18**, +7): `sanitizeOutput` collapses `\r`
frames / keeps CRLF / strips ANSI; `hardTruncateTail` keeps tail+marker over cap, no-op
under, no lone-surrogate seam; a **20 KB** condense failure fails closed (truncated,
`droppedBytes>0`, smaller than input); sanitize runs **before** the fallback (no ANSI/`\r`
leak); big clean message still condenses on success. The pre-existing "silo returns error"
case still green (small clean msg under cap ⇒ unchanged).

`src/__tests__/workflow-lifecycle.test.ts` (**15**, new):
- **proc-kill**: `getProcessCommandLine` returns the live command line and `killTreeByPid`
  kills a real process; a dead pid probes to `""` (fail-closed).
- **agent:notify**: sync no-op; `always:true` overrides sync; async delivers; cancelled
  suppresses; no run-context (no meta) delivers as before.
- **core:exec cancel**: real child, abort mid-flight ⇒ `{ok:false, cancelled:true}`,
  child recorded then cleared, no hang.
- **runner**: `cancelRun` ⇒ status `"cancelled"` and settles; `deleteRun` refuses a
  running run then deletes once cancelled; `resumeRun` refuses a still-draining cancelled
  run; a `"cancelled"` status is terminal (`finish`/`fail` never resurrect it); `cancelRun`
  throws for unknown (404) / finished (409).
- **orphans**: the store surfaces a running run's exec child on reload, drained once; the
  sweep does **NOT** kill a live process whose recorded command doesn't match the live
  command line (**PID-reuse safety** — the property the card was burned by).

`src/__tests__/workflow-nodes.test.ts` (**51**, +`run` on mockCaps) and
`src/__tests__/workflow-run-store.test.ts` (**2**) stay green.

### Un-broke a pre-existing failure (not caused by this work)
`workflow-run-store.test.ts` was **red on arrival**: commit `022a54b4` removed
`definitions/demo-progress.json` but left the test depending on it (`Unknown workflow:
"demo-progress"`). It's the only GPU-free file-backed definition suited to the
durable/resume-across-restart test that covers the exact `execGraph`/store path I touch,
so I **restored `demo-progress.json`** verbatim from `022a54b4^` (in scope:
`src/workflows/definitions/`). The `demo:delay`/`demo:gate` node handlers were never
removed. If the removing agent wants it gone, the test must go with it.

---

## Honest gaps

- **Live HTTP not exercised.** Guardrail: source-only, don't restart the supervisor (it
  runs old code until Kevin go-lives). So `POST /workflow/run/:id/cancel` and the 409
  DELETE were not driven through the live server. The **substance** (`cancelRun`,
  kill, sweep, store) is covered end-to-end against the real runner/child/OS; the HTTP
  glue is thin (regex → `cancelRun` → 200/404/409) and verified by inspection + tsc.
- **Research/workflow loops cancel at the iteration boundary, not instantly.** The loop
  stops before the next iteration and the status stays `"cancelled"`, but the CURRENT
  in-flight round finishes and a `core:exec` inside that round is not tree-killed (it runs
  under the round's own engine correlationId). Cancel is instant + full for inline / named
  / exec-notify / resume runs.
- **posix tree-kill is best-effort.** Correct on win32 (taskkill /T, the primary env).
  On posix it relies on the child being spawned `detached`; if it isn't a group leader
  the negative-pgid signal falls back to the bare pid (direct child only). The posix
  branch is guarded, never throws.
- **Cancelled exec node reads `completed`.** Per the engine limitation above, a cancelled
  core:exec's final recorded status is `completed` with a `{cancelled:true}` result
  payload (the run's overall status is `cancelled`). A dashboard would show it green; the
  result payload carries the truth.
- **Dashboard stop button (stretch) not done.** Out of the required scope; the backend
  route it would call (`POST /workflow/run/:id/cancel`) is in place.
