/**
 * Workflow-node communication contract.
 *
 * A DAG node is a function with an I/O contract — NOT a cartridge. This module is
 * the shared shape every node speaks so outputs chain into inputs without bespoke
 * glue (see ./README.md). Four rules, each enforced here:
 *   - inputs:  one typed accessor (str/num/bool/obj) over the interpolated params,
 *              with honest errors instead of scattered casts.
 *   - output:  every node returns a plain object, so a downstream node can always
 *              read {{nodes.<id>.result.<field>}}. Enforced by toHandler.
 *   - errors:  throw a clear Error; the engine records it as the node's failure.
 *   - caps:    supervisor powers are injected once via NodeCaps — a node never
 *              re-imports ContainerManager / the send handler.
 *
 * Pure: imports only task-graph TYPES, so contract + pure nodes unit-test with no
 * supervisor. Could graduate to dependencies/ verbatim if other cartridges ever
 * author nodes.
 */
import type { ExecutionContext, NodeHandler, NodeExecMeta, TaskGraph, ExecutionTrace } from "@agentruntime/task-graph";
import type { ConventionBundle } from "../conventions/types.js";
import {
  classifyKind,
  buildInferReceipt,
  buildFailureReceipt,
  type InferenceReceipt,
  type EpistemicKindResolved,
} from "../epistemics.js";

// ── Sense signal ─────────────────────────────────────────────────────────────

/** A snapshot of a fleet agent — the watchdog's read step. `isProcessing` and
 *  `messagesHandled` are load-bearing: never act on a BUSY agent, and compare
 *  `messagesHandled` tick-to-tick to tell a STUCK agent from a merely SLOW one. */
export interface AgentState {
  name: string;
  /** "running" | "stopped" | "crashed" | … (Container.status). */
  status: string;
  /** true while the agent is mid-turn — NEVER whisper/poke a busy agent. */
  isProcessing: boolean;
  /** Monotonic count of messages the agent has handled — the progress signal. */
  messagesHandled: number;
  uptimeMs: number;
}

/** onSend resolves with a queue ACK (not a real reply) when the target is busy.
 *  Treat these as a busy signal, never as content (Honest Response). */
export function isQueueAck(reply: string): boolean {
  return /^Queued \(position \d+\)/.test(reply) || /^Queue full for /.test(reply);
}

// ── Capabilities (injected once at registration) ─────────────────────────────

/** Supervisor lifecycle ops — the powers the migrated supervisor:* nodes need.
 *  Grouped under their own namespace because they are inherently coupled to the
 *  container runtime (unlike whisper/agentState, which a node could mock freely). */
export interface SupervisorCaps {
  /** Cancel the target's in-flight request. Throws if the container is unknown. */
  cancel(name: string): { cancelled: boolean };
  /** Reset the target's conversation (optionally preserving an artifact). */
  resetConversation(name: string, hasArtifact: boolean): { ok: boolean; previousSession: string | null };
  /** Clear the target's persisted session file (no-op if no handler is wired). */
  clearSessionFile(name: string): { ok: boolean };
  /** Flush container stats to disk. */
  flushStats(): { ok: boolean };
  /** Send WITHOUT awaiting a reply — `sent:true` means ENQUEUED, not read or
   *  answered (false + reason when the target is not running). Unlike whisper(),
   *  does NOT await the recipient's turn and does NOT reject a busy/queue-ack. */
  send(name: string, message: string): Promise<{ sent: boolean; reason?: string }>;
  /** Start a container. */
  start(name: string): Promise<{ ok: boolean; result: unknown }>;
  /** Stop a container. */
  stop(name: string): Promise<{ ok: boolean; result: unknown }>;
}

// ── Run-level control (cancellation + run mode) ──────────────────────────────

/** How a run was launched. SYNC callers (inline `POST /workflow`, chrono) read the
 *  full trace back inline; ASYNC callers watch progress via the run-store + bus. */
export type RunMode = "sync" | "async";

