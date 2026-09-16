import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  validate,
  executeValidated,
  type TaskGraph,
  type NodeRegistry,
  type ExecutionTrace,
} from "@agentruntime/task-graph";
import type { WorkflowRunStore } from "./run-store.js";
import { log } from "../logger.js";

/**
 * Config for one research loop. The `round` is a normal task-graph executed once
 * per iteration; its nodes are the multiple-agent interactions (agent:ask nodes).
 * The loop reads `metricFrom`'s `result.metric` to ratchet, and stashes
 * `answerFrom`'s `result` as the best-known artifact.
 */
export interface ResearchLoopConfig {
  /** Stable workflowId for the loop run (e.g. "research-loop:debate-refine"). */
  id: string;
  name: string;
  /** The per-iteration DAG — a multi-agent round, or any full workflow you want
   * run N times. */
  round: TaskGraph;
  /** Node id in `round` whose result.metric (number) is the score to ratchet on.
   * OMIT for a plain "run the whole thing N times" loop — no ratchet, no best;
   * every iteration just runs + records its result. Supplying it turns the same
   * loop into an optimizing autoresearch loop. */
  metricFrom?: string;
  /** Node id whose result is stored as the best-known artifact (default = metricFrom). */
  answerFrom?: string;
  /** Bound by COUNT — research_via's one rule (a headless loop can't self-time). */
  maxIterations: number;
  /** Higher metric is better (default true). */
  higherIsBetter?: boolean;
  /** Stop early after this many iterations with no improvement (optional). */
  noImproveStop?: number;
  /** Static params merged into every round (e.g. the question). */
  params?: Record<string, unknown>;
  /** Optional settle callback: the runner whispers this agent when the loop
   *  settles — completed AND failed (goal-contract migration step 2: the loop
   *  path fired NO notify on any terminal before this; silence is never a
   *  terminal state). Structural twin of the runner's WorkflowNotify, declared
   *  inline because runner.ts already imports THIS file — importing the type
   *  back would close an import cycle. */
  notify?: { agent: string; message?: string; condense?: boolean };
}

interface LedgerRow {
  iteration: number;
  metric: number | null;
  kept: boolean;
  at: number;
  error?: string;
}

interface BestRecord {
  iteration: number;
  metric: number;
  answer: unknown;
}

const pad = (i: number) => String(i).padStart(2, "0");
export const iterNodeId = (i: number) => `iter-${pad(i)}`;

/**
 * The loop is recorded as ONE WorkflowRunStore run whose nodes are the iterations
 * (iter-01 -> iter-02 -> ...), so it renders + lives in the existing Runs view
 * with zero new dashboard code. The per-iteration multi-agent detail lives in
 * each node's result + the on-disk ledger.
 */
export function buildLoopGraph(config: ResearchLoopConfig): TaskGraph {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= config.maxIterations; i++) {
    nodes.push({
      id: iterNodeId(i),
      type: "research:iteration",
      params: {},
      meta: { description: `Iteration ${i}: one ${config.round.name || "round"} (propose → critique → judge), ratcheted on the ledger.` },
    });
    if (i > 1) edges.push({ from: iterNodeId(i - 1), to: iterNodeId(i) });
  }
  return { id: config.id, name: config.name, description: `Autoresearch loop — up to ${config.maxIterations} multi-agent rounds, ratcheted on a disk ledger.`, nodes, edges };
}

/** Last `n` ledger rows as compact JSON (the disk-as-memory fed into the next round). */
function tailLedger(logPath: string, n: number): LedgerRow[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l) as LedgerRow; } catch { return null; } }).filter((r): r is LedgerRow => r !== null);
}

function numericMetric(trace: ExecutionTrace, nodeId: string): number | null {
  const r = trace.nodeResults.find(x => x.nodeId === nodeId);
  const m = (r?.result as { metric?: unknown } | undefined)?.metric;
  return typeof m === "number" && Number.isFinite(m) ? m : null;
}

/**
 * Run a research loop to completion (bounded by maxIterations). The caller mints
 * the correlationId, seeds the store with buildLoopGraph(), and fires this
 * un-awaited (it's a long background run). Each iteration runs the round, ratchets
 * the metric on the disk ledger, and records its result into the store node.
 */
