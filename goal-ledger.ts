// goal-ledger.ts — the PRODUCER of typed goal-ledger rows.
//
// The `GoalLedgerRow` schema (contracts/goal-contract.ts, f5bd781f) has been
// canonical since round-3 of the judgment-contract arc, but NOTHING wrote it:
// conducted loops hand-write ad-hoc `{iteration, event, cid, …}` lines to
// `data/goals/<id>/ledger.jsonl`, and — critically — the hand rows record the
// round's `cid` but never the INDEPENDENCE the typed row exists to carry. This
// module closes that: it reads a settled round's node states, computes
// independence from the SAME `summarizeIndependence` the floor gate uses, and
// emits typed rows.
//
// WHY IT LIVES IN src/ AND STILL CANNOT NAME THE ROW TYPE — the exact
// constraint run-store.ts:114 documents: this file compiles under `rootDir
// ./src`, so it cannot import `contracts/goal-contract.ts` (TS6059). The row
// shapes below are therefore RESTATED as local `*Shape` types, structurally
// mirroring the contract. That is not a second source of truth left to rot:
// `goal-ledger.test.ts` (in src/__tests__, which is EXCLUDED from the project
// typecheck and CAN import contracts/) asserts — at a point that actually runs —
// that every emitted row is assignable to `GoalLedgerRow` and every produced
// independence block is assignable to `GoalRowIndependence`, in both directions.
// That test is the actuator; this restatement is the value it guards. Same
// pattern the contract file itself uses for GOAL_ROW_INDEPENDENCE_FIELDS.
//
// The independence block is produced by `summarizeIndependence`, whose return
// (`IndependenceSummary`) is documented as structurally identical to the
// contract's `GoalRowIndependence` — so no field-mapping happens here, and there
// is no place for a mapping to drift.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { summarizeIndependence, type EpistemicsNode, type IndependenceSummary } from "./epistemics.js";

/** Mirror of contracts' GoalRowIndependence. summarizeIndependence returns
 *  exactly this shape (IndependenceSummary), so the producer never re-maps it —
 *  the alias documents the contract identity without importing across rootDir. */
export type GoalRowIndependenceShape = IndependenceSummary;

/** Fields every row carries — mirror of contracts' GoalLedgerRowBase. */
interface GoalRowBaseShape {
  at: number;
  roundCid?: string;
  receiptsCount?: number;
  independence?: GoalRowIndependenceShape;
}

export interface GoalRoundRowShape extends GoalRowBaseShape {
  kind: "round";
  iteration: number;
  skipped?: boolean;
  why?: string;
  costUsd?: number;
  metric?: number;
}

export interface GoalTerminalRowShape extends GoalRowBaseShape {
  kind: "terminal";
  /** Kept a plain string here for the SAME reason run-store.ts keeps stopReason a
   *  string: the GoalStopReason union lives in contracts/ and cannot be imported
   *  under rootDir ./src. The drift-guard test pins the value set against the
   *  contract union. */
  stopReason: string;
  evidence?: string;
}

export type GoalLedgerRowShape = GoalRoundRowShape | GoalTerminalRowShape;

/** A settled round's node states, keyed by nodeId — exactly the run store's
 *  `nodes` map, and the currency `summarizeIndependence` already consumes. */
export type RoundNodes = Record<string, EpistemicsNode>;

/** How many infer legs a round actually SETTLED a receipt for — the count of
 *  legs, the denominator behind independence. Failed legs count: a leg that ran
 *  and threw still settled a receipt (with `.error`); it is `failedInferCount` in
 *  the independence block, not an absent leg. A round with none returns
 *  undefined so the row omits the field rather than writing a hollow 0. */
function receiptsCountFor(nodes: RoundNodes): number | undefined {
  let n = 0;
  for (const st of Object.values(nodes)) if (st.kind === "infer" && st.receipt) n++;
  return n > 0 ? n : undefined;
}

/** The independence block for a round, or undefined when the round settled NO
 *  infer legs at all (a derive-only round, a bare proposal). This is the load-
 *  bearing honesty of the whole schema: "ABSENT MEANS NOT MEASURED — never read
 *  it as zero" (contracts/goal-contract.ts). A round whose infer legs all FAILED
 *  is measured and honestly weak (failedInferCount>0, empty families), so it DOES
 *  get a block; a round with no infer legs to measure gets none. The distinction
 *  is drawn on presence of an infer leg, not on the summary's collapsed counts,
 *  so it cannot be fooled by every family happening to be unknown. */
export function independenceFor(nodes: RoundNodes): GoalRowIndependenceShape | undefined {
  let hadInferLeg = false;
  for (const st of Object.values(nodes)) {
    if (st.kind === "infer" && st.receipt) { hadInferLeg = true; break; }
  }
  if (!hadInferLeg) return undefined;
  return summarizeIndependence(nodes);
}

/** Build a `round` row from a settled round's node states. Pure — no I/O.
 *  `independence` and `receiptsCount` are derived from `nodes`; the caller never
 *  hand-supplies them, which is the point (the hand-ledgers omitted them). */
export function buildRoundRow(args: {
  iteration: number;
  at: number;
  nodes: RoundNodes;
  roundCid?: string;
  skipped?: boolean;
  why?: string;
  costUsd?: number;
  metric?: number;
}): GoalRoundRowShape {
  const row: GoalRoundRowShape = { kind: "round", iteration: args.iteration, at: args.at };
  if (args.roundCid !== undefined) row.roundCid = args.roundCid;
  if (args.skipped !== undefined) row.skipped = args.skipped;
  if (args.why !== undefined) row.why = args.why;
  if (args.costUsd !== undefined) row.costUsd = args.costUsd;
  if (args.metric !== undefined) row.metric = args.metric;
  const receiptsCount = receiptsCountFor(args.nodes);
  if (receiptsCount !== undefined) row.receiptsCount = receiptsCount;
  const independence = independenceFor(args.nodes);
  if (independence !== undefined) row.independence = independence;
  return row;
}

/** Build a `terminal` row. `nodes` is optional: a terminal settled by a round
 *  (met/round-failure) carries that round's independence; a terminal with no
 *  round behind it (human-stop, budget-exhausted before any round) carries none,
 *  honestly. */
export function buildTerminalRow(args: {
  at: number;
  stopReason: string;
  roundCid?: string;
  evidence?: string;
  nodes?: RoundNodes;
}): GoalTerminalRowShape {
  const row: GoalTerminalRowShape = { kind: "terminal", at: args.at, stopReason: args.stopReason };
  if (args.roundCid !== undefined) row.roundCid = args.roundCid;
  if (args.evidence !== undefined) row.evidence = args.evidence;
  if (args.nodes) {
    const receiptsCount = receiptsCountFor(args.nodes);
    if (receiptsCount !== undefined) row.receiptsCount = receiptsCount;
    const independence = independenceFor(args.nodes);
    if (independence !== undefined) row.independence = independence;
  }
  return row;
}

/** Append one typed row as a JSONL line to `<dataDir>/goals/<goalId>/ledger.jsonl`,
 *  creating the directory if needed. Append-only, write-through — a settled row is
 *  a receipt and must survive a crash mid-loop. The only I/O in this module. */
export function appendGoalRow(dataDir: string, goalId: string, row: GoalLedgerRowShape): void {
  const dir = join(dataDir, "goals", goalId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "ledger.jsonl"), JSON.stringify(row) + "\n", "utf8");
}
