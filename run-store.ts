import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowRunStatus } from "../../contracts/workflow-run-status.js";
import type { TaskGraph, NodeResult } from "@agentruntime/task-graph";
import { log } from "../logger.js";
import {
  classifyKind,
  type EpistemicKindResolved,
  type InferenceReceipt,
  type SubRunRollup,
} from "./epistemics.js";

// Re-exported so in-src consumers type run statuses off the store, the emitter.
export type { WorkflowRunStatus };

/**
 * Live status of a single node within a run. A superset of task-graph's terminal
 * NodeResult.status — it adds the in-flight states (`pending`, `running`) that the
 * engine's trace never carries because a trace is post-hoc.
 */
export type LiveNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timed_out";

export interface LiveNodeState {
  status: LiveNodeStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  attempt?: number;
  error?: string;
  /** Stored so a resume can carry a completed node forward without re-running it. */
  result?: unknown;
  /** A live child process this node spawned (core:exec). Persisted so a supervisor
   *  restart can find, VERIFY (command-line match — PID-reuse-safe), and reap an
   *  orphaned process. Cleared when the child exits. */
  exec?: { pid: number; command: string; startedAt: number };
  /** Epistemic classification — seeded at init for EVERY node from NODE_KINDS catalog.
   *  Present for success, failure, and skip alike (correct even if the node never ran). */
  kind?: EpistemicKindResolved;
  /** Stored at init so receiptsFor/summarizeEpistemics never re-join the graph definition. */
  nodeType?: string;
  /** Audit receipt for infer nodes — drained from the runner's capture-map into this
   *  single nodeComplete write. Sibling of result, NEVER inside it. */
  receipt?: InferenceReceipt;
  /** Denormalized infer-summary for workflow:run nodes — survives child run prune. */
  subRun?: SubRunRollup;
}

/** A spawned child left behind by a run that was "running" when the supervisor
 *  stopped — surfaced by the store on load for the runner's PID-reuse-safe sweep. */
export interface OrphanChild {
  correlationId: string;
  nodeId: string;
  pid: number;
  command: string;
}

export interface WorkflowRunProgress {
  correlationId: string;
  workflowId: string;
  workflowName: string;
  params: Record<string, unknown>;
  status: WorkflowRunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  /** nodeId -> live state. Seeded to all-`pending` at init. */
  nodes: Record<string, LiveNodeState>;
  /** The same correlationId is reused across resumes; this counts them. */
  resumeCount: number;
  /** WHY the run settled, in goal-contract terminal vocabulary (met /
   *  budget-exhausted / plateau / human-stop / park-awaiting-decision /
   *  round-failure / interrupted). Additive sidecar to `status`, NEVER a 7th
   *  WorkflowRunStatus member: the status union is shared with packages/workflows
   *  + packages/dashboard, whose renderers never-assert exhaustiveness, so a 7th
   *  member is a documented compile break (contracts/workflow-run-status.d.ts).
   *  Plain string, not the GoalStopReason union: this store compiles under
   *  rootDir ./src and cannot import contracts/goal-contract.ts (TS6059). */
  stopReason?: string;
}

/** Keep this many finished runs on disk; older ones are pruned. Active runs are never pruned. */
const MAX_FINISHED = 50;

/**
 * Durable store of workflow run progress. One JSON file per run under
 * `<dataDir>/workflow-runs/`. Write-through on every mutation — runs are
 * minutes-to-hours long, so write frequency is low and the simplicity (no
 * debounce, crash-safe) is worth it. Loaded on construction so runs survive a
 * supervisor restart and remain resumable.
 */
export class WorkflowRunStore {
  private runs = new Map<string, WorkflowRunProgress>();
  // Children of runs that were "running" at load (a crash/restart mid-run). Drained
  // ONCE by the runner's PID-reuse-safe orphan sweep via takeOrphans().
  private orphans: OrphanChild[] = [];
  private readonly dir: string;
  // Fired for each run dropped by pruneFinished, so the owner can release sidecar
  // per-run state (e.g. the output store's buffers/file tails) that this store
  // doesn't know about — without that hook, pruned runs leak it.
  private readonly onPrune?: (correlationId: string) => void;