/** The slice of run control a NODE sees via `caps.run`. The task-graph engine has no
 *  cancellation surface and can't tell a node its run mode; this facade supplies both,
 *  keyed by correlationId. Read-only sensing (mode/signal/isCancelled) plus child
 *  bookkeeping (record/clear) that the runner persists to the run-store for the
 *  restart-orphan sweep. A null-object impl (NOOP_RUN_CONTROL) covers no-runner tests,
 *  so nodes call these unconditionally. */
export interface RunControlCaps {
  /** "sync" | "async" for a live run, or undefined once ended / never tracked. */
  mode(correlationId: string): RunMode | undefined;
  /** The run's abort signal (fires on cancel), or undefined if not tracked. */
  signal(correlationId: string): AbortSignal | undefined;
  /** True once the run has been cancelled (and is still tracked). */
  isCancelled(correlationId: string): boolean;
  /** Record a node's spawned child (pid + originating command) so a supervisor
   *  restart can ADOPT it on resume (PID-reuse-safe). Persisted via the run-store. */
  recordChild(correlationId: string, nodeId: string, pid: number, command: string): void;
  /** Drop a node's child record once it has exited (clean or killed). */
  clearChild(correlationId: string, nodeId: string): void;
  /** The child a previous engine recorded for this node, if any — the resume
   *  path's adoption candidate (undefined outside the engine). */
  recordedChild(correlationId: string, nodeId: string): { pid: number; command: string } | undefined;
  /** Directory for per-node exec state (wrapper script + exit sentinel), or
   *  undefined outside the engine. The sentinel is what makes an exec outcome
   *  durable across a supervisor death. */
  execStateDir(): string | undefined;
}

/**
 * Narrow slice of WorkflowRunner a `workflow:run` node needs to invoke another
 * workflow as a nested sub-run. Mirrors the RunControlCaps pattern: interface
 * here (type-only), concrete closure built in runner.ts's constructor (over its
 * private `invokeNested`), wired through registerNodes/buildCaps. Depth
 * management is NOT part of this surface — it's an implementation detail of
 * `invokeNested`, keyed off `callerCorrelationId` via RunControlRegistry, so no
 * graph param or external caller can influence nesting depth.
 */
export interface WorkflowInvoker {
  /** Run a named (definitions-map) workflow as a nested sub-run; resolves with
   *  its full ExecutionTrace once it settles. `callerCorrelationId` is THIS
   *  node's own run id — used to look up the caller's depth and increment it. */
  run(workflowId: string, params: Record<string, unknown>, callerCorrelationId: string): Promise<ExecutionTrace>;
  /** Run an inline TaskGraph as a nested sub-run (same depth-guard semantics as `run`). */
  runGraph(graph: TaskGraph, params: Record<string, unknown>, callerCorrelationId: string): Promise<ExecutionTrace>;
  /** Resolve a named workflow's definition without running it (pre-flight
   *  terminal-node derivation for `workflow:run`'s named-workflow path). */
  describe(workflowId: string): TaskGraph | undefined;
}

/** Resolve the house conventions bundle applicable to a given worker cwd.
 *  `taskText` is provided for future skill-selection heuristics but is currently
 *  unused by the resolver. Returns a bundle with `empty: true` when there are no
 *  useful conventions to inject (e.g., unknown cwd, no referenced skill files). */
export interface ConventionCaps {
  resolve(cwd: string, taskText: string): Promise<ConventionBundle>;
}

/** Resolve promoted experience-memory corrections for a prospective dispatch and
 *  return the formatted preamble plus honest metadata. The signature is the
 *  FORWARD key (design B1): taskFamily, dual-namespace-canonicalized packageDir,
 *  HARD {runtime,model} executor, and the raw task prompt as lexical sketch.
 *  `empty: true` means "no promoted experience matched" — retrieval ran and is
 *  healthy (never padded); failures return empty with a warning logged, mirroring
 *  the conventions cap. The caller injects `preamble` only when `empty` is false. */
export interface CorrectionsResult {
  preamble: string;
  empty: boolean;
  matchMode: "embedding" | "lexical" | "none";
  count: number;
}
export interface CorrectionsCaps {
  resolve(sig: {
    taskFamily: string;
    packageDir: string;
    runtime: string;
    model: string;
    promptSketch: string;
  }): Promise<CorrectionsResult>;
}
/** Null-object for contexts with no EM store wired (unit tests): honest empty. */
export const NOOP_CORRECTIONS_CAPS: CorrectionsCaps = {
  resolve: async () => ({ preamble: "", empty: true, matchMode: "none", count: 0 }),
};