export async function runResearchLoop(opts: {
  config: ResearchLoopConfig;
  registry: NodeRegistry;
  store: WorkflowRunStore;
  correlationId: string;
  dataDir: string;
  /** Cooperative cancel: checked between iterations. When it returns true the loop
   *  stops (cancelRun has already marked the run "cancelled" + skipped the remaining
   *  iteration nodes) — we do NOT run the final finish() so the status stays cancelled. */
  isCancelled?: () => boolean;
  /** Cooperative pause: checked between iterations, same shape as isCancelled.
   *  pauseRun has already parked the run "paused"; stopping WITHOUT the final
   *  finish() keeps it that way (finish() also guards against resurrecting it). */
  isPaused?: () => boolean;
}): Promise<BestRecord | null> {
  const { config, registry, store, correlationId } = opts;
  const higher = config.higherIsBetter !== false;
  const answerFrom = config.answerFrom || config.metricFrom;

  // Ledger dir: the autoresearch memory (append-only log + best ratchet). Under
  // the gitignored data dir, one dir per loop run.
  const ledgerDir = resolve(opts.dataDir || resolve(process.cwd(), "data"), "research-loops", correlationId);
  mkdirSync(ledgerDir, { recursive: true });
  const logPath = resolve(ledgerDir, "log.jsonl");
  const bestPath = resolve(ledgerDir, "best.json");

  // Validate the round once — invalid graph fails the whole loop loudly, up front.
  const validatedRound = validate(config.round);

  let best: BestRecord | null = null;
  let sinceImprove = 0;
  let lastIteration = 0;
  let productiveCount = 0; // iterations that ran a clean round (for the no-metric mode's status)

  for (let i = 1; i <= config.maxIterations; i++) {
    // Cancelled between iterations — stop cleanly. cancelRun already set the run
    // "cancelled" and skipped the remaining iteration nodes; return WITHOUT the final
    // finish() below so nothing resurrects the status to completed/partial.
    if (opts.isCancelled?.()) {
      log("info", "research_loop_cancelled", { correlationId, stoppedAt: i });
      return best;
    }
    // Paused between iterations — park cleanly. pauseRun already set the run
    // "paused"; skipping the final finish() keeps that status, and best-so-far is
    // returned so a watcher can still read the current champion.
    if (opts.isPaused?.()) {
      log("info", "research_loop_paused", { correlationId, stoppedAt: i });
      return best;
    }
    lastIteration = i;
    const nodeId = iterNodeId(i);
    store.nodeStart(correlationId, nodeId);
    const startedAt = Date.now();
    try {
      // Disk-as-memory: the next round sees the best-so-far + recent attempts.
      const roundParams: Record<string, unknown> = {
        ...(config.params || {}),
        iteration: i,
        best: best ? best.answer : null,
        bestMetric: best ? best.metric : null,
        ledger: tailLedger(logPath, 5),
      };

      const trace = await executeValidated(validatedRound, roundParams, registry);
      const metric = config.metricFrom ? numericMetric(trace, config.metricFrom) : null;
      const answer = answerFrom ? (trace.nodeResults.find(x => x.nodeId === answerFrom)?.result ?? null) : null;

      // A round is "unproductive" (red) if a node failed/timed_out, OR if a metric
      // was REQUESTED (metricFrom set) but none came back. In plain "run N times"
      // mode (no metricFrom) a null metric is expected — only a real node failure
      // is unproductive. (A scored-but-non-improving round is a valid attempt, not
      // a failure — green, kept:false.)
      const failedNodes = trace.nodeResults.filter(r => r.status === "failed" || r.status === "timed_out");
      const roundFailed = failedNodes.length > 0;
      const unproductiveWhy = roundFailed
        ? `round node(s) failed: ${failedNodes.map(r => `${r.nodeId} (${r.error || r.status})`).join("; ")}`
        : config.metricFrom && metric === null
          ? `round produced no numeric metric from "${config.metricFrom}"`
          : null;

      // Ratchet only when a metric is in play; otherwise it's a plain counted run.
      const improved = !!config.metricFrom && !unproductiveWhy && metric !== null && (best === null || (higher ? metric > best.metric : metric < best.metric));
      if (improved) {
        best = { iteration: i, metric: metric!, answer };
        writeFileSync(bestPath, JSON.stringify(best, null, 2), "utf-8");
        sinceImprove = 0;
      } else {
        sinceImprove++;
      }

      // Append-only ledger row — the durable memory. Unproductive iterations
      // record WHY (research_via: failures are the most valuable anti-repeat signal).
      const row: LedgerRow = { iteration: i, metric, kept: improved, at: Date.now(), ...(unproductiveWhy ? { error: unproductiveWhy } : {}) };
      appendFileSync(logPath, JSON.stringify(row) + "\n", "utf-8");

      const completedAt = Date.now();
      const detail = {
        metric,
        kept: improved,
        bestMetric: best?.metric ?? null,
        roundStatus: trace.status,
        roundFailed,
        round: trace.nodeResults.map(r => ({ nodeId: r.nodeId, status: r.status, result: r.result, error: r.error })),
      };

      if (unproductiveWhy) {
        // Honesty: render the iteration red, not a silent green — but keep going.
        store.nodeFailed(correlationId, nodeId, {
          nodeId, status: "failed", error: unproductiveWhy, result: detail,
          startedAt, completedAt, durationMs: completedAt - startedAt, attempt: 1,
        });
        log("warn", "research_loop_iteration_unproductive", { correlationId, iteration: i, why: unproductiveWhy, roundStatus: trace.status });
      } else {
        productiveCount++;
        store.nodeComplete(correlationId, nodeId, {
          nodeId, status: "completed", result: detail,
          startedAt, completedAt, durationMs: completedAt - startedAt, attempt: 1,
        });
        log("info", "research_loop_iteration", { correlationId, iteration: i, metric, kept: improved, bestMetric: best?.metric ?? null, roundStatus: trace.status });
      }

      // No-improve early stop only applies to a metric-driven (autoresearch) loop —
      // in plain "run N times" mode there's no metric to improve, so it never fires.
      if (config.metricFrom && config.noImproveStop && sinceImprove >= config.noImproveStop) {
        log("info", "research_loop_converged", { correlationId, iteration: i, noImproveStop: config.noImproveStop, bestMetric: best?.metric ?? null });
        for (let j = i + 1; j <= config.maxIterations; j++) store.nodeSkipped(correlationId, iterNodeId(j));
        break;
      }
    } catch (err) {
      // A whole-iteration failure (e.g. round graph threw). Record it, log it to
      // the ledger (failures are the most valuable anti-repeat signal per
      // research_via), and keep going — one bad iteration shouldn't kill the loop.
      const completedAt = Date.now();
      appendFileSync(logPath, JSON.stringify({ iteration: i, metric: null, kept: false, at: completedAt, error: String(err) } as LedgerRow) + "\n", "utf-8");
      store.nodeFailed(correlationId, nodeId, {
        nodeId, status: "failed", error: String(err), startedAt, completedAt, durationMs: completedAt - startedAt, attempt: 1,
      });
      log("warn", "research_loop_iteration_failed", { correlationId, iteration: i, error: String(err) });
    }
  }

  // Completed if it ratcheted a winner (autoresearch mode) OR ran at least one
  // clean round (plain run-N-times mode). Partial only if every iteration failed.
  store.finish(correlationId, best !== null || productiveCount > 0 ? "completed" : "partial");
  log("info", "research_loop_done", { correlationId, iterations: lastIteration, productive: productiveCount, best: best?.metric ?? null, ledgerDir });
  return best;
}

