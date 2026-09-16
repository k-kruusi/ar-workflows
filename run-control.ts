/**
 * Run-level control the task-graph engine cannot express.
 *
 * The engine (`dependencies/task-graph`, out of this package's scope) has no
 * cancellation surface: it dispatches a level of nodes and awaits them, with no way
 * to abort in-flight work or to tell a node "the run was cancelled / this is a sync
 * run". This registry supplies that missing channel, keyed by `correlationId`:
 *   - an `AbortController` per run — `core:exec` listens on its signal and kills its
 *     child tree when the run is cancelled (resolving as a result, not a hang);
 *   - the run `mode` (sync|async) — `agent:notify` no-ops on a SYNC run so a
 *     `POST /workflow` that already returns the full trace inline doesn't ALSO whisper
 *     the same content back (the self-echo bug);
 *   - a `cancelled` flag — `agent:notify` suppresses a now-stale "finished" whisper.
 *
 * In-memory only: a restart clears it, which is correct — every run it tracked is by
 * definition dead after a restart (the orphan sweep marks those failed and reaps
 * their children from the persisted run-store record).
 */
import type { RunMode, RunControlCaps, ReceiptCaps } from "./nodes/contract.js";

interface RunControl {
  mode: RunMode;
  controller: AbortController;
  cancelled: boolean;
  paused: boolean;
  depth: number;
  /** The invoking run's correlationId when this run is a nested workflow:run
   *  sub-run (undefined for top-level runs). The channel cancel/pause cascade
   *  down: an operator tearing down a parent takes every tracked descendant
   *  with it (#653 — cancelling used to leave nested sub-DAGs running). */
  parent?: string;
}

/**
 * Owns the live AbortController + mode + cancelled flag for each in-flight run. The
 * runner calls begin/cancel/end; nodes read mode/signal/isCancelled through the
 * RunControlCaps facade the runner assembles (which also wires recordChild/clearChild
 * to the durable run-store).
 */
export class RunControlRegistry {
  private runs = new Map<string, RunControl>();

  /** Start tracking a run. Idempotent per correlationId (a resume reuses the id, so
   *  begin() mints a fresh controller — a prior, already-ended run's signal must not
   *  linger). `depth` is the nesting level for a `workflow:run`-spawned sub-run
   *  (0 for a top-level run); see `depth()`. `parent` threads the invoking run's
   *  cid so cancel/pause CASCADE into every tracked descendant (#653); a sub-run
   *  that begins after its parent already flipped inherits those flags, so it
   *  cannot race past an operator's intent. */
  begin(correlationId: string, mode: RunMode, depth: number = 0, parent?: string): void {
    let inherited = { cancelled: false, paused: false };
    if (parent !== undefined) {
      // A workflow:run node always executes inside its parent's live engine (the
      // awaiting node holds it open), so the parent must be tracked — if not,
      // the threading broke somewhere upstream.
      const p = this.runs.get(parent);
      if (!p) {
        throw new Error(
          `run-control: nested run "${correlationId}" names parent "${parent}", which is not tracked — ` +
            `a workflow:run sub-run always begins inside its parent's live engine`,
        );
      }
      inherited = { cancelled: p.cancelled, paused: p.paused };
    }
    this.runs.set(correlationId, { mode, controller: new AbortController(), cancelled: inherited.cancelled, paused: inherited.paused, depth, parent });
  }

  /** Cancel a tracked run: flip the flag and fire the abort signal (core:exec's
   *  listeners kill their child trees), then cascade into every tracked nested
   *  sub-run below it (#653) — each descendant flips its own flag and aborts its
   *  own controller, so its halted gate stops dispatch and its cooperative nodes
   *  tear down exactly as if it had been cancelled directly. Returns false if
   *  the run isn't tracked (already ended / never began) — the caller maps that
   *  to "nothing to cancel". */
  cancel(correlationId: string): boolean {
    const rc = this.runs.get(correlationId);
    if (!rc) return false;
    rc.cancelled = true;
    if (!rc.controller.signal.aborted) rc.controller.abort();
    for (const cid of this.descendants(correlationId)) {
      const d = this.runs.get(cid)!;
      d.cancelled = true;
      if (!d.controller.signal.aborted) d.controller.abort();
    }
    return true;
  }

