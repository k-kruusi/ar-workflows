# workflow nodes — the composable primitives + their shared contract

A DAG node is **not** a cartridge. A cartridge is a *living service* (lifecycle,
port, health check, durable reducer, an address on the bus). A node is a
*function with an I/O contract* — it exists only while a run executes, takes
interpolated inputs, returns a result, and fails by throwing. This folder is the
library of those node functions plus the one contract they all speak, so a
node's output drops into the next node's input without bespoke glue.

> Node = **contract + handler**. Cartridge = **lifecycle + address**. Bridge the
> two (a cartridge exposed as a node) only for genuine services, and only through
> a thin adapter that maps the cartridge's HTTP I/O onto this contract.

## The shared communication contract (`contract.ts`)

Every node is authored with `defineNode({ type, run })`. `run` receives one
`NodeContext` and returns a plain object. Four rules, each fixing a real
scar from the hand-rolled handlers:

1. **Inputs — one typed accessor, honest errors.** Instead of scattered
   `String(params.x ?? "")` / `Number(...)` casts, a node reads
   `inputs.str("agent", { required: true })`, `inputs.num("ms", { default: 1000, min: 0, max: 600_000 })`,
   `inputs.bool("open")`, `inputs.obj("config")`. A required-but-missing or
   non-numeric input throws a clear `"<type>: input \"x\" …"` error (Honest
   Response) — never a silent `""`/`NaN` that surfaces three nodes later.

2. **Output — always a plain object.** `toHandler` rejects a scalar/array/null
   result, because downstream nodes interpolate `{{nodes.<id>.result.<field>}}`
   and that only resolves against an object. Returning a list? Wrap it:
   `{ items: [...] }`. This is the n8n-"items" insight made a hard rule: a
   predictable envelope is what makes chaining glue-free.

3. **Errors — throw a clear `Error`.** The engine records the throw as the
   node's `failed` result with your message; failure-edges (`on:"failure"`)
   branch on it. No `{ ok:false }` sentinels to remember to check.

4. **Capabilities — injected once, never re-imported.** Supervisor powers
   (whisper an agent, sense its state, read/append a ledger, structured log)
   arrive as `ctx.caps`. A node module never imports `ContainerManager` or the
   send handler directly; `buildCaps(deps, dataDir)` wires them at registration.
   That keeps node files pure and testable with a mock `caps`.

## Capabilities (`caps.ts` → `NodeCaps`)

| cap | what it does | backed by |
|---|---|---|
| `whisper(agent, msg)` | send a message to a fleet agent; **awaits** its reply (queue ACK if busy) | `onSend` |
| `notify(agent, msg)` | fire-and-forget delivery into an agent's conversation (use for results) | `onSend` (no await) |
| `agentState(agent)` | sense `{status, isProcessing, messagesHandled, uptimeMs}` | `ContainerManager` |
| `ledgerAppend/Read(name, …)` | disk-as-memory rows under `data/node-ledgers/` | fs |
| `log(level, event, data)` | structured log → also broadcast on the bus | supervisor logger |
| `streamOutput(cid, nodeId, chunk)` | live stdout tail for long-running nodes (dashboard) | `WorkflowOutputStore` |
| `registerOutputFile(cid, nodeId, path)` | declare a file the node redirects to (dashboard tails it) | `WorkflowOutputStore` |
| `supervisor.*` | container lifecycle: start/stop/send/cancel/reset/clear/flush | `ContainerManager` + handlers |
| `run.*` | cancel signal, sync/async mode, recordChild/clearChild for orphan kill | `RunControlRegistry` + run-store |
| `workflow.*` | nested `workflow:run` / inline graph invoke + describe | `WorkflowRunner` |
| `conventions.resolve(cwd, task)` | CLAUDE.md + skill preamble for agent:run | conventions index |
| `receipt.capture(cid, nodeId, …)` | epistemic receipt for infer nodes (auto-mint + agent:run enrich) | runner `pendingReceipts` |

