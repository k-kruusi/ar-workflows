/**
 * agent-run-escrow.ts — the bond seam on the spawn path (rung 2: no-op).
 *
 * The gate (agent-run-gate.ts) locks a bond BEFORE a worker spawns and releases,
 * refunds, or slashes it after. At rung 2 there is no money: `NullEscrow` logs and
 * returns a handle. What ships now is the SHAPE — a stable call-site — so the later
 * rung that attaches real value does not have to restructure the spawn path.
 *
 * HTLC-shaped on purpose: `lock(stakeRef, preimageHash, timeoutMs)` →
 * `release(handle, preimage)` (hashlock) or `refund(handle)` (timelock). This is
 * NOT how cu-ledger works — its `commitPayment(consumerId, in, out, requestId)`
 * is a requestId-keyed balance ledger with no preimage and no timeout. Claiming
 * otherwise would launder a real integration cost, so the hashlock/timelock live
 * HERE and a rung-4 adapter owns the mapping (and implements the timelock as an
 * adapter-side timer, not as a ledger change).
 *
 * PURE except for the injected logger. No I/O, no ledger import, no network.
 */

/** A locked bond. Opaque to the gate beyond its id. */
export interface EscrowHandle {
  id: string;
  /** Hashlock. Rung 2: a stable placeholder — no preimage is ever checked. */
  preimageHash: string;
  /** Timelock, epoch ms. Rung 2: recorded, never enforced. */
  timeoutAt: number;
}

/** A deterministic, non-LLM fraud proof — the only thing that may justify a slash. */
export interface MechanicalProof {
  /** Which mechanical check produced this proof (see agent-run-fraud.ts). */
  kind: "capability-escape" | "citation-forgery" | "scope-violation" | "meter-contradiction";
  /** Human-readable statement of what was proven, for the audit record. */
  detail: string;
}

/**
 * The bond instrument. Rung 2 wires NullEscrow; rungs 4/5 swap in a real one.
 *
 * `release` REQUIRES a preimage and `refund` is the timeout path — the two HTLC
 * exits — so that a later implementation cannot quietly become "release on
 * request" without changing this signature and every call-site with it.
 */
export interface EscrowInstrument {
  lock(stakeRef: string, preimageHash: string, timeoutMs: number): EscrowHandle;
  /** Hashlock exit — the claimant must present the preimage. */
  release(h: EscrowHandle, preimage: string): void;
  /** Timelock exit — the staker recovers the bond after `timeoutAt`. */
  refund(h: EscrowHandle): void;
  /** Punitive exit — permitted ONLY on a mechanical proof, never on a judgement. */
  slash(h: EscrowHandle, proof: MechanicalProof): void;
}

/** Injected sink so the seam stays pure and testable. Structurally IDENTICAL to
 *  NodeCaps["log"] (contract.ts:198) so `caps.log` passes straight in — a wider
 *  `payload: unknown` would be contravariantly incompatible with it. */
export type EscrowLog = (level: string, event: string, data?: Record<string, unknown>) => void;

/**
 * Rung-2 implementation: records the lifecycle, moves no value.
 *
 * Honest about being a no-op — every transition logs, so an operator reading the
 * audit sees the bond lifecycle that a later rung will make real, and nobody can
 * mistake a rung-2 "release" for a payment. Handle ids are caller-supplied
 * (`stakeRef` + a monotonic counter) rather than random, so the seam introduces
 * no nondeterminism into the spawn path.
 */
export class NullEscrow implements EscrowInstrument {
  private seq = 0;

  constructor(private readonly log: EscrowLog) {}

  lock(stakeRef: string, preimageHash: string, timeoutMs: number): EscrowHandle {
    // NSP: `seq` is this instance's own counter — monotonic by construction, so the
    // id is unique per instrument without a uniqueness check.
    const h: EscrowHandle = {
      id: `null-escrow:${stakeRef}:${++this.seq}`,
      preimageHash,
      timeoutAt: Date.now() + timeoutMs,
    };
    this.log("info", "escrow_lock", { id: h.id, stakeRef, timeoutAt: h.timeoutAt, impl: "null" });
    return h;
  }

  release(h: EscrowHandle, preimage: string): void {
    this.log("info", "escrow_release", { id: h.id, preimagePresented: preimage !== "", impl: "null" });
  }

  refund(h: EscrowHandle): void {
    this.log("info", "escrow_refund", { id: h.id, impl: "null" });
  }

  slash(h: EscrowHandle, proof: MechanicalProof): void {
    this.log("warn", "escrow_slash", { id: h.id, kind: proof.kind, detail: proof.detail, impl: "null" });
  }
}

/** Persisted claim state — the HTLC field set is fixed now so rung 4 need not migrate. */
export type ClaimState = "committed" | "released" | "refunded" | "held" | "slashed";

/**
 * The claim record — **SHAPE ONLY. NOTHING WRITES THIS AT RUNG 2.**
 *
 * Deliberately unreferenced: rung 2 moves no value, so persisting a claim would be
 * a file asserting a bond that does not exist. The type is fixed now, and only the
 * type, because the §4 file plan scopes this module to interfaces with no ledger —
 * so rung 4 adds the writer without restructuring the record or the gate.
 *
 * When that writer lands it must persist node-local
 * (`cartridges/<node>/state/escrow/<claimId>.json`), NOT run-scoped: fraud is
 * usually found AFTER the run, at review time, and a run-scoped claim has already
 * been torn down by then — nothing left to slash. Retention ≥ the fraud-detection
 * horizon.
 *
 * Until then the honest audit trail is the gate's `spawn_gate_admit` log line
 * (agent-run-gate.ts), which records the same spawn receipt supervisor-side.
 */
export interface EscrowClaim {
  claimId: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  granted: string[];
  observe: boolean;
  /** HTLC shape — stable across rungs 2/4/5. */
  paymentHash: string;
  timeoutAt: string;
  /** Rung 2 is always "envelope-claim"; rungs 4/5 introduce "CU" / "sats". */
  unit: "envelope-claim" | "CU" | "sats";
  /** Rung 2 is always 1 — a claim exists or it does not. */
  amount: number;
  state: ClaimState;
  /** Exactly what the gate handed the spawn — the substrate a fraud proof reads. */
  spawnReceipt: {
    disallowedTools: string[];
    mcpToolsSubset?: string;
    attachArTools: string | false;
  };
}
