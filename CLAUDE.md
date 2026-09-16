# src/workflows/ — workflow engine (supervisor-side)

This is the **engine** half: DAG runner, run store, node library, definitions under
`definitions/`, HTTP surface via `src/http-api.ts` (`POST /workflow`, `/workflow/runs`, …).

The **panel** half lives in `packages/workflows/` (Runs UI on port 3102). Edit engine
code here; edit the dashboard Runs/Definitions UI there.

Related:
- Node authoring contract → `nodes/README.md`
- Task-graph interpolate scope → `dependencies/task-graph/src/types.ts` (`RunScope`)
- Panel cartridge → `packages/workflows/CLAUDE.md`

## Two kinds of agent. Only one of them is yours to spend.

**Chat agents** (`claude`, `kimi-1`, `qwen-1`, `deepseek-dorian`, `glm-geoff`, …) are
**Kevin's persistent conversations**. A workflow must not speak into one.

**Ephemeral seats** are what workflow work runs on: `agent:run` spawns a fresh
worker, it does the job, it exits. No conversation, no history, nothing to pollute.

**The rule:** a workflow reaches a chat agent through **exactly one** channel — the
`agent:notify` (or body `notify`) that fires when the run finishes, aimed at the agent
that launched it. Workers, judges, reviewers, spot-checks, retries: all `agent:run`.
Never `agent:whisper`, `agent:ask`, or `supervisor_whisper` at a chat agent without
Kevin explicitly asking for it in that conversation.

**Why, and this is the part that makes the rule stick:** an agent has no sense of
elapsed time. A conversation resumed three days later has no idea a workflow it never
launched is about to talk into it, and cannot tell that message apart from the thread
it is actually working. The cost is not noise — it is a live session acting on a
stranger's context. A bare "don't whisper chat agents" gets rationalised around by the
next agent with a good reason; that paragraph does not.

### `workerProfile` is a FILE READ, not a message

Say this plainly because the opposite is the natural reading, and the misreading has
cost real review time: `workerProfile: "x"` does **not** message container `x`. It
reads `cartridges/x/workspace.json`, keeps the `WORKER_PROFILE_ENV_KEYS` allowlist,
scopes the token to that one spawn (never logged, never in argv, never in the prompt),
and rewrites the lane to `/c/x@worker` so the calls are not filed under `x`'s traffic.
The named container does not even have to be running.

**But never point it at a chat agent anyway.** A definition naming someone's
conversation *reads* like it whispers one, and that misreadability is itself the
defect — it makes correct code look wrong forever, and couples a workflow leg to a
conversation's config.

**Use a route profile instead.** `cartridges/seat-*/` are workspace.json files and
nothing else: no process, no port, deliberately absent from `agentruntime.json` and
therefore unstartable by construction. Shipped: `seat-deepseek`, `seat-kimi`,
`seat-qwen`, `seat-glm`. `check-stale` lists them as present-but-unregistered — that
is **correct and intentional**, not drift.

To add one: copy the allowlisted env keys out of a cartridge that already routes where
you want, re-point `ANTHROPIC_BASE_URL` at `http://localhost:3075/c/<your-seat>`, and
keep `apiUpstream`. Two independent consumers then resolve it off disk with no wiring.

**Name it without a dot.** `workerProfile`'s validator is `/^[a-zA-Z0-9_-]+$/` while
traffic-mirror's allows dots — so `seat-qwen-3.8` resolves for the mirror and is
silently unborrowable by `agent:run`. A run was already lost to this on
`grok-composer-2.5-fast`.

**Pick the model on the node, not the profile.** An explicit `model` on `agent:run`
overrides the profile's pin (`agent-run.ts`: `if (!model) effectiveModel = resolved.model`),
so one route profile serves every model behind that upstream. And **always set
`model`** — an `agent:run` without one inherits the CLI's frontier default and silently
spends multiples of what the round was budgeted for.

**Still borrowing a chat agent:** `adversarial-design-six-family.json` (8 sites) and
`review-panel.json` (1 site). Mechanically safe, same misreadability defect; swap them
to the `seat-*` profiles above when you are next in those files.

## Notify: pick ONE path (dual-notify footgun)

Two independent channels can both whisper an agent when a run finishes:

| Channel | When it fires | What it knows |
|---------|---------------|---------------|
| **POST body `notify`** (`fireNotify`) | After the run **settles** (completed / failed / cancelled / paused) | Real terminal **status**, correlationId, workflowId |
| **In-graph `agent:notify` node** | When that **node** runs (still mid-graph — store status is still `running`) | Full template scope: `{{nodes.*}}`, `{{params.*}}`, `{{run.correlationId\|workflowId\|workflowName}}` |

**If you set both, both fire** → two chat turns for one run (observed 2026-08-09 on
goal-runs-tab validation). The runner logs `workflow_notify_dual` (warn) and does
**not** suppress either path (intentional dual is rare but allowed).

**Conductor rule of thumb:**

- Need the **report body** (`{{nodes.validate.result.reply}}`) → use **`agent:notify` only**.
- Need a short **“✅ completed / ⚠️ failed”** ping with true terminal status → use **body `notify` only**.
- Need both shapes → accept two messages, or fold status into the agent:notify text
  yourself (do **not** use `{{run.status}}` — see below).

## Template scope: `{{run.*}}`

Available mid-graph (always true while a node interpolates):

- `{{run.correlationId}}`
- `{{run.workflowId}}` — graph.id
- `{{run.workflowName}}` — graph.name (Runs-tab label)

**Not available: `{{run.status}}`.** At interpolate time the run is still in-flight;
the store only becomes `completed`/`failed` in `finish()` **after** the last node.
Unresolved paths stay **literal** so a typo is visible (`status={{run.status}}`)
rather than a confident wrong value. Terminal status → body `fireNotify`.

Also: `{{nodes.<id>.result.<field>}}`, `{{params.*}}`. Unresolved → left as `{{…}}`.

## Inline graphs

`POST /workflow` with `{ graph, async: true, notify? }` requires envelope
`id` + `name` + `description` (`validateEnvelope`). Named definitions always have them.

## Panel routes (engine callers / validators)

When probing the workflows **panel** cartridge (port 3102):

- `GET /` — HTML shell with **panel.js inlined**
- `GET /_panel` — raw JS bundle (embed path)
- There is **no** `/panel.js` route — a 404 there is by design, not a broken panel

## Restart note

Engine changes under `src/workflows/` and `src/http-api.ts` load via the supervisor
process (tsx). They go live on **supervisor restart**, not on cartridge rebuild.