  /** Pause a tracked run: flip the flag WITHOUT firing the abort signal — in-flight
   *  nodes drain and record normally; the engine's dispatch gate stops anything new
   *  from starting — then cascade the pause into every tracked nested sub-run below
   *  it (#653). Returns false if the run isn't tracked (already ended / never
   *  began) — the caller maps that to "nothing to pause". */
  pause(correlationId: string): boolean {
    const rc = this.runs.get(correlationId);
    if (!rc) return false;
    rc.paused = true;
    for (const cid of this.descendants(correlationId)) {
      this.runs.get(cid)!.paused = true;
    }
    return true;
  }

  /** Stop tracking a settled run (its controller/flag are no longer needed). */
  end(correlationId: string): void {
    this.runs.delete(correlationId);
  }

  /** Whether an execGraph/loop is still live for this run (begin without a matching
   *  end). resumeRun uses this to refuse starting a SECOND engine on a run that hasn't
   *  fully drained — a cancelled run keeps cooperatively executing non-exec downstream
   *  nodes, so its `end()` lands later; resuming in that window would overlap engines
   *  and let a stale end()/finish() clobber the resumed run. */
  isTracked(correlationId: string): boolean {
    return this.runs.has(correlationId);
  }

  /** Every run with a live engine right now — the plural of `isTracked`. This is the
   *  ONLY honest source for "is anything executing": the durable run-store is not,
   *  because a `paused` record survives a restart by design and stays parked
   *  indefinitely. Quiescing a node reload on store status would let two
   *  fortnight-old paused runs block hot-reload forever (observed 2026-08-05: two
   *  paused exec-notify runs from July 21 refused the very first reload). This map
   *  is in-memory and cleared by a restart, which is correct — those runs are dead. */
  tracked(): string[] {
    return [...this.runs.keys()];
  }

  /** Tracked cids whose `parent` chain reaches `correlationId` — the cascade
   *  targets for cancel/pause. Parent links are only written by invokeNested at
   *  depth+1, and a live descendant keeps every ancestor tracked (its awaiting
   *  workflow:run node holds the ancestor's engine open), so the chain walk is
   *  finite and terminates on the first untracked link. */
  private descendants(correlationId: string): string[] {
    const found: string[] = [];
    for (const [cid, entry] of this.runs) {
      let anc = entry.parent;
      while (anc !== undefined && anc !== correlationId) anc = this.runs.get(anc)?.parent;
      if (anc === correlationId) found.push(cid);
    }
    return found;
  }

  mode(correlationId: string): RunMode | undefined {
    return this.runs.get(correlationId)?.mode;
  }

  signal(correlationId: string): AbortSignal | undefined {
    return this.runs.get(correlationId)?.controller.signal;
  }

  isCancelled(correlationId: string): boolean {
    return this.runs.get(correlationId)?.cancelled ?? false;
  }

  isPaused(correlationId: string): boolean {
    return this.runs.get(correlationId)?.paused ?? false;
  }

  /** This run's nesting depth (0 for a top-level run), or undefined if untracked —
   *  an untracked caller must FAIL the depth computation, not masquerade as top-level
   *  (that would silently restart nesting-depth accounting mid-chain). Read by
   *  `WorkflowRunner.invokeNested` to compute a `workflow:run` node's child depth —
   *  never exposed on `RunControlCaps` (the node-facing facade), so a graph node
   *  cannot read or spoof its own depth. */
  depth(correlationId: string): number | undefined {
    return this.runs.get(correlationId)?.depth;
  }
}

/**
 * Null-object RunControlCaps for contexts with no runner wired (unit tests, a node
 * invoked directly). Every method is an inert no-op so a node can call `caps.run.*`
 * unconditionally — no optional chaining, no hidden "is a runner attached?" branch.
 */
export const NOOP_RUN_CONTROL: RunControlCaps = {
  mode: () => undefined,
  signal: () => undefined,
  isCancelled: () => false,
  recordChild: () => {},
  clearChild: () => {},
  recordedChild: () => undefined,
  execStateDir: () => undefined,
};

/**
 * Null-object ReceiptCaps for contexts with no runner wired (unit tests, direct
 * node invocations). Capture calls are no-ops — no receipt is written.
 */
export const NOOP_RECEIPT_CAPS: ReceiptCaps = {
  capture: () => {},
  /** undefined, NOT {} — an empty record would let a fan-in report an independence
   *  of zero it never actually measured. Absence must stay legible as absence. */
  runNodes: () => undefined,
};
