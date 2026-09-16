import { readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type TaskGraph,
  type ExecutionTrace,
  type ExecutionCallbacks,
  type NodeResult,
  NodeRegistry,
  execute,
} from "@agentruntime/task-graph";
import { registerNodes, buildCaps, type WorkflowDeps } from "./nodes/index.js";
import { coverageLedgerName, reduceCoverage, type CoverageSummary } from "./nodes/coverage-types.js";
import type { NodeCaps, ReceiptCaps, RunControlCaps, RunMode, WorkflowInvoker } from "./nodes/contract.js";
import { RunControlRegistry } from "./run-control.js";
import {
  buildSubRunRollup,
  type InferenceReceipt,
  type SubRunRollup,
} from "./epistemics.js";
import { getProcessCommandLine, killTreeByPid } from "./proc-kill.js";
import { preflightGraphModels, formatModelRefusal } from "../runtimes/model-catalog.js";
import { validateEnvelope } from "./validate-envelope.js";
import { WorkflowRunStore, type WorkflowRunProgress } from "./run-store.js";
import { WorkflowPresetStore, type WorkflowPreset } from "./preset-store.js";
import { summarizePresetAdoption, type PresetAdoption } from "./node-presets.js";
import { WorkflowOutputStore } from "./output-store.js";
import { findResumableRun, DEFAULT_RETRY_WINDOW_MS } from "./retry-match.js";
import { RunBudget, resolveRunBudget } from "./run-budget.js";
import {
  runResearchLoop,
  buildLoopGraph,
  buildDebateRefineRound,
  type ResearchLoopConfig,
} from "./research-loop.js";
import { log } from "../logger.js";
import { assert } from "../assert.js";

/** Mint a run id in the same shape task-graph's internal generator uses, so the
 * id is known up-front for async start + resume + live progress. */
function makeCorrelationId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// When running via tsx: __dirname is src/workflows, definitions are at src/workflows/definitions
// When running compiled: __dirname is dist/workflows, definitions are at src/workflows/definitions (relative to project root)
const DEFINITIONS_DIR = resolve(__dirname, "definitions");

const MEMORY_MCP_URL = process.env.MEMORY_MCP_URL || "http://127.0.0.1:3005";
// Retry-match window: how far back a failed/partial run of the same workflow+params
// is still eligible to be resumed instead of re-run from scratch. Env-overridable.
const RETRY_WINDOW_MS = Number(process.env.WORKFLOW_RETRY_WINDOW_MS) || DEFAULT_RETRY_WINDOW_MS;

/** Thrown by runOrResume/startOrResumeNamed when a matching run of the same
 *  workflow+params is already "running" — the caller should not spawn a duplicate.
 *  The HTTP layer maps this to 409, carrying the in-flight run's correlationId so
 *  the client can poll or cancel it instead. */
export class WorkflowInFlightError extends Error {
  public readonly correlationId: string;
  constructor(correlationId: string, message: string) {
    super(message);
    this.name = "WorkflowInFlightError";
    this.correlationId = correlationId;
  }
}

/** Optional completion callback: whisper this agent when an async run settles. The
 *  opt-in, initiator-chosen form of the old hardcoded agent:notify node. */
export interface WorkflowNotify {
  agent: string;
  message?: string;
  /** Condense long noisy messages before whisper (default true when omitted). */
  condense?: boolean;
}

export class WorkflowRunner {
  private registry = new NodeRegistry();
  private definitions = new Map<string, TaskGraph>();
  // BLUEPRINTS — the reusable, agent-facing definitions shown in the Definitions
  // tab. Populated only at startup (file-backed defs + genome-beat). Inline run
  // graphs + per-run synthetic loop graphs go into `definitions` (so the Runs view
  // can resolve+draw them) but NOT here, so one-off runs don't pollute the
  // blueprint list. blueprintFiles maps a file-backed id → its JSON path for delete.
  private blueprintIds = new Set<string>();
  private blueprintFiles = new Map<string, string>();
  private store: WorkflowRunStore;
  private presetStore: WorkflowPresetStore;
  private outputStore = new WorkflowOutputStore();
  // Cancellation + run-mode channel the task-graph engine can't express. In-memory:
  // a restart clears it (those runs are dead), and the orphan sweep reaps their
  // persisted children.
  private runControl = new RunControlRegistry();
  /** In-flight receipt capture: keyed by `${cid}:${nodeId}`. Written by toHandler's
   *  auto-mint and agent:run's rich self-enrich; drained into the single nodeComplete write. */
  private pendingReceipts = new Map<string, InferenceReceipt>();
  private pendingNotify = new Map<string, WorkflowNotify>();
  private dataDir: string;
  private extraDefinitionsDirs: string[];
  /** Retained so `reloadNodes()` can re-run registerNodes/buildCaps against a freshly
   *  imported node module. Without this the constructor's deps are unreachable and a
   *  hot node reload would have nothing to bind the new handlers' capabilities to. */
  private deps: WorkflowDeps;
  /** Why the LAST scan's rejects are kept: a definition that fails envelope validation
   *  is skipped, and before this field the only trace was a log line — POST
   *  /workflows/reload answered {ok:true, added:[]} while silently dropping a file it
   *  had just refused (observed 2026-08-05 with review-panel vs an unregistered
   *  core:merge). A reload that cannot say what it rejected is the ambiguous-success
   *  failure the Honest Response principle exists to forbid. */
  private lastScanFailures: Array<{ file: string; error: string }> = [];
  /** The three capability channels assembled in the constructor. Retained (rather than
   *  left as constructor locals) so `reloadNodes()` can hand the SAME channels to a
   *  freshly imported node module — re-deriving them would give the new handlers a
   *  different run-control registry than the one the engine is actually driving. */
  private runControlCaps!: RunControlCaps;
  private workflowInvoker!: WorkflowInvoker;
  private receiptCaps!: ReceiptCaps;
  /** The same capability layer the nodes get — used to whisper a run's optional
   *  completion callback when it settles. */
  private caps: NodeCaps;

  /** Resolves once circulation's genome-beat has been folded in (or failed to). */
  private circulationReady: Promise<void>;

  /** Ceiling on `workflow:run` nesting depth — a backstop against a cyclic
   *  workflowId reference (A runs B runs A …) turning into unbounded recursion.
   *  Not a tunable: depth is an internal invariant, not something a graph author
   *  should need to raise (see invokeNested). */
  private readonly MAX_NESTED_DEPTH = 5;

  constructor(deps: WorkflowDeps) {
    // Durable live-run store under the configured data dir (gitignored). cm's
    // dataDir is set before the HTTP API serves; the store falls back to <cwd>/data.
    this.dataDir = deps.cm.getDataDir();
    this.deps = deps;
    this.extraDefinitionsDirs = deps.extraDefinitionsDirs ?? [];
    // Store FIRST: the run-control facade below persists exec-child records through
    // it, and the orphan sweep reads from it. Pruning a run record also drops its
    // live-output buffers/file tails — otherwise a scheduled/looping workflow leaks
    // one output-store entry per pruned run.
    this.store = new WorkflowRunStore(this.dataDir, (cid) => this.outputStore.clear(cid));
    // The cancellation + run-mode channel nodes reach via caps.run. mode/signal/
    // isCancelled delegate to the in-memory registry; recordChild/clearChild persist
    // through the durable store so a supervisor restart can verify-and-reap orphans.
    const runControl: RunControlCaps = this.runControlCaps = {
      mode: (cid) => this.runControl.mode(cid),
      signal: (cid) => this.runControl.signal(cid),
      isCancelled: (cid) => this.runControl.isCancelled(cid),
      recordChild: (cid, nodeId, pid, command) => this.store.recordExecChild(cid, nodeId, pid, command),
      clearChild: (cid, nodeId) => this.store.clearExecChild(cid, nodeId),
      recordedChild: (cid, nodeId) => this.store.getExecChild(cid, nodeId),
      execStateDir: () => resolve(this.dataDir, "workflow-runs"),
    };
    // The `workflow:run` node's DAG-of-DAGs channel: closures over invokeNested
    // (private below), which resolves the caller's depth from runControl and
    // enforces MAX_NESTED_DEPTH BEFORE running the sub-workflow. Building this
    // closure never invokes it — it only fires once a `workflow:run` node
    // executes, always after the constructor has finished (definitions/
    // circulationReady are populated by then).
    const workflowInvoker: WorkflowInvoker = this.workflowInvoker = {
      run: (id, params, caller) => this.invokeNested(id, undefined, params, caller),
      runGraph: (graph, params, caller) => this.invokeNested(undefined, graph, params, caller),
      describe: (id) => this.definitions.get(id),
    };
    // Epistemic receipt capture: closures over the runner's pendingReceipts map.
    // fillOnly=true in generic auto-mint lets a rich agent:run self-capture win.
    const receiptCaps: ReceiptCaps = this.receiptCaps = {
      capture: (cid, nodeId, receipt, opts = {}) => {
        const key = `${cid}:${nodeId}`;
        if (opts.fillOnly && this.pendingReceipts.has(key)) return;
        this.pendingReceipts.set(key, receipt);
      },
      // Settled state only. Reads the STORE (post-drain), never pendingReceipts:
      // a fan-in must account for what actually completed, and an in-flight node's
      // half-written receipt is not that. An unknown run reads undefined.
      runNodes: (cid) => this.store.get(cid)?.nodes,
    };
    // The single node-registration path: the composable node library
    // (src/workflows/nodes) — contract + core/demo/agent/judge/supervisor
    // primitives. (Retired the old in-line handlers.ts; its nodes were ported
    // here under their existing type strings, so definitions are unchanged.)
    registerNodes(this.registry, deps, this.dataDir, this.outputStore, runControl, workflowInvoker, receiptCaps);
    this.caps = buildCaps(deps, this.dataDir, this.outputStore, runControl, workflowInvoker, receiptCaps);
    this.presetStore = new WorkflowPresetStore(this.dataDir);
    this.loadDefinitions();
    this.circulationReady = this.loadCirculation();
    // Reap any child left running by a previous supervisor instance (crash/restart
    // mid-run). Deferred off this constructor + PID-reuse-safe (verifies the live
    // command line before killing).
    this.sweepOrphanChildren();
  }