`isProcessing` and `messagesHandled` are the load-bearing sense signals: never
act on a **busy** agent (that's the queue-flood that flattened the debate run),
and compare `messagesHandled` tick-to-tick to tell a **stuck** agent from a
merely **slow** one. Prefer `notify` over `whisper` for fire-and-forget
result delivery (`agent:notify` uses it).

## Adding a node later

Write a `defineNode({ type, run })` in the relevant file (or a new file), add it to
that file's exported array, and `index.ts` registers it on the next
construction/restart. Nothing else to wire — that's the extensibility the contract
buys.

## Primitives shipped

**Core (no caps):**
- `core:noop` → `{ ok:true }` — placeholder / join anchor.
- `core:delay` → sleeps `ms` (0…600 000), returns `{ sleptMs }`. The repeat-delay
  primitive for poll/watchdog loops.
- `core:gate` → passes iff `open` is truthy (or `sentinel` file exists), else
  throws. Drives `on:"failure"` branching.
- `core:exec` → runs a shell command (`command`), returns `{ stdout, stderr, code }`.
  Inherits supervisor env. Used by exec-notify workflows for long-running jobs.

**Agent (caps):**
- `agent:run` → spawns an ephemeral CLI agent (Claude or Grok) with a prompt, returns
  `{ sessionId, reply }`. Supports multi-runtime dispatch via `runtime` param
  (`"claude"` or `"grok"`), model selection, session resume, and prompt delivery via
  stdin (no command-line length limits). Convention injection is on by default
  (`conventions: "auto"` injects the cwd-scoped CLAUDE.md + skills); use
  `skills: "skills/foo.md,skills/bar.md"` to inject additional repo-root-relative
  skill files on top, deduped against the auto bundle. The workhorse of implementation workflows.
  **Governed by the worker envelope — see below.**
- `agent:state` → senses an agent (the watchdog's *read* step).
- `agent:whisper` → sends to an agent and returns `{ agent, reply }`; **throws if
  the agent is busy** (queued, not answered) so a poke never floods a live queue.
- `agent:notify` → fire-and-forget delivery back to an agent's conversation. Sync-aware
  (no-ops on sync runs), cancel-aware (no-ops on cancelled runs), condenses long output.
  Closes the async loop — a workflow delivers its result back to the originating chat.
  **Templates:** `{{run.correlationId}}`, `{{run.workflowId}}`, `{{run.workflowName}}`,
  `{{nodes.*}}`, `{{params.*}}`. **`{{run.status}}` is not in scope** (mid-graph the
  store is still `running`). Terminal status → POST body `notify` / `fireNotify`.
  **Do not pair** body `notify` + this node unless you want two chat turns
  (`workflow_notify_dual` warn). Full conductor notes: `src/workflows/CLAUDE.md`.
- `agent:ask` → like whisper but with param `prompt` (used by the research loop).
- `judge:score` → asks an agent to score, parses a leading 0..1 metric. Advisory.

### The worker envelope — `capabilities` + `observe` on `agent:run`

**Deny by default.** An `agent:run` node that declares no `capabilities` spawns a
worker with **no file, shell, or web tools at all** — a pure-text reasoner. This is
the rung-2 base-node gate (`papers/agentruntime/plans/base-node.md`). Before it,
`--disallowedTools` was passed *only* on the `tools: "ar-tools"` path, so every
default worker silently kept `Bash` and could reach the supervisor's control plane.

`capabilities` is a **comma-separated string** (the inputs contract has no `.arr`),
split exactly like `skills`:

| Verb | Built-ins released (only when `observe:false`) | ar-tools keys registered (whenever ar-tools is attached) |
|---|---|---|
| `fs.read` | `Read`, `Glob`, `Grep` | `read`, `glob`, `grep`, `read-symbol`, `file-outline` |
| `fs.write` | `Write`, `Edit`, `NotebookEdit` | `write`, `edit`, `edit-range`, `edit-symbol` |
| `shell` | `Bash`, `PowerShell`, `KillShell`, `BashOutput` | `bash` (→ `run_command`) |
| `web` | `WebFetch`, `WebSearch` | `web-fetch` |

```json
{ "id": "review", "type": "agent:run",
  "params": { "cwd": "…", "prompt": "…", "capabilities": "fs.read" } }
```

Two coordinated layers derive from that one set:

1. **argv** — `disallowedTools = FULL_BLOCK − granted`, passed on **every** spawn
   (claude `--disallowedTools`, grok `--disallowed-tools`). The worker literally
   lacks the verb.
2. **MCP `TOOLS`** — whenever an ar-tools child is attached (i.e. `tools` is set),
   `TOOLS` is written from the granted keys, **on every path, `observe` or not**
   (`packages/tools/src/server.ts`). Omitting `bash` means `run_command` never
   exists. Without this layer, blocking built-in `Bash` while attaching ar-tools'
   unrestricted shell would be theatre — and gating this layer on `observe` is the
   same hole wearing a different hat, since an unset `TOOLS` registers *all 16
   tools*, shell included.

**`observe`** (default `false`) is the *how*, not the *what*, and it governs
**only the built-ins** — never what MCP registers:

| | built-ins | ar-tools child |
|---|---|---|
| `observe:false`, no `tools` | granted verbs released | none |
| `observe:false` + `tools` | granted verbs released | attached, `TOOLS` = granted keys |
| `observe:true` + `tools` | **all blocked** | attached, `TOOLS` = granted keys |

`observe:true` forces every effect through ar-tools so the evolution bridge sees it;
it **requires `tools: "ar-tools"`** (a conflict, and throws otherwise) and is
mandatory for any future bond-bearing node, because built-in tool calls inside
`claude -p` are *not* observable and a capability-escape proof would have no
substrate. `observe:false` keeps the built-ins for speed and degrades gracefully if
the evolution bridge is stale — but it never widens the capability set.

**Never grantable:** the interactive tools (`AskUserQuestion`, `ScheduleWakeup`, …)
and delegation (`Task`/`Agent`, grok's `--no-subagents`) — a subagent's envelope is
not computed by this gate, so delegation is capability escape.

**Audit.** Every spawn logs `spawn_gate_admit` (granted + denied + bond) supervisor-side,
where the worker has no handle to it. An undeclared node additionally logs
`spawn_gate_deny_default` with the fix — external/user definitions get a maximally
restricted worker plus an actionable signal, never silent breakage. A `shell` grant
logs `spawn_gate_shell_granted` recording the honest residual.

**Migration cost (paid in-tree):** all 103 `agent:run` nodes across the 21 shipped
definitions declare capabilities. 69 are `fs.read` only; `shell` is granted to 26,
each because that node's prompt runs a concrete command (`git log`, `npx vitest`,
`node scripts/cite.mjs`). Adding a node without `capabilities` fails `safe-commit`.

**Honest residuals** — what rung 2 does *not* do:

- A `shell`-granted worker still reaches localhost. Layers 1+2 contain only
  non-shell workers; the loopback-deny env is cosmetic until OS-level isolation.
- The bond is a **no-op**. `NullEscrow` logs `escrow_lock`/`release`/`refund` around
  every spawn so the lifecycle and its call-sites are real, but no value moves, and
  `EscrowClaim` is a **shape only — nothing persists it**. The durable record at this
  rung is the `spawn_gate_admit` log line, not a claim file.
- `verifyMechanical` is a decision table with **no collectors**. The evidence it
  grades (cite.mjs recompute, git-diff scope, the bridge's observed-call log, the
  rung-1 meter) is populated by later rungs; today every call returns
  `inconclusive` unless a caller supplies evidence by hand.

`WORKER_ENVELOPE_V1=0` restores the legacy behaviour, loudly logged.

**Workflow composition:**
- `workflow:run` → runs another workflow definition inline as a sub-step (DAG of DAGs).
  Takes `workflowId` and `params`, executes the sub-workflow synchronously, returns
  its final result. Enables composable topologies — e.g. task-master chains
  adversarial-design → review-gauntlet in a 2-node meta-DAG.

**Coverage ledger (caps — ledgerAppend/Read):**
- `coverage:init` → seeds a run-keyed ledger with one `missing` row per cell id
  (array of strings or object keys). Used by `research-swarm-coverage`.
- `coverage:mark` → records a cell's status (`covered` / `missing` / …) into the ledger.
- `coverage:summary` → reduces the ledger to `{ total, byStatus, cells, gaps }`
  (last-writer-wins per cell).

**Review:**
- `review:anchor-check` → mechanical floor check for review-gauntlet style anchors.

**Supervisor lifecycle (caps):**
- `supervisor:send` (non-throwing, returns `{ sent }`), `supervisor:start`,
  `supervisor:stop`, `supervisor:cancel`, `supervisor:resetConversation`,
  `supervisor:clearSessionFile`, `supervisor:flushStats`, and `noop`.

**Demo (caps-free):** `demo:delay`, `demo:gate` — test primitives for
live-run/resume DAGs.

## What composes from these next

The **poke / watchdog** is a composition, not a new monolith:
`agent:state` (sense) → decide *stuck vs slow vs done* (compare `messagesHandled`
+ a done-marker, against a ledger) → `agent:whisper "continue"` only if stuck →
escalate after N dry pokes. The only genuinely new piece is the *decide* step's
stateful logic; everything else is these primitives.

## One convention (migration done)

The original in-line `../handlers.ts` set has been **folded onto this contract**
under their existing type strings (`agent:ask`, `judge:score`, `supervisor:*`,
`demo:*`, `noop`) and `handlers.ts` retired. `registerNodes` is the single
registration path; the research-loop, demo DAG, and definitions are unchanged
because the type strings and result shapes were preserved.
