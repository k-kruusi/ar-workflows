/**
 * agent-run-fraud.ts — does the evidence mechanically prove fraud?
 *
 * NO LLM. NO MODEL IMPORT. NO NETWORK. This module is a pure decision table over
 * evidence that some OTHER, deterministic process computed. That constraint is the
 * whole point: a bond may only be slashed on something a machine can re-derive and
 * a human can re-check. "The code is subtly wrong" and "the review was dishonest"
 * are real fraud and are NOT provable here — they return `inconclusive` and go to a
 * human terminal gate. An LLM's opinion is advisory input to that human, never a
 * verdict, because a single model is not a clean grader (opus self-contradicted
 * shot-to-shot, commit 873fab61).
 *
 * Rung 2 ships the verdict function and the evidence shape. The COLLECTORS that
 * populate MechanicalEvidence (cite.mjs recompute, git-diff scope check, the
 * bridge's observed-call log, the rung-1 meter) are later rungs' work.
 */

/** What a verdict may conclude. `fraud` is the only state that may justify a slash. */
export type FraudVerdict =
  | { verdict: "pass"; proof: MechanicalProof }
  | { verdict: "fraud"; proof: MechanicalProof }
  | { verdict: "inconclusive"; reason: string };

import type { MechanicalProof } from "./agent-run-escrow.js";

/**
 * Deterministic evidence about one worker run. Every check is OPTIONAL because
 * each collector is independently available — `undefined` means "not collected",
 * which is emphatically NOT the same as "passed" (see verifyMechanical).
 */
export interface MechanicalEvidence {
  /** Observed MCP calls ⊆ granted capabilities. SOUND ONLY when `observed` is true. */
  escapeOk?: boolean;
  /** Every emitted `path:Lx-Ly@commit#hash` recomputes (scripts/cite.mjs). */
  citationsOk?: boolean;
  /** `git diff` of the run's cwd touches only declared paths. */
  scopeOk?: boolean;
  /** Claimed resource use matches the rung-1 AgentRunUsage meter. */
  meterOk?: boolean;
  /**
   * Was this an `observe:true` node? Built-in tool calls inside `claude -p` are
   * NOT observable, so on an observe:false node an "escapeOk: true" is a statement
   * about an empty log, not about the worker's behaviour. This flag gates the
   * escape proof's soundness rather than pretending the blindness away.
   */
  observed: boolean;
}

/** Checks in a stable order, so a verdict's `detail` reads the same way every time. */
const CHECKS: ReadonlyArray<{ key: keyof MechanicalEvidence; kind: MechanicalProof["kind"] }> = [
  { key: "escapeOk", kind: "capability-escape" },
  { key: "citationsOk", kind: "citation-forgery" },
  { key: "scopeOk", kind: "scope-violation" },
  { key: "meterOk", kind: "meter-contradiction" },
];

/**
 * Decide a verdict from mechanical evidence alone.
 *
 * The asymmetry is deliberate and load-bearing:
 *  - ANY collected check that FAILED ⇒ `fraud`. One deterministic failure is proof;
 *    it does not need corroboration from the others.
 *  - NO check collected at all ⇒ `inconclusive`. An empty evidence set must never
 *    auto-pass — "we checked nothing" and "everything checked out" are the two
 *    claims this function exists to keep apart.
 *  - `escapeOk` present but `observed:false` ⇒ `inconclusive`. The escape check is
 *    unsound on an unobserved node (built-in calls leave no log), so believing it
 *    would launder blindness into a pass.
 *  - Otherwise ⇒ `pass`, naming exactly which checks backed it.
 *
 * Failure ranks above missing-ness: a run with one hard failure and three
 * uncollected checks is fraud, not inconclusive — the proof already exists.
 */
export function verifyMechanical(ev: MechanicalEvidence): FraudVerdict {
  const failed = CHECKS.filter(({ key }) => ev[key] === false);
  if (failed.length > 0) {
    // Unsound escape evidence cannot convict either — drop it before concluding fraud.
    const admissible = failed.filter(({ key }) => key !== "escapeOk" || ev.observed);
    if (admissible.length > 0) {
      return {
        verdict: "fraud",
        proof: {
          kind: admissible[0].kind,
          detail: `mechanical check(s) failed: ${admissible.map((c) => c.kind).join(", ")}`,
        },
      };
    }
    return {
      verdict: "inconclusive",
      reason:
        "capability-escape is the only failing check, but this node ran with observe:false — " +
        "built-in tool calls are unobservable, so the escape log cannot convict. Escalate to a human.",
    };
  }

  if (ev.escapeOk === true && !ev.observed) {
    return {
      verdict: "inconclusive",
      reason:
        "escapeOk was reported for an observe:false node — built-in tool calls leave no MCP " +
        "record, so a clean log is evidence of blindness, not of compliance. Escalate to a human.",
    };
  }

  const collected = CHECKS.filter(({ key }) => ev[key] === true);
  if (collected.length === 0) {
    return {
      verdict: "inconclusive",
      reason: "no mechanical check was collected — absence of evidence is not a pass. Escalate to a human.",
    };
  }

  return {
    verdict: "pass",
    proof: {
      kind: collected[0].kind,
      detail: `mechanical check(s) passed: ${collected.map((c) => c.kind).join(", ")}`,
    },
  };
}