  /**
   * Additively fold circulation's genome-beat into this runner: register its node
   * handlers (organ:run, grade:verify) onto our registry and add the genome-beat
   * DAG to our definitions map, so an existing `POST /workflow {workflowId:
   * "genome-beat"}` triggers a graded beat through THIS runner.
   *
   * Resilience is the contract: circulation is an optional, self-improvement extra.
   * The whole load is in try/catch — if circulation can't be resolved, fails to
   * parse its genome-beat.json, or otherwise throws, we log a warning and CONTINUE
   * with the supervisor's own handlers/definitions intact.
   *
   * Loaded via a DYNAMIC `import()` (not a top-level static import) for two reasons:
   *   1. Isolation — circulation's module body runs `genomeBeatDefinition =
   *      loadBeat()` at import time; a bad definition would throw. A static import
   *      would surface that as a load-time crash of runner.ts (and thus the whole
   *      supervisor, since http-api.ts imports this module). The dynamic import keeps
   *      that failure inside this try/catch.
   *   2. Loader correctness — the supervisor runs under tsx, whose ESM loader hooks
   *      resolve circulation's `.ts` entry. `createRequire().require()` would use
   *      Node's native CJS resolver, which cannot load a `"type":"module"` `.ts`
   *      package; `import()` goes through tsx's loader and can.
   *
   * The import is awaited into `circulationReady` so list()/run() callers that need
   * the genome-beat can await it; existing supervisor definitions are available
   * synchronously and are unaffected by this async fold-in.
   */
  private async loadCirculation(): Promise<void> {
    try {
      const circulation = (await import("@agentruntime/circulation")) as {
        registerCirculation: (registry: NodeRegistry) => void;
        genomeBeatDefinition: TaskGraph;
      };
      circulation.registerCirculation(this.registry);
      const def = circulation.genomeBeatDefinition;
      this.definitions.set(def.id, def);
      this.blueprintIds.add(def.id); // a reusable workflow (not file-backed) — a blueprint, not ephemeral
      log("info", "circulation_registered", { workflowId: def.id, nodes: def.nodes.length });
    } catch (err) {
      log("warn", "circulation_register_failed", {
        error: String(err),
        note: "supervisor workflows continue without circulation's genome-beat",
      });
    }
  }