/** Receipt capture channel — written by toHandler auto-mint (generic floor) and
 *  by agent:run self-enrich (rich upgrade). Drained into the run-store's single
 *  nodeComplete write by the runner's pendingReceipts map. A null object
 *  (NOOP_RECEIPT_CAPS) is wired when no runner is present (unit tests). */
export interface ReceiptCaps {
  /** Write a receipt for an infer node.
   *  fillOnly=true: write only if no receipt is already captured (lets a rich
   *  self-capture from agent:run survive the subsequent generic auto-mint). */
  capture(
    correlationId: string,
    nodeId: string,
    receipt: InferenceReceipt,
    opts?: { fillOnly?: boolean },
  ): void;
  /** Read this run's settled node states — the receipts written by `capture` and
   *  drained at nodeComplete, plus each node's kind.
   *
   *  Exists for DETERMINISTIC FAN-IN nodes that must report the independence of what
   *  they joined (core:merge). Safe to call from a node body: the engine fires
   *  onNodeComplete synchronously before dispatching downstream nodes
   *  (dependencies/task-graph/src/execute.ts), and the store is write-through, so
   *  every upstream node's receipt is already durable when a fan-in runs.
   *
   *  Returns undefined when no runner is wired (unit tests) or the run is unknown —
   *  callers must OMIT their independence field rather than report zeros, so
   *  "not measured" stays distinguishable from "measured, and it is zero". */
  runNodes(correlationId: string): Record<string, EpistemicsNodeView> | undefined;
}

/** The slice of a node's persisted state that independence accounting reads.
 *  Structurally satisfied by LiveNodeState. */
export interface EpistemicsNodeView {
  kind?: EpistemicKindResolved;
  nodeType?: string;
  receipt?: InferenceReceipt;
}

/** Null-object WorkflowInvoker for contexts with no runner wired (unit tests). Every
 *  method throws/no-ops so a `workflow:run` node called outside a real WorkflowRunner
 *  fails loudly instead of silently no-op-ing. */
export const NOOP_WORKFLOW_INVOKER: WorkflowInvoker = {
  run: async () => { throw new Error("workflow:run: no WorkflowRunner wired (unit-test context)"); },
  runGraph: async () => { throw new Error("workflow:run: no WorkflowRunner wired (unit-test context)"); },
  describe: () => undefined,
};