  constructor(dataDir: string, onPrune?: (correlationId: string) => void) {
    // dataDir comes from ContainerManager.getDataDir() (set before the HTTP API
    // serves). Fall back to <cwd>/data — the same default config.ts uses — only
    // if it's somehow empty at construction; data/ is gitignored either way.
    const base = dataDir || resolve(process.cwd(), "data");
    this.dir = resolve(base, "workflow-runs");
    this.onPrune = onPrune;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.dir)) return;
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(".json")) continue;
        // This directory is SHARED with core:exec's durable exit sentinels
        // (`<cid>.<node>.exit.json` — nodes/core.ts:126), which are NOT run
        // records: they carry only { exitCode }. They are skipped by name
        // rather than by shape so their absence from the store is silent and
        // expected — 48 "unexpected record" warnings per boot is noise that
        // teaches everyone to ignore the warning that matters. They must NOT
        // be deleted: readExitSentinel (nodes/core.ts:35) reads them on resume
        // to complete an exec whose supervisor died mid-run.
        if (file.endsWith(".exit.json")) continue;
        try {
          const raw = readFileSync(resolve(this.dir, file), "utf-8");
          const run = JSON.parse(raw) as WorkflowRunProgress;
          // Shape gate for anything ELSE that lands in here. A record without a
          // correlationId keys the map at `undefined` (collapsing every such file
          // into one phantom run), and one without `nodes` is a live grenade for
          // any consumer that walks them — sweepOrphanChildren (runner.ts) did
          // exactly that OUTSIDE its try, so a single stray file took down the
          // whole WorkflowRunner constructor and, with it, every workflow in the
          // supervisor. Unknown shapes are skipped LOUDLY: silence here is what
          // made that outage take a morning to find.
          if (typeof run?.correlationId !== "string" || !run.correlationId || run.nodes == null) {
            log("warn", "workflow_run_record_malformed", {
              file,
              correlationId: typeof run?.correlationId === "string" ? run.correlationId : typeof run?.correlationId,
              hasNodes: run?.nodes != null,
              note: "not a run record — skipped, not loaded",
            });
            continue;
          }
          // A run left "running" by a crash/restart is no longer executing —
          // mark it failed so it isn't a forever-spinner in the UI, but keep its
          // completed nodes so it's still resumable from where it stopped.
          if (run.status === "running") {
            run.status = "failed";
            // A crash interrupted this run: the node that was executing failed; nodes
            // that never started are skipped (not left "pending" under a terminal run —
            // that reads as still-going). Resume re-runs both failed + skipped — and
            // core:exec's resume path ADOPTS the recorded child (st.exec) or completes
            // from its exit sentinel instead of blindly re-executing. The records are
            // deliberately LEFT IN PLACE for that path (the old boot reap is gone).
            for (const [nodeId, st] of Object.entries(run.nodes)) {
              if (st.status === "running") st.status = "failed";
              else if (st.status === "pending") st.status = "skipped";
            }
          }
          // A run paused mid-drain when the process died: its in-flight nodes are
          // gone. Keep the run "paused" (still honest, still resumable) but mark the
          // dead nodes failed so they re-run on resume. Never-started nodes stay
          // "pending" — under a paused run that reads correctly as "waiting for
          // resume". Exec records stay for the adoption path, as above.
          if (run.status === "paused") {
            for (const [nodeId, st] of Object.entries(run.nodes)) {
              if (st.status === "running") st.status = "failed";
            }
          }
          this.runs.set(run.correlationId, run);
        } catch (err) {
          log("warn", "workflow_run_load_failed", { file, error: String(err) });
        }
      }
      log("info", "workflow_runs_loaded", { count: this.runs.size });
    } catch (err) {
      log("warn", "workflow_run_store_load_failed", { error: String(err) });
    }
  }

  private persist(run: WorkflowRunProgress): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      // Write to a temp sibling then rename into place (atomic per-file on the
      // same volume — the pins-helper pattern, src/http-api.ts writePins). A
      // direct writeFileSync leaves <cid>.json truncated if the process dies
      // mid-write, and load() then skips it as malformed — the run's whole
      // history, resume state included, is gone. Callers see either the old or
      // the new file, never a torn one.
      const target = resolve(this.dir, `${run.correlationId}.json`);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(run), "utf-8");
      renameSync(tmp, target);
    } catch (err) {
      log("warn", "workflow_run_persist_failed", { correlationId: run.correlationId, error: String(err) });
    }
  }

  /** A run is mutated in place then written through. Throws if the id is unknown —
   * callers (the runner's own callbacks) only ever reference ids they just init'd. */
  private touch(correlationId: string): WorkflowRunProgress {
    const run = this.runs.get(correlationId);
    if (!run) throw new Error(`WorkflowRunStore: unknown run "${correlationId}" — init() must precede node updates`);
    run.updatedAt = Date.now();
    return run;
  }

  /** Create a fresh run with all nodes pending, kind+nodeType seeded from catalog. */
  init(graph: TaskGraph, params: Record<string, unknown>, correlationId: string): WorkflowRunProgress {
    const now = Date.now();
    const nodes: Record<string, LiveNodeState> = {};
    for (const n of graph.nodes) {
      nodes[n.id] = { status: "pending", kind: classifyKind(n.type), nodeType: n.type };
      if (classifyKind(n.type) === "unknown") {
        log("warn", "node_kind_unmapped", { type: n.type, nodeId: n.id });
      }
    }
    const run: WorkflowRunProgress = {
      correlationId,
      workflowId: graph.id,
      // Never blank in the Runs tab: prefer the graph name, fall back to its id,
      // then a synthesized label (covers internal callers that bypass the HTTP
      // name-required check). The HTTP boundary makes it mandatory for inline runs.
      workflowName: graph.name || graph.id || `run:${correlationId.slice(0, 12)}`,
      params,
      status: "running",
      startedAt: now,
      updatedAt: now,
      nodes,
      resumeCount: 0,
    };
    this.runs.set(correlationId, run);
    this.persist(run);
    this.pruneFinished();
    return run;
  }

  nodeStart(correlationId: string, nodeId: string): void {
    const run = this.touch(correlationId);
    run.nodes[nodeId] = { ...run.nodes[nodeId], status: "running", startedAt: Date.now(), error: undefined };
    this.persist(run);
  }

  /** Persist a completed node. Preserves kind/nodeType seeds from init; attaches
   *  the drained receipt and optional subRun rollup in this single write. */
  nodeComplete(
    correlationId: string,
    nodeId: string,
    result: NodeResult,
    receipt?: InferenceReceipt,
    subRun?: SubRunRollup,
  ): void {
    const run = this.touch(correlationId);
    const prev = run.nodes[nodeId];
    run.nodes[nodeId] = {
      status: "completed",
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      attempt: result.attempt,
      result: result.result,
      kind: prev?.kind ?? classifyKind(prev?.nodeType),
      nodeType: prev?.nodeType,
      receipt: receipt ?? prev?.receipt,
      subRun: subRun ?? prev?.subRun,
    };
    this.persist(run);
  }

  /** Persist a failed node. Preserves kind/nodeType seeds; attaches failure receipt. */
  nodeFailed(
    correlationId: string,
    nodeId: string,
    result: NodeResult,
    receipt?: InferenceReceipt,
  ): void {
    const run = this.touch(correlationId);
    const prev = run.nodes[nodeId];
    run.nodes[nodeId] = {
      status: result.status === "timed_out" ? "timed_out" : "failed",
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
      attempt: result.attempt,
      error: result.error,
      // Keep any context payload a failed node returned (e.g. a research
      // iteration's round breakdown) so the failure is inspectable, not just a string.
      result: result.result,
      kind: prev?.kind ?? classifyKind(prev?.nodeType),
      nodeType: prev?.nodeType,
      receipt: receipt ?? prev?.receipt,
      subRun: prev?.subRun,
    };
    this.persist(run);
  }

  nodeSkipped(correlationId: string, nodeId: string): void {
    const run = this.touch(correlationId);
    run.nodes[nodeId] = { ...run.nodes[nodeId], status: "skipped" };
    this.persist(run);
  }

  /** Mark a run terminal from its final trace status. */
  finish(correlationId: string, status: "completed" | "failed" | "partial"): void {
    const run = this.runs.get(correlationId);
    if (!run) return; // a sync inline run may finish without the store caring
    // Cancel is terminal by operator action: a late finish() (e.g. a research loop
    // settling, or a stale engine returning after the run was cancelled) must not
    // resurrect it to completed/partial. markCancelled owns the cancelled state.
    // Same precedence for paused: markPaused owns that state (including the
    // "nothing left to do — actually completed" escape on the settle call).
    if (run.status === "cancelled" || run.status === "paused") return;
    run.status = status;
    run.completedAt = Date.now();
    run.updatedAt = run.completedAt;
    this.persist(run);
  }

  /** Mark a run failed wholesale (e.g. the async run threw before/around execute). */
  fail(correlationId: string, error: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    // Same terminal-cancel precedence as finish(): a cancelled run that then throws on
    // the way down stays "cancelled", not "failed".
    if (run.status === "cancelled") return;
    run.status = "failed";
    run.completedAt = Date.now();
    run.updatedAt = run.completedAt;
    // The async run threw: an in-flight node failed; never-started nodes are
    // skipped (not left pending under a terminal run). Resume re-runs both.
    for (const st of Object.values(run.nodes)) {
      if (st.status === "running") { st.status = "failed"; st.error = error; }
      else if (st.status === "pending") { st.status = "skipped"; }
    }
    this.persist(run);
  }

  /**
   * Mark a run cancelled (operator hit cancel). Distinct from `failed` so the UI can
   * tell "the operator stopped it" from "it broke". Any node still `pending`/`running`
   * becomes `skipped` — the downstream work is not going to happen. Nodes that already
   * completed/failed keep their honest terminal state. Idempotent: the runner calls
   * this from cancelRun() AND again after the engine's trace settles, so it must be
   * safe to apply twice.
   */
  markCancelled(correlationId: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    run.status = "cancelled";
    run.completedAt = Date.now();
    run.updatedAt = run.completedAt;
    for (const st of Object.values(run.nodes)) {
      if (st.status === "pending" || st.status === "running") st.status = "skipped";
    }
    this.persist(run);
  }

  /**
   * Mark a run paused (operator hit pause). Distinct from cancelled: nothing is
   * aborted — in-flight nodes keep draining and recording AFTER this flips, so
   * "paused" + a node still "running" is an honest combination (draining). The
   * runner calls this from pauseRun() and again when the engine settles, so it is
   * idempotent; on the settle call, a run with every node completed finishes
   * "completed" instead — the pause landed after the last dispatch and there is
   * nothing left to resume. Cancel keeps precedence (an operator cancel that
   * raced the pause wins).
   */
  markPaused(correlationId: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    if (run.status === "cancelled") return;
    const allComplete = Object.values(run.nodes).every(st => st.status === "completed");
    run.status = allComplete ? "completed" : "paused";
    run.updatedAt = Date.now();
    if (allComplete) run.completedAt = run.updatedAt;
    this.persist(run);
  }

  /** Record WHY a run settled (goal-contract terminal vocabulary) — the additive
   *  honesty sidecar to `status` (a plateau must not read as a bare "completed").
   *  No-op on an unknown id, matching finish/fail: a caller may settle a run this
   *  store never tracked. */
  setStopReason(correlationId: string, reason: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    run.stopReason = reason;
    run.updatedAt = Date.now();
    this.persist(run);
  }

  /** The child a previous engine recorded for this node — the resume path's
   *  adoption candidate (undefined if none recorded or already cleared). */
  getExecChild(correlationId: string, nodeId: string): { pid: number; command: string } | undefined {
    const st = this.runs.get(correlationId)?.nodes[nodeId];
    return st?.exec ? { pid: st.exec.pid, command: st.exec.command } : undefined;
  }

  /** Record a node's spawned child (core:exec) so a restart can verify-and-reap it.
   *  No-op if the run/node is gone (pruned mid-flight). */
  recordExecChild(correlationId: string, nodeId: string, pid: number, command: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    const st = run.nodes[nodeId];
    if (!st) return;
    st.exec = { pid, command, startedAt: Date.now() };
    run.updatedAt = Date.now();
    this.persist(run);
  }

  /** Drop a node's child record once the child has exited (clean or killed). */
  clearExecChild(correlationId: string, nodeId: string): void {
    const run = this.runs.get(correlationId);
    if (!run) return;
    const st = run.nodes[nodeId];
    if (!st?.exec) return;
    delete st.exec;
    run.updatedAt = Date.now();
    this.persist(run);
  }

  /** Drain the orphaned children discovered on load (runs left "running" by a
   *  restart). Returns them ONCE — subsequent calls return []. The runner reaps them
   *  after a PID-reuse-safe command-line verification. */
  takeOrphans(): OrphanChild[] {
    const out = this.orphans;
    this.orphans = [];
    return out;
  }

  /**
   * Prepare an existing run for resume: reset every non-completed node back to
   * pending (the engine will re-run them), bump resumeCount, set status running.
   * Completed nodes keep their stored result so the engine carries them forward.
   */
  markResuming(correlationId: string): void {
    const run = this.touch(correlationId);
    for (const [nodeId, st] of Object.entries(run.nodes)) {
      if (st.status !== "completed") {
        // Preserve kind/nodeType from init seed so they survive the resume reset.
        run.nodes[nodeId] = { status: "pending", kind: st.kind, nodeType: st.nodeType };
      }
    }
    run.status = "running";
    run.completedAt = undefined;
    run.resumeCount += 1;
    this.persist(run);
  }

  /** The completed nodes of a run, as NodeResults the engine can carry forward. */
  toPriorResults(correlationId: string): NodeResult[] {
    const run = this.runs.get(correlationId);
    if (!run) return [];
    const out: NodeResult[] = [];
    for (const [nodeId, st] of Object.entries(run.nodes)) {
      if (st.status !== "completed") continue;
      out.push({
        nodeId,
        status: "completed",
        result: st.result,
        startedAt: st.startedAt ?? 0,
        completedAt: st.completedAt ?? 0,
        durationMs: st.durationMs ?? 0,
        attempt: st.attempt ?? 1,
      });
    }
    return out;
  }

  get(correlationId: string): WorkflowRunProgress | undefined {
    return this.runs.get(correlationId);
  }

  /** All runs, most-recently-updated first. */
  list(): WorkflowRunProgress[] {
    return [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Remove a run entirely (its in-memory entry + persisted file). For the
   *  dashboard's delete-run declutter. Returns whether it existed. */
  delete(correlationId: string): boolean {
    const existed = this.runs.delete(correlationId);
    // Map membership is the allowlist: the id arrives raw from the HTTP route
    // (DELETE /workflow/run/:id) and is interpolated into the unlink path.
    // Unlinking without this check would let a traversal-shaped id ("../x")
    // delete arbitrary *.json outside the store. A persisted file only exists
    // for ids that were in the map (load() is its inverse).
    if (existed) {
      try {
        const f = resolve(this.dir, `${correlationId}.json`);
        if (existsSync(f)) unlinkSync(f);
      } catch (err) {
        log("warn", "workflow_run_delete_failed", { correlationId, error: String(err) });
      }
    }
    return existed;
  }

  /** Drop the oldest finished runs beyond MAX_FINISHED (active and paused runs
   *  are kept — a paused run is an operator's parked work, not clutter). */
  private pruneFinished(): void {
    const finished = [...this.runs.values()]
      .filter(r => r.status !== "running" && r.status !== "paused")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const run of finished.slice(MAX_FINISHED)) {
      this.runs.delete(run.correlationId);
      try {
        const f = resolve(this.dir, `${run.correlationId}.json`);
        if (existsSync(f)) unlinkSync(f);
      } catch (err) {
        log("warn", "workflow_run_prune_failed", { correlationId: run.correlationId, error: String(err) });
      }
      // Release sidecar per-run state (output buffers/file tails) now the record is gone.
      this.onPrune?.(run.correlationId);
    }
  }
}