  /** Scan every definitions dir into id -> {graph, file}. Later dirs win on an id
   *  clash (same precedence as always: extra dirs override built-ins). Parse and
   *  envelope-validation failures are warned and skipped — a broken file never
   *  evicts a previously-loaded def.
   *
   *  Envelope validation here is DEFINITION-TIME: a typo'd field, unknown node
   *  type, or dangling edge is rejected at load, before the def is runnable at
   *  all — not mid-run after real token spend. The node-type check runs against
   *  this.registry, which the constructor populates (registerNodes) BEFORE the
   *  first scan; the only late-registered types are circulation's (organ:run,
   *  grade:verify), and its genome-beat blueprint is code-registered by
   *  loadCirculation, never loaded through this scanner. */
  private scanDefinitionFiles(): Map<string, { graph: TaskGraph; file: string }> {
    const scanned = new Map<string, { graph: TaskGraph; file: string }>();
    // Reset per scan: `lastScanFailures` describes THIS scan, so a file fixed since
    // the previous reload must stop being reported as broken.
    this.lastScanFailures = [];
    // Try the co-located definitions dir first (works for both tsx and compiled),
    // then fall back to source root (for when running from dist/)
    const srcFallback = resolve(__dirname, "../../src/workflows/definitions");
    const dirs = [DEFINITIONS_DIR, srcFallback, ...this.extraDefinitionsDirs];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(dir, file), "utf-8");
          const graph = validateEnvelope(JSON.parse(raw), this.registry);
          scanned.set(graph.id, { graph, file: resolve(dir, file) });
        } catch (err) {
          log("warn", "workflow_definition_load_failed", { file, error: String(err) });
          this.lastScanFailures.push({ file, error: String(err) });
        }
      }
    }
    return scanned;
  }

  private loadDefinitions(): void {
    for (const [id, { graph, file }] of this.scanDefinitionFiles()) {
      this.definitions.set(id, graph);
      this.blueprintIds.add(id);
      this.blueprintFiles.set(id, file);
    }
    log("info", "workflows_loaded", { count: this.definitions.size, ids: [...this.definitions.keys()] });
  }

  /**
   * Re-scan the definition dirs and reconcile file-backed blueprints in place — the
   * on-demand version of the constructor's load, so editing or adding a definition
   * JSON no longer needs a supervisor restart. Only file-backed blueprints are
   * touched: inline graphs, synthetic loop graphs, and code-registered blueprints
   * (circulation's genome-beat) are left alone. A blueprint whose file vanished (or
   * whose file now declares a different id) is dropped; a file that stops PARSING
   * keeps its previously-loaded definition — reload never leaves the registry worse
   * than it found it. In-flight runs are untouched (they hold their own graph); the
   * new definition applies from the next run/resume that resolves the id.
   */
  reloadDefinitions(): {
    total: number;
    added: string[];
    updated: string[];
    removed: string[];
    rejected: Array<{ file: string; error: string }>;
  } {
    const scanned = this.scanDefinitionFiles();
    const scannedFiles = new Set([...scanned.values()].map(v => v.file));
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [id, file] of [...this.blueprintFiles]) {
      if (scanned.has(id)) continue;
      // Gone = file deleted, or file still parses but under a different id (rename).
      // A file that exists but failed to parse is neither — its old def is kept.
      if (!existsSync(file) || scannedFiles.has(file)) {
        this.definitions.delete(id);
        this.blueprintIds.delete(id);
        this.blueprintFiles.delete(id);
        removed.push(id);
      }
    }
    for (const [id, { graph, file }] of scanned) {
      const known = this.blueprintFiles.has(id);
      const changed = known && JSON.stringify(this.definitions.get(id)) !== JSON.stringify(graph);
      this.definitions.set(id, graph);
      this.blueprintIds.add(id);
      this.blueprintFiles.set(id, file);
      if (!known) added.push(id);
      else if (changed) updated.push(id);
    }
    const rejected = [...this.lastScanFailures];
    log("info", "workflows_reloaded", { total: this.blueprintIds.size, added, updated, removed, rejected: rejected.length });
    return { total: this.blueprintIds.size, added, updated, removed, rejected };
  }

  /**
   * Hot-register NODE TYPES without a supervisor restart — the other half of
   * `reloadDefinitions`, and the reason `review-panel` needed a fleet bounce to ship
   * a 20-line pure function (2026-08-05).
   *
   * WHY THIS WAS EVER A RESTART, since the tree recorded "New nodes only load on
   * supervisor restart" as a fact for two months: nothing architectural. NodeRegistry
   * is a plain Map with no freeze and no already-registered guard (task-graph
   * registry.ts), and `loadCirculation` ALREADY late-registers organ:run/grade:verify
   * onto this same live registry after the constructor has returned. The only real
   * obstacle is ESM: `registerNodes` binds the node module imported at boot, and Node
   * caches modules by URL with no unload, so simply calling it again re-registers the
   * identical handlers. A unique `?v=` makes it a different URL and therefore a
   * different module — verified under tsx before this was written, because a
   * cache-busting trick that the loader normalises away would have made the whole
   * endpoint a silent no-op that reports success.
   *
   * THREE STEPS, and the third is the one that is easy to miss: re-import, re-register,
   * then RE-SCAN DEFINITIONS. A definition rejected earlier for naming a then-unknown
   * node type stays rejected until something re-validates it against the now-larger
   * registry — so a node reload that skips the re-scan looks like it worked and
   * changes nothing observable.
   *
   * QUIESCE, NOT SNAPSHOT: `registry.get(type)` is resolved per node execution, so
   * swapping handlers mid-run would execute one graph across two generations of code.
   * Rather than version the registry per run, this REFUSES while any run is running or
   * paused and names them. Refusing is honest and cheap; a half-swapped run is a bug
   * nobody would ever reproduce.
   *
   * COST, stated because it is real: the superseded module object stays resident —
   * ESM cannot evict it. Node defs are pure `defineNode` records closing over caps, so
   * the leak is small and bounded by reload count, but this is deliberately NOT a
   * general-purpose hot-reload and should not become one.
   */
  async reloadNodes(): Promise<{
    ok: boolean;
    refused?: string;
    activeRuns?: string[];
    nodeTypes: { before: number; after: number; added: string[] };
    definitions?: { total: number; added: string[]; updated: string[]; removed: string[]; rejected: Array<{ file: string; error: string }> };
  }> {
    const before = this.registry.types();
    // LIVE ENGINES ONLY — deliberately not the durable store. A `paused` record
    // survives a restart by design and can sit parked for weeks, so quiescing on
    // store status would refuse every reload forever: the first probe of this
    // method was blocked by two paused exec-notify runs from July 21. runControl
    // is begin()-without-end(), i.e. something is actually executing right now.
    const active = this.runControl.tracked();

    if (active.length > 0) {
      log("warn", "node_reload_refused", { activeRuns: active.length, note: "runs in flight — a mid-run handler swap would split one graph across two generations of code" });
      return {
        ok: false,
        refused: `${active.length} run(s) in flight (running or paused) — cancel/finish them or wait, then retry. A hot swap mid-run would execute one graph across two generations of node code.`,
        activeRuns: active,
        nodeTypes: { before: before.length, after: before.length, added: [] },
      };
    }

    // Unique per call: the SAME query string is cached (verified), so a fixed bust
    // would make the second reload of a session a silent no-op.
    const bust = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mod = (await import(`./nodes/index.js?v=${bust}`)) as typeof import("./nodes/index.js");
    // registerNodesFresh, NOT registerNodes: busting index.js alone re-reads the index
    // while its plain "./core.js" / "./agent-run.js" specifiers still resolve to the
    // ALREADY-CACHED modules, so the handlers re-registered are the stale ones. The
    // bust has to reach every node module, which is what registerNodesFresh does.
    await mod.registerNodesFresh(
      this.registry,
      this.deps,
      this.dataDir,
      this.outputStore,
      this.runControlCaps,
      this.workflowInvoker,
      this.receiptCaps,
      bust,
    );
    // Refresh the runner's own capability layer from the SAME module generation —
    // otherwise caps.* (used by the settle-notify path) and the node handlers would
    // come from two different module instances.
    this.caps = mod.buildCaps(
      this.deps,
      this.dataDir,
      this.outputStore,
      this.runControlCaps,
      this.workflowInvoker,
      this.receiptCaps,
    );

    const after = this.registry.types();
    const beforeSet = new Set(before);
    const added = after.filter((t) => !beforeSet.has(t));

    // Step 3 — re-validate definitions against the now-larger registry.
    const definitions = this.reloadDefinitions();

    log("info", "nodes_reloaded", { before: before.length, after: after.length, added, definitionsAdded: definitions.added, rejected: definitions.rejected.length });
    return { ok: true, nodeTypes: { before: before.length, after: after.length, added }, definitions };
  }

  async run(
    workflowId: string,
    params: Record<string, unknown>,
  ): Promise<ExecutionTrace> {
    // Ensure the circulation fold-in has settled before resolving a workflow id —
    // otherwise a request that lands in the window between construction and the
    // async import resolving would spuriously see "genome-beat" as unknown.
    // Supervisor definitions are present synchronously, so this only ever waits the
    // first time and never blocks on circulation being broken (it settles to a warn).
    await this.circulationReady;
    const graph = this.definitions.get(workflowId);
    if (!graph) throw new Error(`Unknown workflow: "${workflowId}"`);
    return this.runGraphAtDepth(graph, params, 0);
  }

  /**
   * Synchronous run — awaits the full trace before returning. This is the path
   * chrono and inline `POST /workflow` depend on (they read the returned trace
   * within their own await window), so its contract is unchanged. It now also
   * threads a known correlationId and records live progress to the store.
   */
  async runGraph(
    graph: TaskGraph,
    params: Record<string, unknown>,
  ): Promise<ExecutionTrace> {
    return this.runGraphAtDepth(graph, params, 0);
  }

  /** Named-workflow counterpart of `runGraphAtDepth` — resolves the definition
   *  first. Used by both the top-level `run()` (depth 0) and `invokeNested`
   *  (depth > 0, for a `workflow:run` node naming a workflow, which also threads
   *  its own cid as the sub-run's parent). */
  private async runAtDepth(
    workflowId: string,
    params: Record<string, unknown>,
    depth: number,
    parentCid?: string,
  ): Promise<ExecutionTrace> {
    await this.circulationReady;
    const graph = this.definitions.get(workflowId);
    if (!graph) throw new Error(`Unknown workflow: "${workflowId}"`);
    return this.runGraphAtDepth(graph, params, depth, parentCid);
  }

  /** Shared body of the old `runGraph()`: mint a correlationId, register the
   *  graph + init the store, run to completion at the given nesting depth.
   *  `parentCid` (set only by invokeNested) chains the sub-run to its invoker so
   *  cancel/pause cascade down into it (#653). */
  private async runGraphAtDepth(
    graph: TaskGraph,
    params: Record<string, unknown>,
    depth: number,
    parentCid?: string,
  ): Promise<ExecutionTrace> {
    // Envelope check at the execution entry: inline graphs (POST /workflow
    // {graph}, workflow:run inline sub-graphs) reach here without passing the
    // file scanner. Rejecting BEFORE definitions.set/store.init means a bad
    // graph never registers, never mints a run record, and never spends a
    // token. File-backed defs re-validate here too — cheap (O(nodes+edges)),
    // and it keeps every entry uniform.
    validateEnvelope(graph, this.registry);
    const correlationId = makeCorrelationId();
    // Register the graph so the dashboard can resolve it by id (GET /workflow/:id)
    // to draw the run's graph. Inline graphs aren't otherwise in the map, which
    // made the Runs view show "definition not found". Named runs re-set the same
    // object (harmless).
    this.definitions.set(graph.id, graph);
    this.store.init(graph, params, correlationId);
    // SYNC: the caller (inline POST /workflow, chrono, or a workflow:run node
    // awaiting this nested sub-run) reads the returned trace inline — so an
    // agent:notify inside this graph no-ops to avoid a self-echo.
    return this.execGraph(graph, params, correlationId, "sync", undefined, depth, parentCid);
  }

  /**
   * Invoked exclusively by the `workflow:run` node's `caps.workflow` closures
   * (built in the constructor) — never called directly by a graph param or an
   * external caller. Looks up the CALLER's depth from `runControl` (keyed by
   * `callerCorrelationId`, the invoking node's own run id) and increments it;
   * this is the sole place nesting depth is computed, and it is unreachable from
   * the public `run`/`runGraph` signatures (which stay depth-0-only), so no HTTP
   * caller or graph param can spoof/bypass the depth guard. The caller's cid also
   * becomes the sub-run's PARENT link (#653): cancelling or pausing the parent
   * now cascades into every tracked descendant instead of leaving the whole
   * nested DAG running to completion with its result discarded.
   */
  private async invokeNested(
    workflowId: string | undefined,
    inlineGraph: TaskGraph | undefined,
    params: Record<string, unknown>,
    callerCorrelationId: string,
  ): Promise<ExecutionTrace> {
    const parentDepth = this.runControl.depth(callerCorrelationId);
    if (parentDepth === undefined) {
      throw new Error(
        `workflow:run: caller run "${callerCorrelationId}" is not tracked by RunControlRegistry — ` +
          `cannot compute nesting depth for an untracked caller`,
      );
    }
    const depth = parentDepth + 1;
    if (depth > this.MAX_NESTED_DEPTH) {
      throw new Error(
        `workflow:run: nesting depth exceeded (max ${this.MAX_NESTED_DEPTH}) invoking ` +
          `"${workflowId ?? inlineGraph?.id ?? "<inline>"}" — likely a cyclic workflowId reference`,
      );
    }
    return inlineGraph
      ? this.runGraphAtDepth(inlineGraph, params, depth, callerCorrelationId)
      : this.runAtDepth(workflowId!, params, depth, callerCorrelationId);
  }

  /**
   * Start a run in the BACKGROUND and return its correlationId immediately. For
   * long DAGs the caller (dashboard) watches progress via the store + bus events
   * instead of blocking on the trace. Fire-and-forget: a throw is caught and
   * recorded as a failed run so the UI never shows a forever-spinner.
   */
  startRun(graph: TaskGraph, params: Record<string, unknown>, notify?: WorkflowNotify): string {
    // Same definition-time envelope gate as runGraphAtDepth: throws synchronously
    // (HTTP maps it to an error response) before the run record exists, so an
    // async caller gets a clear rejection instead of a doomed correlationId.
    validateEnvelope(graph, this.registry);
    const correlationId = makeCorrelationId();
    // Register the inline graph so the dashboard Runs view can resolve it by id
    // and draw the graph (otherwise an inline run shows "definition not found").
    this.definitions.set(graph.id, graph);
    this.store.init(graph, params, correlationId);
    // Dual-notify footgun: body `notify` (fireNotify on settle) AND an in-graph
    // agent:notify BOTH deliver — two chat turns for one run. Warn; do not
    // suppress (some defs want a short settle ping + a body-bearing agent:notify).
    if (notify?.agent) {
      this.warnDualNotify(graph, correlationId, notify.agent);
      this.pendingNotify.set(correlationId, notify);
    }
    void this.execGraph(graph, params, correlationId, "async")
      .then(() => {
        // If cancelRun already fired the notify, skip the duplicate.
        if (!this.pendingNotify.delete(correlationId)) return;
        return this.fireNotify(correlationId, notify);
      })
      .catch((err) => {
        const shouldNotify = this.pendingNotify.delete(correlationId);
        log("error", "workflow_async_failed", { correlationId, workflowId: graph.id, error: String(err) });
        this.store.fail(correlationId, String(err));
        if (shouldNotify) void this.fireNotify(correlationId, notify);
      });
    return correlationId;
  }

  /** Async start of a NAMED workflow (resolves the definition, awaiting the
   * circulation fold-in first like run() does). Returns the correlationId. */
  async startNamed(workflowId: string, params: Record<string, unknown>, notify?: WorkflowNotify): Promise<string> {
    await this.circulationReady;
    const graph = this.definitions.get(workflowId);
    if (!graph) throw new Error(`Unknown workflow: "${workflowId}"`);
    return this.startRun(graph, params, notify);
  }

  /**
   * Log when body settle-notify and in-graph agent:notify would both deliver.
   * Does not suppress either path — only makes the double visible on the bus.
   */
  private warnDualNotify(graph: TaskGraph, correlationId: string, bodyAgent: string): void {
    const graphNotifyNodes = graph.nodes.filter((n) => n.type === "agent:notify").map((n) => n.id);
    if (graphNotifyNodes.length === 0) return;
    log("warn", "workflow_notify_dual", {
      correlationId,
      workflowId: graph.id,
      bodyAgent,
      graphNotifyNodes,
      hint: "POST body notify + agent:notify both fire — pick one, or expect two messages. See src/workflows/CLAUDE.md",
    });
  }

  /**
   * Fire the optional completion callback: when an async run settles, whisper the
   * initiating agent (fire-and-forget) with the run's final status. Opt-in — does
   * nothing unless the dispatch supplied a `notify` target. The correct, opt-in form
   * of the old hardcoded agent:notify node (which we removed for spamming).
   */
  private async fireNotify(correlationId: string, notify?: WorkflowNotify): Promise<void> {
    if (!notify?.agent) return;
    try {
      const run = this.store.get(correlationId);
      if (!run) {
        log("warn", "workflow_notify_no_run", { correlationId, agent: notify.agent });
        return;
      }
      const status = run.status;
      assert(
        run.workflowId !== undefined,
        "run.workflowId must be set — store.init() writes graph.id before any notify can fire",
      );
      const wf = run.workflowId;
      const icon = status === "completed" ? "✅" : status === "cancelled" ? "🚫" : status === "paused" ? "⏸️" : "⚠️";
      // Cancelled/paused runs: send a clean message instead of interpolating
      // stale/missing node results from the template (undispatched nodes have no
      // results; a cancelled child's stdout is partial).
      let msg = status === "cancelled"
        ? `🚫 Workflow "${wf}" was cancelled — run ${correlationId}.`
        : status === "paused"
        ? `⏸️ Workflow "${wf}" paused — run ${correlationId}. Resume via POST /workflow/resume {"correlationId":"${correlationId}"}.`
        : (notify.message ?? `${icon} workflow "${wf}" ${status} — run ${correlationId}. Read /workflow/run/${correlationId} for results.`);
      const condenseEnabled = notify.condense !== false;
      if (condenseEnabled) {
        const { condenseNotifyMessage } = await import("./notify-condense.js");
        const result = await condenseNotifyMessage(msg, true);
        msg = result.text;
        if (result.condensed) {
          log("info", "workflow_notify_condensed", {
            correlationId,
            originalBytes: result.originalBytes,
            condensedBytes: result.condensedBytes,
          });
        } else if (result.passThrough) {
          // Condense failed — fell back to the deterministic sanitized+truncated form
          // (never full raw). Log which path fired so the fail-closed is observable.
          log("warn", "workflow_notify_condense_fallback", {
            correlationId,
            passThrough: result.passThrough,
            droppedBytes: result.droppedBytes,
          });
        }
      }
      this.caps.notify(notify.agent, msg);
      log("info", "workflow_notify", { correlationId, agent: notify.agent, status, condense: condenseEnabled });
    } catch (err) {
      log("warn", "workflow_notify_failed", { correlationId, agent: notify.agent, error: String(err) });
    }
  }

  /**
   * Guard + prep shared by every resume path: validates the run can be resumed
   * (known, not already running, not still winding down from a cancel), resolves
   * its definition, carries forward completed-node results, and bumps resumeCount.
   * Extracted out of resumeRun so runOrResume/startOrResumeNamed can drive the same
   * guards without duplicating them (the guards themselves are unchanged).
   */
  private prepareResume(correlationId: string): {
    graph: TaskGraph; params: Record<string, unknown>; priorResults: NodeResult[];
  } {
    const run = this.store.get(correlationId);
    if (!run) throw new Error(`Unknown run: "${correlationId}"`);
    if (run.status === "running") throw new Error(`Run "${correlationId}" is already running`);
    // A CANCELLED run may still be draining: cancellation is cooperative, so any
    // non-exec downstream node keeps executing after cancelRun flips the status.
    // Resuming while the original engine is still tracked would overlap two engines on
    // one correlationId — the stale engine's end()/finish() then clobbers the resumed
    // run's status and drops its cancel signal. Refuse until it has fully settled.
    if (this.runControl.isTracked(correlationId)) {
      throw new Error(`Run "${correlationId}" is still winding down (cancelled/paused, in-flight nodes not yet settled) — retry resume once it finishes`);
    }
    const graph = this.definitions.get(run.workflowId);
    if (!graph) throw new Error(`Workflow definition "${run.workflowId}" not found — cannot resume`);
    const priorResults = this.store.toPriorResults(correlationId);
    this.store.markResuming(correlationId); // increments run.resumeCount in place
    log("info", "workflow_resume_started", {
      correlationId, workflowId: graph.id, carried: priorResults.length, resumeCount: run.resumeCount,
    });
    return { graph, params: run.params, priorResults };
  }

  /**
   * Resume a prior run from before its failure: completed nodes are carried
   * forward (not re-run), the failed node and its dependents re-run. Reuses the
   * same correlationId so the run record updates in place. Runs in the background;
   * returns the correlationId.
   */
  resumeRun(correlationId: string): string {
    const { graph, params, priorResults } = this.prepareResume(correlationId);
    void this.execGraph(graph, params, correlationId, "async", priorResults).catch((err) => {
      log("error", "workflow_resume_failed", { correlationId, error: String(err) });
      this.store.fail(correlationId, String(err));
    });
    return correlationId;
  }

  /** Sync counterpart of resumeRun: awaits the full trace before returning, for
   *  the runOrResume (sync) dispatch path. */
  private async resumeRunSync(correlationId: string): Promise<ExecutionTrace> {
    const { graph, params, priorResults } = this.prepareResume(correlationId);
    return this.execGraph(graph, params, correlationId, "sync", priorResults);
  }

  /**
   * Sync run-or-resume: if a prior run of `workflowId` with identical `params` is
   * "running", throws WorkflowInFlightError (never spawn a duplicate concurrent
   * DAG). If a prior run is "failed"/"partial" within the retry window, resumes it
   * instead of starting fresh. Otherwise behaves exactly like `run()`. Pass
   * `opts.fresh: true` to skip matching entirely (used by chrono's scheduled ticks,
   * which are independent invocations that must never auto-resume a prior failure).
   */
  async runOrResume(
    workflowId: string,
    params: Record<string, unknown>,
    opts?: { fresh?: boolean; windowMs?: number },
  ): Promise<{ trace: ExecutionTrace; resumed: boolean; resumeCount: number }> {
    if (!opts?.fresh) {
      const match = findResumableRun(this.store.list(), workflowId, params, { windowMs: opts?.windowMs ?? RETRY_WINDOW_MS });
      log("info", "workflow_retry_match", {
        workflowId,
        decision: match?.kind ?? "no_match",
        matchedRun: match?.run.correlationId,
      });
      if (match?.kind === "in-flight") {
        throw new WorkflowInFlightError(match.run.correlationId,
          `Workflow "${workflowId}" is already running as ${match.run.correlationId}`);
      }
      if (match?.kind === "resume") {
        const trace = await this.resumeRunSync(match.run.correlationId);
        const run = this.store.get(match.run.correlationId);
        return { trace, resumed: true, resumeCount: run?.resumeCount ?? 1 };
      }
    }
    const trace = await this.run(workflowId, params);
    return { trace, resumed: false, resumeCount: 0 };
  }

  /**
   * Async counterpart of runOrResume: starts in the background and returns
   * immediately. Same matching semantics (in-flight throws, failed/partial within
   * the window resumes, otherwise behaves like startNamed). On the resume path,
   * `notify` is wired directly here (not via resumeRun, which has no notify
   * parameter) — mirroring startRun's fire-and-forget `.then`/`.catch` pattern so a
   * caller's completion callback still fires for a resumed run.
   */
  async startOrResumeNamed(
    workflowId: string,
    params: Record<string, unknown>,
    notify?: WorkflowNotify,
    opts?: { fresh?: boolean; windowMs?: number },
  ): Promise<{ correlationId: string; resumed: boolean; resumeCount: number }> {
    if (!opts?.fresh) {
      await this.circulationReady;
      const match = findResumableRun(this.store.list(), workflowId, params, { windowMs: opts?.windowMs ?? RETRY_WINDOW_MS });
      log("info", "workflow_retry_match", {
        workflowId,
        decision: match?.kind ?? "no_match",
        matchedRun: match?.run.correlationId,
      });
      if (match?.kind === "in-flight") {
        throw new WorkflowInFlightError(match.run.correlationId,
          `Workflow "${workflowId}" is already running as ${match.run.correlationId}`);
      }
      if (match?.kind === "resume") {
        const cid = match.run.correlationId;
        const { graph, params: runParams, priorResults } = this.prepareResume(cid);
        if (notify?.agent) {
          this.warnDualNotify(graph, cid, notify.agent);
          this.pendingNotify.set(cid, notify);
        }
        void this.execGraph(graph, runParams, cid, "async", priorResults)
          .then(() => {
            // If cancelRun already fired the notify, skip the duplicate.
            if (!this.pendingNotify.delete(cid)) return;
            return this.fireNotify(cid, notify);
          })
          .catch((err) => {
            const shouldNotify = this.pendingNotify.delete(cid);
            log("error", "workflow_resume_failed", { correlationId: cid, error: String(err) });
            this.store.fail(cid, String(err));
            if (shouldNotify) void this.fireNotify(cid, notify);
          });
        const run = this.store.get(cid);
        return { correlationId: cid, resumed: true, resumeCount: run?.resumeCount ?? 1 };
      }
    }
    const correlationId = await this.startNamed(workflowId, params, notify);
    return { correlationId, resumed: false, resumeCount: 0 };
  }

  /** Shared execution core: wires the store + bus-broadcasting logs into the
   * engine callbacks. `mode` sets the run's cancel/notify context (see run-control).
   * `priorResults` (when present) makes this a resume. */
  private async execGraph(
    graph: TaskGraph,
    params: Record<string, unknown>,
    correlationId: string,
    mode: RunMode,
    priorResults?: NodeResult[],
    depth: number = 0,
    parentCid?: string,
  ): Promise<ExecutionTrace> {
    log("info", "workflow_started", { workflowId: graph.id, correlationId, params, mode, resume: !!priorResults, depth });

    // ── MODEL PREFLIGHT — refuse before spending, not 300 seconds in ──────────
    // wf-1785951673755-bwqsst burned 303s of COMPLETED model work (orchestrate
    // 115s + reason-claude 176s) before two nodes died in 6s each on a model id
    // the grok CLI had retired. That error was knowable before the run started.
    // This is the same posture validate-envelope already takes for node types
    // ("rejected at LOAD, not mid-run after real token spend") and the conductor's
    // core:preflight takes for deploys ("refuse what the tree can prove will fail,
    // before anything is stopped") — applied to the one statically-checkable thing
    // neither of them covers.
    //
    // Here rather than at definition load, for two reasons the same run shows:
    // params are only bound now, so `{{params.model}}` cannot be judged earlier;
    // and a definition stays valid for weeks then goes stale the instant a provider
    // retires an id, so load-time is the wrong clock.
    //
    // Blocks ONLY on `unknown` — an id the provider itself denies. `unverified`
    // (no local oracle, e.g. claude) never blocks and is logged, because a gate
    // that pretends to check what it cannot is worse than one that admits its
    // blind spot.
    const preflight = preflightGraphModels(graph.nodes, params);
    if (preflight.unknown.length > 0 || preflight.unresolved.length > 0) {
      // The blueprint's path is known HERE and nowhere in the catalog module, so it
      // is threaded in: a refusal that names the offending node but not the file it
      // lives in turns a ten-second edit into a grep.
      const detail = formatModelRefusal(preflight, {
        workflowId: graph.id,
        file: this.blueprintFiles.get(graph.id),
      });
      log("error", "workflow_model_preflight_refused", {
        workflowId: graph.id,
        correlationId,
        file: this.blueprintFiles.get(graph.id),
        unknown: preflight.unknown.map((f) => `${f.nodeId}=${f.model}`),
        unresolved: preflight.unresolved.map((f) => `${f.nodeId}=${f.model}`),
        available: preflight.unknown[0]?.available,
        checked: preflight.checked,
        // Repeated in the structured log because dashboards and the event stream
        // render `note`, not the thrown message — and this is the sentence that
        // stops someone concluding the gate is the problem.
        note: "these ids were ALREADY fatal and used to fail at spawn after real spend; nothing was spent this time",
      });
      throw new Error(detail);
    }
    if (preflight.unverified.length > 0) {
      log("info", "workflow_model_preflight_partial", {
        workflowId: graph.id,
        correlationId,
        checked: preflight.checked,
        unverified: preflight.unverified.map((f) => `${f.runtime}:${f.model}`),
        note: "no local oracle for these runtimes — NOT validated, and deliberately not blocked",
      });
    }

    // Track this run for the duration so nodes can sense mode (sync/async) + cancel.
    // `depth` (0 for a top-level run) is what invokeNested reads via
    // runControl.depth(correlationId) to compute a nested workflow:run's child depth.
    // `parentCid` (set only for a nested sub-run) is the cascade channel: an operator
    // cancelling/pausing the parent tears every tracked sub-run down with it (#653).
    this.runControl.begin(correlationId, mode, depth, parentCid);

    // log() entries are broadcast to /events/stream (notifySubscribers), so these
    // callbacks both persist live state AND push deltas to the dashboard.
    //
    // Every callback first checks the run still exists: a run can be DELETED while its
    // async engine is winding down (an operator cancels, then deletes the "cancelled"
    // record while a killed core:exec's `close` is still draining). A late node update
    // on a deleted run is an expected race, not a violated invariant — no-op it here
    // rather than let the store's init-must-precede assertion throw a false
    // "workflow_async_failed". See cancelRun + deleteRun.
    const live = (cid: string): boolean => this.store.get(cid) !== undefined;

    // Per-run spend/step ceiling. The engine already knew each node's cost
    // (receipt.usage.costUsd) and already had a gate that stops new nodes from
    // starting (`halted`, below) — this is the edge between them. A nested
    // workflow:run child gets its OWN budget from its own execGraph call; see
    // run-budget.ts "Honest limits".
    const budget = new RunBudget(resolveRunBudget(params));

    const callbacks: ExecutionCallbacks = {
      onNodeStart: (nodeId, cid) => {
        if (!live(cid)) return;
        this.store.nodeStart(cid, nodeId);
        log("info", "workflow_node_start", { workflowId: graph.id, nodeId, correlationId: cid });
      },
      onNodeComplete: (nodeId, cid, result) => {
        if (!live(cid)) return;
        // Drain the captured receipt (set by toHandler auto-mint or agent:run self-enrich).
        const key = `${cid}:${nodeId}`;
        const receipt = this.pendingReceipts.get(key);
        this.pendingReceipts.delete(key);
        budget.record(receipt?.usage?.costUsd);
        // For workflow:run nodes, denormalize the child run's infer summary so the
        // audit answer survives child-run prune (MAX_FINISHED=50).
        let subRun: SubRunRollup | undefined;
        const nodeState = this.store.get(cid)?.nodes[nodeId];
        if (nodeState?.nodeType === "workflow:run") {
          const wfMeta = (result.result as Record<string, unknown> | undefined)
            ?.__wfMeta as { workflowId?: string; correlationId?: string; terminalNodeId?: string } | undefined;
          if (wfMeta?.correlationId) {
            const childRun = this.store.get(wfMeta.correlationId);
            if (childRun) {
              subRun = buildSubRunRollup(childRun, wfMeta.terminalNodeId);
            } else {
              subRun = {
                workflowId: wfMeta.workflowId ?? "",
                correlationId: wfMeta.correlationId,
                terminalNodeId: wfMeta.terminalNodeId,
                resolved: false,
                inferCount: 0,
                models: [],
              };
            }
          }
        }
        this.store.nodeComplete(cid, nodeId, result, receipt, subRun);
        log("info", "workflow_node_complete", {
          workflowId: graph.id, nodeId, correlationId: cid,
          durationMs: result.durationMs, status: result.status,
        });
      },
      onNodeAttemptFailed: (nodeId, cid, result) => {
        if (!live(cid)) return;
        // An attempt failed but WILL be retried (issue #654). The engine's timeout
        // races the handler but cannot stop it: kill THIS attempt's tracked exec
        // child now — before the retry records its own under the same per-node
        // slot, or two executions share one orphan record and the first close
        // clears the second's. Not store.nodeFailed: the node is not terminal,
        // its store state stays "running" until a final attempt settles.
        if (result.status === "timed_out") {
          this.killTrackedChildren(cid, "attempt_timed_out", nodeId);
        }
        const key = `${cid}:${nodeId}`;
        const receipt = this.pendingReceipts.get(key);
        this.pendingReceipts.delete(key);
        // The abandoned attempt still burned tokens — charge it here, or the
        // retry loop spends free (the next attempt's capture overwrites this
        // receipt slot).
        budget.record(receipt?.usage?.costUsd);
        log("warn", "workflow_node_attempt_failed", {
          workflowId: graph.id, nodeId, correlationId: cid,
          durationMs: result.durationMs, attempt: result.attempt,
          status: result.status, error: result.error,
        });
      },
      onNodeFailed: (nodeId, cid, result) => {
        if (!live(cid)) return;
        // Engine withTimeout races the handler but does NOT kill the child process.
        // agent:run (and any node that recorded an exec child) would otherwise leave
        // an orphan writing into the session file. Tree-kill on timed_out here.
        if (result.status === "timed_out") {
          this.killTrackedChildren(cid, "timed_out", nodeId);
        }
        const key = `${cid}:${nodeId}`;
        const receipt = this.pendingReceipts.get(key);
        this.pendingReceipts.delete(key);
        // A failed node still burned tokens — charge it, or a retry loop spends free.
        budget.record(receipt?.usage?.costUsd);
        this.store.nodeFailed(cid, nodeId, result, receipt);
        log("warn", "workflow_node_failed", {
          workflowId: graph.id, nodeId, correlationId: cid,
          durationMs: result.durationMs, status: result.status, error: result.error,
        });
      },
      onNodeSkipped: (nodeId, cid) => {
        if (!live(cid)) return;
        this.store.nodeSkipped(cid, nodeId);
        log("info", "workflow_node_skipped", { workflowId: graph.id, nodeId, correlationId: cid });
      },
    };

    try {
      const engineTrace = await execute(graph, params, this.registry, callbacks, {
        correlationId,
        priorResults,
        // Dispatch gate: once the run is cancelled or paused, no NEW node starts —
        // in-flight nodes drain (pause records their results; cancel additionally
        // aborts core:exec children via the signal). Ungated nodes stay unrecorded,
        // so a later resume re-runs exactly them.
        // A tripped budget halts dispatch on the SAME gate as cancel/pause: in-flight
        // nodes drain, no new node starts. Unstarted nodes stay unrecorded, so raising
        // the ceiling and resuming re-runs exactly them.
        halted: () => this.runControl.isCancelled(correlationId) || this.runControl.isPaused(correlationId) || budget.tripped,
      });
      // A cancel that landed while the engine ran wins: mark the run "cancelled"
      // (skipping any still-unfinished nodes) instead of the natural trace status.
      // A pause is next in precedence: park the run "paused" (markPaused finishes
      // it "completed" instead iff every node actually completed before the gate bit).
      if (this.runControl.isCancelled(correlationId)) {
        this.store.markCancelled(correlationId);
      } else if (this.runControl.isPaused(correlationId)) {
        this.store.markPaused(correlationId);
      } else if (budget.tripped) {
        // Budget stop ranks below operator intent (cancel/pause) and above the
        // natural status: the trace may read "completed" simply because the gate
        // stopped dispatch before anything could fail, which would be a lying
        // trace. `fail()` skips never-started nodes so a resume re-runs exactly
        // them — raise the ceiling, re-fire, completed nodes return cached.
        const s = budget.status();
        this.store.fail(correlationId, `Run budget exceeded — ${s.reason}`);
        log("warn", "workflow_budget_exceeded", {
          workflowId: graph.id,
          correlationId,
          reason: s.reason,
          nodes: s.nodes,
          maxNodes: budget.config.maxNodes,
          costUsd: Number(s.costUsd.toFixed(4)),
          maxCostUsd: budget.config.maxCostUsd,
        });
      } else {
        this.store.finish(correlationId, engineTrace.status);
      }
      // From here the trace is the WIDE view: the stamp below may overwrite the
      // engine's natural status with a control-state terminal.
      const trace: ExecutionTrace = engineTrace;
      // ── STAMP terminal control-state onto the returned trace (issue #655) ────
      // The engine computed trace.status purely from recorded results, and nodes
      // the halt gate stopped are absent from it — so a cancel/pause/budget stop
      // whose DISPATCHED nodes all completed reads "completed" here while the
      // store (settled above, by the same precedence) says cancelled/paused/failed.
      // The nested workflow:run node consumes exactly this trace and would surface
      // a half-run graph as legitimate success. The store is authoritative —
      // including markPaused's every-node-completed escape ("completed") — so read
      // the settled record back and reconcile. A non-terminal record cannot occur
      // here (every branch above terminated it; a deleted record reads undefined),
      // and no record leaves the trace untouched: nothing consumes a run whose
      // record is gone.
      const settled = this.store.get(correlationId);
      const s = settled?.status;
      if (s && s !== "running" && s !== trace.status) {
        log("info", "workflow_trace_status_stamped", {
          workflowId: graph.id,
          correlationId,
          engineStatus: trace.status,
          stampedStatus: s,
        });
        trace.status = s;
      }
      this.persistTrace(trace, "supervisor");

      // Post-stamp, trace.status IS the reconciled terminal verdict (the budget
      // branch stamps "failed", cancel/pause stamp through markCancelled/markPaused)
      // — no separate precedence mirror needed here.
      log(trace.status === "completed" ? "info" : "warn", "workflow_completed", {
        workflowId: graph.id,
        correlationId: trace.correlationId,
        status: trace.status,
        durationMs: trace.durationMs,
        nodeCount: trace.nodeResults.length,
        failed: trace.nodeResults.filter((r) => r.status === "failed" || r.status === "timed_out").map((r) => r.nodeId),
      });

      return trace;
    } finally {
      // Always stop tracking — even if execute() threw (a validate error), so the
      // registry never leaks an entry for a dead run.
      this.runControl.end(correlationId);
    }
  }

  /**
   * Cancel a running run. Aborts in-flight nodes (core:exec tree-kills its child and
   * resolves as a cancelled RESULT — not a hang), marks the run "cancelled" (skipping
   * the nodes that hadn't finished), and lets agent:notify sense the cancel so no
   * stale "finished" whisper fires. Throws for an unknown run (HTTP 404) or a run
   * that isn't running (HTTP 409).
   *
   * Scope: execGraph-based runs (inline / named / exec-notify / resume) cancel fully —
   * the child tree is killed and downstream is suppressed. Research/workflow LOOPS run
   * on a separate path (runResearchLoop) but are now run-control-tracked too: cancel
   * stops the loop at the NEXT iteration boundary and the status stays "cancelled"
   * (finish() won't overwrite it). The one residual: the CURRENT in-flight iteration's
   * round runs to completion, and any core:exec inside that round is not tree-killed
   * (the round executes under its own engine correlationId). See LIFECYCLE-FIXES-REPORT.md.
   */
  cancelRun(correlationId: string): { cancelled: boolean; status: string } {
    const run = this.store.get(correlationId);
    if (!run) throw new Error(`Unknown run: "${correlationId}"`);
    if (run.status !== "running") {
      throw new Error(`Run "${correlationId}" is not running (status: ${run.status}) — nothing to cancel`);
    }
    const aborted = this.runControl.cancel(correlationId);
    this.store.markCancelled(correlationId);
    // Defense-in-depth: AbortSignal covers cooperative nodes (core:exec, agent:run),
    // but also tree-kill any still-recorded exec children so a missed listener cannot
    // leave an orphan claude/grok writing after cancel (PR0 / e7256b3e).
    this.killTrackedChildren(correlationId, "cancelled");
    log("info", "workflow_cancelled", { correlationId, workflowId: run.workflowId, aborted });
    // Clear the pending notify so the eventual execGraph .then() doesn't fire
    // a zombie whisper hours later when the wrapper's timeout expires.
    this.pendingNotify.delete(correlationId);
    return { cancelled: true, status: "cancelled" };
  }

  /**
   * Tree-kill live exec children recorded on a run (core:exec + agent:run via
   * caps.run.recordChild → store.recordExecChild). Optional nodeId scopes to one
   * node (timeout path); omit to kill every recorded child on the run (cancel).
   */
  private killTrackedChildren(correlationId: string, reason: string, nodeId?: string): void {
    const run = this.store.get(correlationId);
    if (!run) return;
    const entries: Array<[string, { exec?: { pid: number; command: string } } | undefined]> = nodeId
      ? [[nodeId, run.nodes[nodeId]]]
      : Object.entries(run.nodes);
    for (const [nid, st] of entries) {
      const pid = st?.exec?.pid;
      if (!pid) continue;
      killTreeByPid(pid);
      log("warn", "workflow_child_tree_killed", {
        correlationId,
        nodeId: nid,
        pid,
        reason,
        command: (st!.exec!.command || "").slice(0, 120),
      });
      this.store.clearExecChild(correlationId, nid);
    }
  }

  /**
   * Pause a running run: stop dispatching new nodes, let in-flight nodes drain and
   * record (nothing is aborted — that's cancel). The run parks as "paused" once the
   * engine settles and resumes exactly like a failed/cancelled run does (POST
   * /workflow/resume — completed nodes carry forward, ungated nodes run). Any
   * notify attached to the run fires with the paused status when the drain settles,
   * so the caller learns their run parked instead of waiting on a whisper that
   * would otherwise only come after resume.
   */
  pauseRun(correlationId: string): { paused: boolean; status: string } {
    const run = this.store.get(correlationId);
    if (!run) throw new Error(`Unknown run: "${correlationId}"`);
    if (run.status !== "running") {
      throw new Error(`Run "${correlationId}" is not running (status: ${run.status}) — nothing to pause`);
    }
    const gated = this.runControl.pause(correlationId);
    this.store.markPaused(correlationId);
    log("info", "workflow_paused", { correlationId, workflowId: run.workflowId, gated });
    return { paused: true, status: "paused" };
  }

  /**
   * Report exec children abandoned by a previous supervisor instance — LOUDLY,
   * never killing them. The old sweep reaped these on the theory that an orphan
   * has nobody waiting on it; the sentinel design (core:exec writes its exit
   * code to a durable file) makes them ADOPTION CANDIDATES instead: a resume
   * completes the node from the sentinel, adopts the live child, or — only
   * when the outcome is genuinely lost — re-executes per the node's resume
   * policy. Killing a survivor here would destroy exactly the in-flight work
   * the design exists to preserve (a GPU job 40 minutes deep). Records stay on
   * the run for the resume path; explicit cancel/delete/timeout still reap.
   * Deferred off the constructor (setImmediate) so the blocking command-line
   * probes don't stall supervisor startup.
   */
  private sweepOrphanChildren(): void {
    const orphans: Array<{ correlationId: string; nodeId: string; pid: number; command: string }> = [];
    // COLLECTION IS GUARDED, and that is the point of this try — not defensive
    // habit. This runs as the LAST statement of the constructor, so anything it
    // throws propagates out of `new WorkflowRunner(...)`, and http-api's caller
    // then has no runner at all: every workflow in the supervisor disappears
    // because one run record was malformed. That is not hypothetical — a stray
    // `{"exitCode":0}` exec sentinel loaded as a run made Object.entries(null)
    // throw here and took the whole engine down (2026-08-05). The store now
    // gates its own records; this is the second wall, because an orphan sweep
    // is an OPTIONAL housekeeping pass and must never be able to cost the fleet
    // its workflow engine. Skipping it loudly beats dying silently.
    try {
      for (const run of this.store.list()) {
        for (const [nodeId, st] of Object.entries(run.nodes ?? {})) {
          if (st.exec?.pid) orphans.push({ correlationId: run.correlationId, nodeId, pid: st.exec.pid, command: st.exec.command });
        }
      }
    } catch (err) {
      log("warn", "workflow_orphan_sweep_skipped", {
        error: String(err),
        note: "malformed run record — orphan sweep skipped; the workflow engine is UNAFFECTED",
      });
      return;
    }
    if (orphans.length === 0) return;
    const MIN_SIG = 12;
    setImmediate(() => {
    for (const o of orphans) {
      try {
        const live = getProcessCommandLine(o.pid);
        const sig = o.command.trim();
        if (live && sig.length >= MIN_SIG && live.includes(sig)) {
          log("warn", "workflow_orphan_adoptable", { correlationId: o.correlationId, nodeId: o.nodeId, pid: o.pid, note: "child survived the restart — a resume of this run will adopt it, not re-execute" });
        } else {
          log("info", "workflow_orphan_terminal", {
            correlationId: o.correlationId,
            nodeId: o.nodeId,
            pid: o.pid,
            reason: !live ? "process_gone" : sig.length < MIN_SIG ? "command_too_generic" : "command_mismatch_pid_reuse",
          });
        }
      } catch (err) {
        log("warn", "workflow_orphan_probe_error", { pid: o.pid, error: String(err) });
      }
    }
    });
  }

  /** Live progress for one run (in-flight or finished), or undefined. */
  getRun(correlationId: string): WorkflowRunProgress | undefined {
    return this.store.get(correlationId);
  }

  /** All runs, most-recently-updated first. */
  listRuns(): WorkflowRunProgress[] {
    return this.store.list();
  }

  /** Live (tailed) output for one run-node — what core:exec has streamed so far
   *  ("" if none). Backs GET /workflow/run/:id/output?node=<id>. */
  getNodeOutput(correlationId: string, nodeId: string): string {
    return this.outputStore.get(correlationId, nodeId);
  }

  /** Node ids that have buffered live output for a run. */
  getOutputNodes(correlationId: string): string[] {
    return this.outputStore.nodes(correlationId);
  }

  /** Coverage summary for a run, or undefined if the ledger has no rows (unknown runKey). */
  getCoverageSummary(runKey: string): CoverageSummary | undefined {
    const rows = this.caps.ledgerRead(coverageLedgerName(runKey));
    if (rows.length === 0) return undefined;
    return reduceCoverage(rows);
  }

  /**
   * Start a multi-agent autoresearch loop in the BACKGROUND; returns its
   * correlationId immediately. The loop is recorded as one durable, watchable run
   * (iterations as nodes) and threads a disk ledger across rounds. Fire-and-forget
   * with a .catch so a thrown loop is recorded failed, never crashing the supervisor.
   */
  startResearchLoop(config: ResearchLoopConfig): string {
    const correlationId = makeCorrelationId();
    const loopGraph = buildLoopGraph(config);
    // Register the synthetic loop graph so the Runs view can render the iteration
    // chain (api.workflow(workflowId) resolves it). Keyed by config.id; repeated
    // runs of the same loop type reuse/refresh the entry.
    this.definitions.set(config.id, loopGraph);
    this.store.init(loopGraph, config.params || {}, correlationId);
    // Settle-notify wiring, mirroring startRun's pattern above: before this, the
    // loop path fired NO notify on any terminal (goal-contract spec §2, I6 —
    // silence is never a terminal state). cancelRun deletes the pending entry, so
    // the .then/.catch below skip firing for a cancelled loop — no zombie whisper.
    if (config.notify?.agent) this.pendingNotify.set(correlationId, config.notify);
    // Track the loop so cancelRun can flag it and the loop can stop between iterations
    // (loops don't run through execGraph). isCancelled lets it break; end() on settle.
    this.runControl.begin(correlationId, "async");
    void runResearchLoop({
      config, registry: this.registry, store: this.store, correlationId, dataDir: this.dataDir,
      isCancelled: () => this.runControl.isCancelled(correlationId),
      isPaused: () => this.runControl.isPaused(correlationId),
    })
      .then(() => {
        // goal-validation fold K6: stopReason is set on settle regardless of
        // notify — a partial research-loop settle means round(s) failed, and the
        // reason sidecar says so even though the 6-member status cannot.
        const settled = this.store.get(correlationId);
        if (settled?.status === "partial") this.store.setStopReason(correlationId, "round-failure");
        // If cancelRun already fired/cleared the notify, skip the duplicate.
        if (!this.pendingNotify.delete(correlationId)) return;
        return this.fireNotify(correlationId, config.notify);
      })
      .catch((err) => {
        const shouldNotify = this.pendingNotify.delete(correlationId);
        log("error", "research_loop_failed", { correlationId, id: config.id, error: String(err) });
        this.store.fail(correlationId, String(err));
        // goal-validation fold K6: stopReason was landed but unwired — a failed
        // loop settle records WHY, unambiguously (goal-contract §3.3 mapping).
        this.store.setStopReason(correlationId, "round-failure");
        if (shouldNotify) void this.fireNotify(correlationId, config.notify);
      })
      .finally(() => this.runControl.end(correlationId));
    log("info", "research_loop_started", { correlationId, id: config.id, maxIterations: config.maxIterations });
    return correlationId;
  }

  /**
   * Convenience: start the built-in generic "debate-refine" loop (propose A →
   * critique B → judge C) over a question. Agents are REQUIRED and explicit — we
   * deliberately do NOT default to fleet members like `claude`/`dr-claude`:
   * agent:ask injects the prompt into that agent's live session, so a silent
   * default would commandeer (and queue-flood) your primary/busy agents. Name
   * idle, dedicated worker agents.
   */
  startDebateRefine(opts: {
    question: string;
    agents?: { propose?: string; critique?: string; judge?: string };
    maxIterations?: number;
    noImproveStop?: number;
  }): string {
    if (!opts.question || !opts.question.trim()) throw new Error("startDebateRefine requires a non-empty 'question'");
    const a = opts.agents;
    if (!a?.propose || !a?.critique || !a?.judge) {
      throw new Error("debate-refine requires explicit agents { propose, critique, judge } — name IDLE worker agents, not your primary/busy sessions (sending injects the prompt into that agent's live queue)");
    }
    const agents = { propose: a.propose, critique: a.critique, judge: a.judge };
    const config: ResearchLoopConfig = {
      id: "research-loop:debate-refine",
      name: "Debate-refine research loop",
      round: buildDebateRefineRound(agents),
      metricFrom: "judge",
      answerFrom: "propose",
      maxIterations: opts.maxIterations ?? 8,
      higherIsBetter: true,
      noImproveStop: opts.noImproveStop,
      params: { question: opts.question },
    };
    return this.startResearchLoop(config);
  }

  /**
   * The plain "run 5 full tests" loop: run an existing workflow definition N times
   * and record each run, watchable as one loop. No metric/ratchet — just a counter
   * around the whole workflow. (Supply a metricFrom via startResearchLoop instead
   * to turn it into an optimizing autoresearch loop.)
   */
  startWorkflowLoop(workflowId: string, times: number, params?: Record<string, unknown>): string {
    const def = this.definitions.get(workflowId);
    if (!def) throw new Error(`Unknown workflow: "${workflowId}"`);
    const n = Math.max(1, Math.min(Math.floor(times) || 1, 100)); // sane bound
    const config: ResearchLoopConfig = {
      id: `workflow-loop:${workflowId}`,
      name: `${def.name} ×${n}`,
      round: def,
      maxIterations: n,
      params: params || {},
      // no metricFrom → a plain counted run, not an optimizing loop
    };
    return this.startResearchLoop(config);
  }

  /** The Definitions tab: BLUEPRINTS only (file-backed + genome-beat). Inline /
   *  per-run synthetic graphs live in `definitions` (resolvable for the Runs view)
   *  but are deliberately excluded here so one-off runs don't clutter the list. */
  list(): Array<{ id: string; name: string; description: string }> {
    return [...this.definitions.values()]
      .filter(g => this.blueprintIds.has(g.id))
      .map(g => ({ id: g.id, name: g.name, description: g.description }));
  }

  /** List blueprints organized by family — a two-level tree for navigation. Each
   *  family contains its workflows; definitions not in the taxonomy go into "other". */
  listTree(): Array<{
    family: string;
    name: string;
    description: string;
    count: number;
    workflows: Array<{ id: string; name: string; description: string }>;
  }> {
    // Load the families taxonomy, with graceful fallback if missing/unparseable.
    let familiesData: Record<string, {
      name: string;
      description: string;
      workflows: string[];
    }> = {};
    try {
      const taxonomyPath = resolve(__dirname, "families.json");
      if (existsSync(taxonomyPath)) {
        const raw = readFileSync(taxonomyPath, "utf-8");
        const parsed = JSON.parse(raw) as { families?: unknown };
        if (parsed.families && typeof parsed.families === "object") {
          familiesData = parsed.families as typeof familiesData;
        }
      }
    } catch {
      // If families.json is missing or unparseable, fall back to "other" family.
      // This is intentional and not logged — the fallback is load-bearing and silent.
    }

    // Collect all blueprints grouped by family.
    const blueprints = [...this.definitions.values()]
      .filter(g => this.blueprintIds.has(g.id));
    const familyMap = new Map<string, Array<{ id: string; name: string; description: string }>>();
    const seen = new Set<string>();

    // Populate families from the taxonomy in order.
    for (const [familyKey, familyDef] of Object.entries(familiesData)) {
      const workflows: Array<{ id: string; name: string; description: string }> = [];
      for (const workflowId of familyDef.workflows) {
        const graph = this.definitions.get(workflowId);
        if (graph && this.blueprintIds.has(workflowId)) {
          workflows.push({ id: graph.id, name: graph.name, description: graph.description });
          seen.add(workflowId);
        }
      }
      if (workflows.length > 0) {
        familyMap.set(familyKey, workflows);
      }
    }

    // Collect any workflows not in the taxonomy into "other".
    const other: Array<{ id: string; name: string; description: string }> = [];
    for (const graph of blueprints) {
      if (!seen.has(graph.id)) {
        other.push({ id: graph.id, name: graph.name, description: graph.description });
      }
    }

    // Build the result, preserving family order from the taxonomy.
    const result: Array<{
      family: string;
      name: string;
      description: string;
      count: number;
      workflows: Array<{ id: string; name: string; description: string }>;
    }> = [];

    for (const [familyKey, familyDef] of Object.entries(familiesData)) {
      const workflows = familyMap.get(familyKey) || [];
      if (workflows.length > 0) {
        result.push({
          family: familyKey,
          name: familyDef.name,
          description: familyDef.description,
          count: workflows.length,
          workflows,
        });
      }
    }

    // Append "other" if there are unclassified workflows.
    if (other.length > 0) {
      result.push({
        family: "other",
        name: "Other",
        description: "Workflows not yet classified into a family.",
        count: other.length,
        workflows: other,
      });
    }

    return result;
  }

  /** The node-preset kit plus how the loaded blueprints actually use it — the
   *  panel's review surface. Computed from the definitions already in memory, so
   *  it never triggers a definition re-scan; the summary itself is a pure fn in
   *  node-presets.ts and is unit-tested there. */
  listNodePresetKit(): PresetAdoption {
    const graphs = [...this.definitions.values()].filter(g => this.blueprintIds.has(g.id));
    return summarizePresetAdoption(graphs);
  }

  /** Delete a run (in-memory + persisted file + its live-output buffer). REFUSES a
   *  RUNNING run — deleting the record would orphan the process it tracks (the old
   *  silent-orphan bug). Throws so the HTTP layer returns 409 with a pointer to
   *  cancel first. Finished/failed/cancelled runs delete freely. */
  deleteRun(correlationId: string): boolean {
    const run = this.store.get(correlationId);
    if (run && run.status === "running") {
      throw new Error(
        `Run "${correlationId}" is still running — cancel it first (POST /workflow/run/${correlationId}/cancel) before deleting`,
      );
    }
    this.outputStore.clear(correlationId);
    return this.store.delete(correlationId);
  }

  /** Bulk declutter: delete every finished (non-running) run + its live-output
   *  buffer. Running workflows are always kept. Returns the deleted ids. */
  deleteFinishedRuns(): string[] {
    const ids: string[] = [];
    for (const r of this.store.list()) {
      // Paused runs are parked work an operator intends to resume — not clutter.
      if (r.status === "running" || r.status === "paused") continue;
      this.outputStore.clear(r.correlationId);
      if (this.store.delete(r.correlationId)) ids.push(r.correlationId);
    }
    log("info", "workflow_runs_cleared", { deleted: ids.length });
    return ids;
  }

  /** Delete a definition. A file-backed blueprint also has its JSON file removed
   *  (a change on the shared repo tree); ephemeral/inline graphs are just dropped
   *  from the map. Returns what happened. */
  deleteDefinition(id: string): { deleted: boolean; fileRemoved: boolean } {
    const deleted = this.definitions.delete(id);
    this.blueprintIds.delete(id);
    let fileRemoved = false;
    const file = this.blueprintFiles.get(id);
    if (file && existsSync(file)) {
      try { unlinkSync(file); fileRemoved = true; }
      catch (err) { log("warn", "workflow_definition_delete_file_failed", { id, file, error: String(err) }); }
    }
    this.blueprintFiles.delete(id);
    log("info", "workflow_definition_deleted", { id, deleted, fileRemoved });
    return { deleted, fileRemoved };
  }

  describe(workflowId: string): TaskGraph | undefined {
    return this.definitions.get(workflowId);
  }

  // ── Presets ──────────────────────────────────────────────
  // A preset is a saved, named, pre-filled instance of a blueprint (the REFERENCE
  // model): {name, blueprintId, params}. Running one is startNamed(blueprintId,
  // params). Presets are machine-local (gitignored data/), separate from the
  // file-backed blueprints in the Definitions tab.

  /** All presets, each annotated with whether its referenced blueprint still
   * exists — so the UI can grey out / disable orphans (blueprint was deleted). */
  listPresets(): Array<WorkflowPreset & { blueprintExists: boolean }> {
    return this.presetStore.list().map(p => ({ ...p, blueprintExists: this.blueprintIds.has(p.blueprintId) }));
  }

  /** Create or update a preset. Validates the blueprint exists (you can't save a
   * preset against a non-existent blueprint — that would orphan on creation). */
  savePreset(input: { id?: string; name: string; blueprintId: string; params: Record<string, unknown> }): WorkflowPreset {
    if (!input.name?.trim()) throw new Error("Preset requires a name");
    if (!this.blueprintIds.has(input.blueprintId)) throw new Error(`Unknown blueprint: "${input.blueprintId}"`);
    return this.presetStore.save({ ...input, name: input.name.trim() });
  }

  deletePreset(id: string): boolean {
    return this.presetStore.delete(id);
  }

  /** Run a preset by id: resolve its saved blueprint + params and start a normal
   * named run. Returns the correlationId. Throws a clear error if the preset is
   * unknown or its blueprint has since been deleted (an orphan can't run). */
  async runPreset(id: string): Promise<string> {
    const preset = this.presetStore.get(id);
    if (!preset) throw new Error(`Unknown preset: "${id}"`);
    if (!this.blueprintIds.has(preset.blueprintId)) {
      throw new Error(`Preset "${preset.name}" references missing blueprint "${preset.blueprintId}"`);
    }
    return this.startNamed(preset.blueprintId, preset.params);
  }

  getRegistry(): NodeRegistry {
    return this.registry;
  }

  private persistTrace(trace: ExecutionTrace, source: string): void {
    fetch(`${MEMORY_MCP_URL}/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace, source }),
      signal: AbortSignal.timeout(5_000),
    }).catch(err => {
      log("warn", "workflow_trace_persist_failed", { correlationId: trace.correlationId, error: String(err) });
    });
  }
}