export interface NodeCaps {
  /** Send a message to a fleet agent; resolves with its reply (or a queue ACK if
   *  busy — callers should sense first, or use agent:whisper which rejects ACKs).
   *  AWAITS the recipient — do NOT use for fire-and-forget notifications (it times
   *  out the node when the recipient is busy); use notify() for those. */
  whisper(agent: string, message: string): Promise<string>;
  /** Deliver a message into an agent's conversation FIRE-AND-FORGET: dispatch and
   *  return immediately, WITHOUT awaiting the recipient reading/replying. This is
   *  the correct primitive for a result/notification whisper. */
  notify(agent: string, message: string): { dispatched: boolean; reason?: string };
  /** Sense an agent's live state, or undefined if there is no such container. */
  agentState(agent: string): AgentState | undefined;
  /** Append a row (auto-stamped with `ts`) to a named JSONL ledger under
   *  data/node-ledgers/. Returns the new total row count. Disk-as-memory. */
  ledgerAppend(ledger: string, row: Record<string, unknown>): number;
  /** Read a named ledger's rows (oldest first); [] if it does not exist yet. */
  ledgerRead(ledger: string): Array<Record<string, unknown>>;
  /** Structured log to the supervisor logger (also broadcast on the bus). */
  log(level: string, event: string, data?: Record<string, unknown>): void;
  /** Append a chunk to a run-node's LIVE output buffer (tailed by the dashboard
   *  while the node runs). For long shell/exec nodes whose output you want to
   *  watch live rather than only at completion. No-op if no output store is wired. */
  streamOutput(correlationId: string, nodeId: string, chunk: string): void;
  /** Declare that this run-node writes its output to `path` (the command redirects
   *  there itself, e.g. a core:exec doing `… > run.log 2>&1`, so the pipe we capture
   *  is empty). The dashboard tails that file live when there's no streamed buffer.
   *  No-op if no output store is wired. */
  registerOutputFile(correlationId: string, nodeId: string, path: string): void;
  /** Container lifecycle ops (for the migrated supervisor:* nodes). */
  supervisor: SupervisorCaps;
  /** Run-level control the engine can't express: cancellation signal + run mode +
   *  child-process bookkeeping. A null object when no runner is wired (unit tests),
   *  so nodes call `caps.run.*` unconditionally. */
  run: RunControlCaps;
  /** Invoke another workflow (named or inline) as a nested sub-run — the
   *  `workflow:run` node's DAG-of-DAGs primitive. A null object when no runner is
   *  wired (unit tests), so nodes call `caps.workflow.*` unconditionally. */
  workflow: WorkflowInvoker;
  /** Resolve house conventions (CLAUDE.md + skill docs) for a worker cwd and
   *  format a preamble to prepend to the agent prompt. Always returns a bundle;
   *  callers check `bundle.empty` before injecting. */
  conventions: ConventionCaps;
  /** Resolve promoted experience-memory corrections (the EM seam) for the
   *  dispatch's prospective signature. Honest-empty when nothing promoted
   *  applies; never throws. Null-object when no store is wired (unit tests). */
  corrections: CorrectionsCaps;
  /** Epistemic receipt capture — auto-minted by toHandler for every infer node;
   *  optionally upgraded by agent:run with the assembled-prompt hash + conventions.
   *  A null object when no runner is wired (unit tests). */
  receipt: ReceiptCaps;
}

// ── Typed input accessor ─────────────────────────────────────────────────────

export interface StrOpts { default?: string; required?: boolean }
export interface NumOpts { default?: number; required?: boolean; min?: number; max?: number }
export interface BoolOpts { default?: boolean }
export interface ObjOpts<T> { default?: T; required?: boolean }

export interface Inputs {
  /** Coerce to a non-empty string. Absent → default ?? "" (or throw if required). */
  str(key: string, opts?: StrOpts): string;
  /** Coerce to a finite number (clamped to min/max). Non-numeric → throws. */
  num(key: string, opts?: NumOpts): number;
  /** Coerce to a boolean. Accepts real booleans and the strings "true"/"false"/"1"/"0". */
  bool(key: string, opts?: BoolOpts): boolean;
  /** Read an object input (e.g. a config blob). Non-object → throws. */
  obj<T = Record<string, unknown>>(key: string, opts?: ObjOpts<T>): T;
  /** True iff the key is present and non-null. */
  has(key: string): boolean;
  /** Raw escape hatch — the un-coerced value. */
  raw(key: string): unknown;
}

function clampNum(n: number, o: NumOpts): number {
  let r = n;
  if (o.min !== undefined) r = Math.max(o.min, r);
  if (o.max !== undefined) r = Math.min(o.max, r);
  return r;
}

function makeInputs(type: string, params: Record<string, unknown>): Inputs {
  const fail = (key: string, why: string): never => {
    throw new Error(`${type}: input "${key}" ${why}`);
  };
  const absent = (v: unknown): boolean => v === undefined || v === null || v === "";
  return {
    has: (k) => params[k] !== undefined && params[k] !== null,
    raw: (k) => params[k],

    str: (k, o = {}) => {
      const v = params[k];
      if (absent(v)) return o.required ? fail(k, "is required (non-empty string)") : (o.default ?? "");
      return String(v);
    },

    num: (k, o = {}) => {
      const v = params[k];
      if (absent(v)) {
        if (o.required) return fail(k, "is required (number)");
        return clampNum(o.default ?? 0, o);
      }
      const n = Number(v);
      if (Number.isNaN(n)) return fail(k, `must be a number (got ${JSON.stringify(v)})`);
      return clampNum(n, o);
    },

    bool: (k, o = {}) => {
      const v = params[k];
      if (absent(v)) return o.default ?? false;
      if (typeof v === "boolean") return v;
      const s = String(v).toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      return Boolean(v);
    },

    obj: <T = Record<string, unknown>>(k: string, o: ObjOpts<T> = {}) => {
      const v = params[k];
      if (absent(v)) {
        if (o.required) return fail(k, "is required (object)") as T;
        return (o.default ?? ({} as T));
      }
      if (typeof v !== "object" || Array.isArray(v)) return fail(k, "must be an object") as T;
      return v as T;
    },
  };
}

