/**
 * agent-run-gate.ts — one function, one choke point: `admitSpawn`.
 *
 * Every agent:run spawn passes through here and leaves with a SpawnEnvelope: the
 * computed execution context the worker will run inside. The gate does four things
 * (base-node.md §2.1); at rung 2 only (1) and (4) are load-bearing, (2) and (3) are
 * stable call-sites with no-op implementations so later rungs swap implementations
 * without moving the gate:
 *   1. authorize   — parse/compose capabilities into an envelope
 *   2. bond-lock   — EscrowInstrument.lock (NullEscrow at rung 2)
 *   3. meter-start — rung 1's AgentRunUsage (already downstream)
 *   4. audit       — caps.log, supervisor-written, worker-unwritable
 *
 * IT DOES NOT HARD-DENY on an empty capability set. An envelope with no verbs is a
 * valid, maximally-restricted worker (a pure-text reasoner), which is exactly what
 * deny-by-default should produce. Hard-deny is reserved for CONFLICT — an
 * unparseable verb, or `observe:true` asked for on a runtime that cannot carry MCP —
 * and those throw with the valid alternatives named (Honest Response).
 */

import {
  computeDisallowedTools,
  computeMcpToolsSubset,
  type Capability,
  type CapabilitySet,
} from "./agent-run-capabilities.js";
import type { EscrowHandle, EscrowInstrument, EscrowLog } from "./agent-run-escrow.js";
import { assert } from "../../assert.js";

/** The computed execution context a worker runs inside. */
export interface SpawnEnvelope {
  /** Comma-joined → `--disallowedTools`. ALWAYS set, including for a no-cap worker. */
  disallowedTools: string;
  /** Which ar-tools variant to attach, or false for the built-ins path. */
  attachArTools: false | "ar-tools" | "ar-tools-local";
  /** `TOOLS` env for the stdio child. Present iff an ar-tools child is attached. */
  mcpToolsSubset?: string;
  /**
   * Shell grant → inject a loopback-deny env.
   *
   * HONESTLY COSMETIC until OS-level isolation: a string filter on an unrestricted
   * shell is trivially bypassable. Real containment for non-shell workers comes from
   * layers 1+2 REMOVING the shell, not from filtering it. Recorded so the audit says
   * which spawns had this residual, and so the later microVM hardening has a field
   * to attach to.
   */
  denyControlPlane: boolean;
  /** The (null at rung 2) bond locked for this spawn. */
  bond: EscrowHandle;
  granted: readonly Capability[];
  /** Exactly what was blocked, for the audit record + the spawn receipt. */
  deniedTools: string[];
}

export interface AdmitReq {
  set: CapabilitySet;
  /** The existing `tools` input: "ar-tools" | "ar-tools-local" | "". */
  tools: string;
  runtime: string;
  nodeId: string;
  correlationId: string;
  escrow: EscrowInstrument;
  /** Same shape as NodeCaps["log"] (contract.ts:198) so `caps.log` passes straight in. */
  log: EscrowLog;
}

/** Rung 2 locks a nominal bond: no stake, a placeholder hashlock, a 1h timelock. */
const RUNG2_STAKE_REF = "envelope-claim";
const RUNG2_PREIMAGE_HASH = "rung2-no-hashlock";
const RUNG2_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Admit a spawn and compute its envelope.
 *
 * @throws when the request is internally contradictory (unknown tools value, or
 *   observe:true with no MCP transport available) — never merely because the
 *   worker asked for little.
 */