/**
 * Build a generic multi-agent "refine an answer" round: three agent interactions.
 *   propose  — agent A drafts/improves an answer, seeded by the ledger (disk memory)
 *   critique — agent B finds flaws in A's draft
 *   judge    — agent C scores the draft 0..1 given the critique (advisory grade)
 * The judge node returns { metric } (parsed from its reply) so the loop ratchets on it.
 */
// A real agent reply takes minutes, not the engine's 30s default — without this
// the node times out, the agent keeps processing the (orphaned) message, and the
// loop races ahead and floods the agent's queue. 10 min comfortably covers a
// real Claude turn while still bounding a hung agent.
const AGENT_NODE_TIMEOUT_MS = 600_000;

export function buildDebateRefineRound(agents: { propose: string; critique: string; judge: string }): TaskGraph {
  return {
    id: "round:debate-refine",
    name: "debate-refine",
    description: "propose → critique → judge, one agent each",
    nodes: [
      {
        id: "propose",
        type: "agent:ask",
        timeoutMs: AGENT_NODE_TIMEOUT_MS,
        params: {
          agent: agents.propose,
          prompt:
            "You are improving an answer to a research question through iterative refinement.\n\n" +
            "QUESTION:\n{{params.question}}\n\n" +
            "BEST ANSWER SO FAR (may be null on iteration 1):\n{{params.best}}\n\n" +
            "RECENT ATTEMPTS (ledger, may be empty):\n{{params.ledger}}\n\n" +
            "Propose a clearly BETTER answer than the best so far. Be concrete and self-contained. " +
            "Return only the improved answer.",
        },
      },
      {
        id: "critique",
        type: "agent:ask",
        timeoutMs: AGENT_NODE_TIMEOUT_MS,
        params: {
          agent: agents.critique,
          prompt:
            "Critique this proposed answer to the question. List concrete flaws, gaps, or errors — be specific and adversarial.\n\n" +
            "QUESTION:\n{{params.question}}\n\n" +
            "PROPOSED ANSWER:\n{{nodes.propose.result.reply}}",
        },
      },
      {
        id: "judge",
        type: "judge:score",
        timeoutMs: AGENT_NODE_TIMEOUT_MS,
        params: {
          agent: agents.judge,
          prompt:
            "Score the proposed answer from 0.0 to 1.0 on how well it answers the question, taking the critique into account. " +
            "Reply with the number FIRST (e.g. \"0.72 — because ...\").\n\n" +
            "QUESTION:\n{{params.question}}\n\n" +
            "PROPOSED ANSWER:\n{{nodes.propose.result.reply}}\n\n" +
            "CRITIQUE:\n{{nodes.critique.result.reply}}",
        },
      },
    ],
    edges: [
      { from: "propose", to: "critique" },
      { from: "critique", to: "judge" },
    ],
  };
}
