/**
 * run-budget.ts — a per-run spend/step ceiling for `WorkflowRunner.execGraph`.
 *
 * ## Why this exists
 *
 * The engine already computes per-node cost (`receipt.usage.costUsd`, rolled up by
 * `epistemics.ts`) and already has a dispatch gate that stops new nodes from
 * starting (`halted` in `execGraph`). It had no edge between them: a run could
 * spend without limit until an EXTERNAL wall (the provider's spend cap) killed it
 * mid-node, losing the run.
 *
 * ## Design
 *
 * - **Per run, not global.** One runaway DAG must not trip a breaker that blocks
 *   the whole fleet. Each `execGraph` call owns its own instance.
 * - **A backstop, not a policy.** Defaults are deliberately high enough that no
 *   existing definition should hit them. Dial down per-run when you want a policy.
 * - **Stopping is RESUMABLE.** The runner marks a tripped run `failed` via
 *   `store.fail()`, which skips never-started nodes; a resume re-runs exactly
 *   those while completed nodes return cached results. Raising the ceiling and
 *   re-firing is the recovery path — the opposite of an external kill, which
 *   loses everything in flight.
 * - **Failed nodes count.** A node that errored still burned tokens. Charging only
 *   successes would let a retry loop spend freely.
 *
 * ## Honest limits
 *
 * - A nested `workflow:run` child gets its OWN budget (its own `execGraph` call).
 *   The child's spend reaches the parent only through the workflow:run node's own
 *   receipt, if one carried usage. A DAG-of-DAGs is therefore bounded per-level,
 *   not globally. Making it global means threading the parent's budget through
 *   `invokeNested` — deliberately not done here.
 * - Cost is only as good as the receipt. A node whose adapter reports no usage
 *   charges 0 against the cost ceiling; the NODE ceiling is what bounds it.
 */

import { CircuitBreaker } from "../circuit-breaker.js";

export interface RunBudgetConfig {
  /** Hard ceiling on summed `receipt.usage.costUsd` across the run's nodes. */
  maxCostUsd: number;
  /** Hard ceiling on settled nodes (completed + failed). */
  maxNodes: number;
}

/**
 * Deliberately high — this is a runaway backstop, not a per-run policy. A
 * review-gauntlet run settles 8 nodes for a few dollars; a research-swarm fans
 * wider. Neither should ever see these.
 */
export const DEFAULT_RUN_BUDGET: RunBudgetConfig = {
  maxCostUsd: 50,
  maxNodes: 100,
};

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the ceiling for one run: env defaults, overridden by a `__budget` key
 * in the run's params.
 *
 * `__budget` is underscore-prefixed to match the engine's existing convention for
 * engine-reserved param keys (cf. `__wfMeta`) so it can never collide with a
 * definition's own template variables.
 */
export function resolveRunBudget(params?: Record<string, unknown>): RunBudgetConfig {
  const base: RunBudgetConfig = {
    maxCostUsd: positiveNumber(process.env.WORKFLOW_MAX_COST_USD, DEFAULT_RUN_BUDGET.maxCostUsd),
    maxNodes: positiveNumber(process.env.WORKFLOW_MAX_NODES, DEFAULT_RUN_BUDGET.maxNodes),
  };

  const override = params?.__budget;
  if (!override || typeof override !== "object") return base;

  const o = override as Record<string, unknown>;
  const maxCostUsd = typeof o.maxCostUsd === "number" ? o.maxCostUsd : undefined;
  const maxNodes = typeof o.maxNodes === "number" ? o.maxNodes : undefined;

  return {
    maxCostUsd: maxCostUsd !== undefined && Number.isFinite(maxCostUsd) && maxCostUsd > 0
      ? maxCostUsd
      : base.maxCostUsd,
    maxNodes: maxNodes !== undefined && Number.isFinite(maxNodes) && maxNodes > 0
      ? maxNodes
      : base.maxNodes,
  };
}

/**
 * A run's spend/step ceiling.
 *
 * Thin wrapper over `CircuitBreaker` — the counting, warn-at-80%, trip and
 * structured logging are all already implemented and tested there. Two
 * adaptations for the workflow case:
 *
 *  - `cooldownMs: 0` — workflow nodes run back-to-back; the injection cooldown is
 *    a console-orchestrator concern. (Moot in practice: this class never calls
 *    `canInject()`, which is the only consumer of cooldown, but 0 states intent.)
 *  - no `stateFile` — a run's ledger dies with the run. Persisting it would leak
 *    one run's spend into the next.
 */
export class RunBudget {
  private breaker: CircuitBreaker;
  readonly config: RunBudgetConfig;

  constructor(config: RunBudgetConfig) {
    this.config = config;
    this.breaker = new CircuitBreaker({
      maxAutonomousTurns: config.maxNodes,
      maxAutonomousCost: config.maxCostUsd,
      cooldownMs: 0,
    });
  }

  /**
   * Charge one settled node against the budget. Call for completed AND failed
   * nodes — both burned tokens.
   *
   * @param costUsd - from `receipt.usage.costUsd`; absent when the adapter
   *                  reported no usage, which charges the node ceiling only.
   */
  record(costUsd?: number): void {
    this.breaker.recordTurn(typeof costUsd === "number" ? costUsd : 0);
  }

  /** True once a ceiling has been met — read by the engine's `halted` gate. */
  get tripped(): boolean {
    return this.breaker.tripped;
  }

  /** Human-readable trip cause, empty while untripped. */
  get reason(): string {
    return this.breaker.status().reason;
  }

  /** Current ledger — for logging and the run record. */
  status(): { nodes: number; costUsd: number; tripped: boolean; reason: string } {
    const s = this.breaker.status();
    return { nodes: s.turns, costUsd: s.cost, tripped: s.tripped, reason: s.reason };
  }
}