export function admitSpawn(req: AdmitReq): SpawnEnvelope {
  const { set, tools, runtime, nodeId, correlationId } = req;

  // BOUNDARY: `tools` arrives from definition JSON. agent-run.ts validates it too,
  // but the gate is callable on its own (and is the thing under test), so it does
  // not inherit a caller's diligence.
  if (tools !== "" && tools !== "ar-tools" && tools !== "ar-tools-local") {
    throw new Error(
      `agent:run gate: unknown tools "${tools}" (supported: ar-tools, ar-tools-local, or omit for built-ins)`,
    );
  }

  // `observe:true` means "route effects through MCP so the evolution bridge sees
  // them". That requires an ar-tools child. Asking to be observed while declining
  // the only transport that observes is a conflict, not a preference — and silently
  // downgrading it would hand a bond-bearing node an unobserved worker whose
  // capability-escape proof has no substrate (agent-run-fraud.ts).
  if (set.observe && tools === "") {
    throw new Error(
      `agent:run gate: observe:true requires an MCP transport — set tools:"ar-tools" ` +
        `(or "ar-tools-local" to drop web_fetch) on node "${nodeId}". ` +
        `observe:false uses built-ins via argv subtraction and needs no MCP child.`,
    );
  }

  const attachArTools: SpawnEnvelope["attachArTools"] = tools === "" ? false : tools;
  const deniedTools = computeDisallowedTools(set);

  // NSP — load-bearing, and the failure mode is silent fail-OPEN: buildClaudeArgs
  // appends `--disallowedTools` only when the joined string is TRUTHY
  // (agent-run-tools.ts), so an empty deny-list would drop the flag entirely and
  // hand the worker every built-in it was supposed to lose. It cannot be empty —
  // CLAUDE_ALWAYS_BLOCK and CLAUDE_DELEGATION_BLOCK are non-empty and no capability
  // verb maps to any of their names, so computeDisallowedTools never filters them
  // out — but "cannot" is exactly what deserves the assertion here.
  assert(
    deniedTools.length > 0,
    `agent:run gate: computed an EMPTY deny-list for node "${nodeId}" — the interactive and ` +
      `delegation blocks are ungrantable, so this is unreachable; reaching it means a capability ` +
      `now maps to one of their names and every built-in would silently be re-enabled`,
  );
  const mcpToolsSubset = computeMcpToolsSubset(set);
  const grantsShell = set.caps.includes("shell");

  // Step 2 of the gate: lock the bond BEFORE the worker exists, so a spawn can
  // never outlive an unbonded gate decision. NullEscrow at rung 2.
  const bond = req.escrow.lock(RUNG2_STAKE_REF, RUNG2_PREIMAGE_HASH, RUNG2_TIMEOUT_MS);

  const envelope: SpawnEnvelope = {
    disallowedTools: deniedTools.join(","),
    attachArTools,
    denyControlPlane: grantsShell,
    bond,
    granted: set.caps,
    deniedTools,
  };
  // Set for EVERY attached child, on every path — NOT only the observed one.
  //
  // This is the second half of deny-by-default and it is not optional: an attached
  // ar-tools child with no TOOLS registers its full 16-tool surface, `run_command`
  // included, which is an unrestricted shell handed to a worker that may have been
  // granted only `fs.read`. Gating on `observe` here (as this once did) reopens
  // A-B1 — argv blocks built-in `Bash` while MCP quietly serves a better one.
  // `observe` decides whether the BUILT-INS survive; it never decides what MCP
  // registers. Absent only when there is genuinely no child: an env var for a
  // server that does not exist would be a lie in the spawn receipt.
  if (attachArTools !== false) {
    // NSP — the failure mode is silent fail-OPEN, exactly like the deny-list above:
    // server.ts reads `process.env.TOOLS ? split : ALL_TOOLS`, so an empty string is
    // FALSY and means "register everything". computeMcpToolsSubset returns
    // MCP_TOOLS_NONE rather than "" for the zero-capability case precisely so this
    // cannot happen — but the cost of being wrong is a shell, so it is checked.
    assert(
      mcpToolsSubset !== "",
      `agent:run gate: computed an EMPTY TOOLS subset for node "${nodeId}" — ar-tools reads an ` +
        `empty TOOLS as UNSET and would register every tool including run_command; ` +
        `computeMcpToolsSubset returns MCP_TOOLS_NONE for zero capabilities, so this is unreachable`,
    );
    envelope.mcpToolsSubset = mcpToolsSubset;
  }

  // Step 4: the audit line. Written SUPERVISOR-side; the worker has no handle to
  // it. This is the substrate the capability-escape fraud proof reads, and the log
  // a later rung commits to a Merkle root.
  req.log("info", "spawn_gate_admit", {
    nodeId,
    correlationId,
    runtime,
    granted: envelope.granted,
    deniedTools: envelope.deniedTools,
    observe: set.observe,
    declared: set.declared,
    attachArTools: envelope.attachArTools,
    mcpToolsSubset: envelope.mcpToolsSubset,
    denyControlPlane: envelope.denyControlPlane,
    bond: envelope.bond.id,
  });

  // Deny-by-default must be an ACTIONABLE signal, not silent breakage: an external
  // or user definition that predates the envelope gets a maximally-restricted
  // worker plus this line telling the author exactly what to add.
  if (!set.declared) {
    req.log("warn", "spawn_gate_deny_default", {
      nodeId,
      correlationId,
      hint: 'no `capabilities` declared — this worker has NO file, shell, or web tools. Declare a comma-separated string, e.g. capabilities: "fs.read,fs.write"',
    });
  }

  // The honest residual, recorded per-spawn rather than buried in a design doc.
  if (grantsShell) {
    req.log("warn", "spawn_gate_shell_granted", {
      nodeId,
      correlationId,
      residual:
        "a shell-granted worker retains control-plane reach (it can curl the supervisor). " +
        "Layers 1+2 contain only non-shell workers; the loopback-deny env is cosmetic until OS isolation.",
    });
  }

  return envelope;
}