// ── Node authoring ───────────────────────────────────────────────────────────

export interface NodeContext {
  /** Typed, honest-erroring accessor over this node's interpolated params. */
  inputs: Inputs;
  /** Prior nodes' results, for direct reads (params interpolation also works). */
  nodes: ExecutionContext["nodes"];
  /** Injected supervisor capabilities. */
  caps: NodeCaps;
  /** Raw interpolated params — escape hatch; prefer `inputs`. */
  params: Record<string, unknown>;
  /** This run's id and this node's id (from the engine), for tagging live output
   *  via caps.streamOutput. Undefined only if invoked outside the engine. */
  correlationId?: string;
  nodeId?: string;
}

export interface NodeDef {
  /** The node `type` string used in a graph definition (e.g. "agent:state"). */
  type: string;
  /** One-line description (surfaced to authors; not used at runtime). */
  description?: string;
  /** The node body. MUST resolve to a plain object (enforced by toHandler). */
  run(ctx: NodeContext): Promise<Record<string, unknown>>;
}

/** Identity helper — gives a node literal its `NodeDef` type + editor help. */
export function defineNode(def: NodeDef): NodeDef {
  return def;
}

/** Compile a NodeDef + injected caps into the engine's NodeHandler, enforcing the
 *  plain-object-result rule so downstream `{{nodes.id.result.field}}` always
 *  resolves. Wraps run() in try/catch to auto-mint InferenceReceipts for every
 *  infer node (success and failure), using fillOnly so a richer self-capture from
 *  agent:run survives the subsequent generic mint. */
export function toHandler(def: NodeDef, caps: NodeCaps): NodeHandler {
  return async (params: Record<string, unknown>, ctx: ExecutionContext, meta?: NodeExecMeta) => {
    const cid = meta?.correlationId;
    const nodeId = meta?.nodeId;
    const isInfer = classifyKind(def.type) === "infer";
    let ranSuccessfully = false;
    try {
      const result = await def.run({
        inputs: makeInputs(def.type, params),
        nodes: ctx.nodes,
        caps,
        params,
        correlationId: cid,
        nodeId,
      });
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        const got = result === null ? "null" : Array.isArray(result) ? "array" : typeof result;
        throw new Error(
          `${def.type}: a node must return a plain object so {{nodes.id.result.field}} resolves — got ${got}. Wrap lists/scalars, e.g. { items: [...] }.`,
        );
      }
      ranSuccessfully = true;
      // Generic auto-mint (floor): fillOnly=true so a rich agent:run self-capture wins.
      if (isInfer && cid && nodeId) {
        const receipt = buildInferReceipt(
          def.type, nodeId, params, result as Record<string, unknown>, Date.now(),
        );
        caps.receipt.capture(cid, nodeId, receipt, { fillOnly: true });
      }
      return result;
    } catch (e) {
      // Failure receipt: only for genuine infer-node failures, not plain-object type errors.
      if (!ranSuccessfully && isInfer && cid && nodeId) {
        const failReceipt = buildFailureReceipt(def.type, nodeId, params, e, Date.now());
        caps.receipt.capture(cid, nodeId, failReceipt);
      }
      throw e;
    }
  };
}

/** Minimal registry surface — structurally satisfied by task-graph's NodeRegistry. */
export interface HandlerRegistry {
  register(type: string, handler: NodeHandler): void;
}

/** Register a set of NodeDefs against a registry with the given caps. */
export function registerNodeDefs(registry: HandlerRegistry, defs: NodeDef[], caps: NodeCaps): void {
  for (const def of defs) registry.register(def.type, toHandler(def, caps));
}
