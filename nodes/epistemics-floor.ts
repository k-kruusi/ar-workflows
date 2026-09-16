/**
 * epistemics:floor — the ACTUATOR for invariant #3.
 *
 * Independence has been measurable since 2af89f9a/5d9dd183 and enforced by nothing:
 * core:merge reports how many genuinely-independent opinions a panel represents, and
 * a run with an independence of 1 proceeds exactly like a run with 6. A detector with
 * no actuator is structurally inert — the same shape as a gate that writes
 * "decision":"reject" nobody reads. This node is that missing half.
 *
 * `derive`, and that classification is load-bearing rather than bookkeeping: the floor
 * is computed from receipts by counting, with no model in the loop. That is precisely
 * what makes it legitimate to BLOCK on. An advisory model grade must never be a hard
 * gate (873fab61 — opus self-contradicted shot-to-shot); a count of distinct weight
 * families is not a grade.
 *
 * THE ASYMMETRY WITH core:merge, which is the whole reason this is a separate node:
 * a REPORTER that cannot measure must omit its field (absence stays legible as
 * absence). A GATE that cannot measure must REFUSE. Reporting fails open, gating fails
 * closed — so where core:merge silently drops `independence` with no runner wired,
 * this node throws. A gate that passes because it could not look is not a gate.
 *
 * WHAT IT DOES NOT GATE: the mechanical bar. Deterministic checks (tests, tsc,
 * review:anchor-check's unresolvedCount) need no independence and must never be routed
 * through this node — gating a machine check on a model-derived signal would let an
 * advisory vote overrule a fact. Two gates, two epistemic classes, never merged.
 */
import { defineNode, type NodeDef } from "./contract.js";
import { summarizeIndependence, familyOf, UNKNOWN_FAMILY } from "../epistemics.js";
import type { EpistemicsNodeView } from "./contract.js";

/** Parse a comma-separated node-id list (the inputs contract exposes no .arr, so an
 *  array param would be a fabrication — same convention as agent:run's capabilities). */
function idList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Distinct KNOWN families among succeeded infer receipts in a node subset, plus
 *  whether any leg's family could not be established. Unknowns are returned rather
 *  than dropped: a disjointness claim over an unknown family is unprovable, and the
 *  caller must fail closed on it rather than assume it differs. */
function familiesOf(nodes: Record<string, EpistemicsNodeView>, ids: string[]): { families: Set<string>; unknown: number } {
  const families = new Set<string>();
  let unknown = 0;
  for (const id of ids) {
    const st = nodes[id];
    if (!st || st.kind !== "infer" || !st.receipt) continue;
    if (st.receipt.error !== undefined) continue;   // a failed leg produced no verdict
    const f = familyOf(st.receipt);
    if (f === UNKNOWN_FAMILY) unknown++; else families.add(f);
  }
  return { families, unknown };
}

export const epistemicsFloorNodes: NodeDef[] = [
  defineNode({
    type: "epistemics:floor",
    description:
      "GATE on verification independence — throws when the floor is unmet, so on:'failure' branches " +
      "(same contract as core:gate). Params: minFamilies? (minimum distinct WEIGHT families among " +
      "succeeded infer legs — two legs sharing a model are one opinion, so this is the real count), " +
      "minSupplyChains? (minimum distinct upstream ACCOUNTS — three families behind one token is one " +
      "rate limit and one revocation), sources? (comma-separated node ids to score; default = the whole " +
      "run), disjointFrom? (comma-separated node ids whose families must NOT appear in sources — the " +
      "fresh-read check: a reviewer sharing weights with the implementer is not a fresh read, however " +
      "different its host or account), mode? ('block' default | 'warn' to report without throwing). " +
      "Returns { ok, independenceCount, supplyChainCount, inferFamilies, violations, ... }. " +
      "DERIVE — a count, not a grade, which is what makes it safe to block on. NEVER gate a " +
      "deterministic check (tests/tsc/anchor-check) through this: those need no independence.",
    run: async ({ inputs, caps, correlationId }) => {
      const minFamilies = inputs.has("minFamilies") ? inputs.num("minFamilies", { min: 0 }) : undefined;
      const minSupplyChains = inputs.has("minSupplyChains") ? inputs.num("minSupplyChains", { min: 0 }) : undefined;
      const sources = idList(inputs.str("sources"));
      const disjointFrom = idList(inputs.str("disjointFrom"));
      const mode = inputs.str("mode", { default: "block" });
      if (mode !== "block" && mode !== "warn") {
        throw new Error(`epistemics:floor: mode must be "block" or "warn", got "${mode}"`);
      }
      if (minFamilies === undefined && minSupplyChains === undefined && disjointFrom.length === 0) {
        throw new Error(
          "epistemics:floor: needs at least one of minFamilies, minSupplyChains or disjointFrom — " +
            "a gate with no floor would pass everything and read as enforcement.",
        );
      }

      // FAIL CLOSED when the run state is unreadable. See the asymmetry note above:
      // core:merge omits, this refuses. "Could not measure" is not "passed".
      const runNodes = correlationId ? caps.receipt.runNodes(correlationId) : undefined;
      if (!runNodes) {
        throw new Error(
          "epistemics:floor: cannot read run state (no runner wired, or unknown correlationId), so " +
            "independence is UNMEASURED. A gate that passes because it could not look is not a gate.",
        );
      }

      if (sources.length > 0) {
        const missing = sources.filter((id) => !(id in runNodes));
        if (missing.length > 0) {
          throw new Error(
            `epistemics:floor: sources names ${missing.length} node id(s) not in this run: ${missing.join(", ")} ` +
              `(known: ${Object.keys(runNodes).join(", ")})`,
          );
        }
      }
      const scoped = sources.length > 0
        ? Object.fromEntries(sources.map((id) => [id, runNodes[id]]))
        : runNodes;
      const summary = summarizeIndependence(scoped);
      const violations: string[] = [];

      if (minFamilies !== undefined && summary.independenceCount < minFamilies) {
        violations.push(
          `independence ${summary.independenceCount} < required ${minFamilies} ` +
            `(families: ${summary.inferFamilies.join(", ") || "none"}` +
            `${summary.unknownFamilyCount > 0 ? `; ${summary.unknownFamilyCount} leg(s) of unknown family buy no independence` : ""})`,
        );
      }
      if (minSupplyChains !== undefined && summary.supplyChainCount < minSupplyChains) {
        violations.push(
          `supply chains ${summary.supplyChainCount} < required ${minSupplyChains}` +
            (summary.sharedAccounts.length > 0
              ? ` — one account serves ${summary.sharedAccounts.map((a) => a.families.join("+")).join("; ")}`
              : "") +
            (summary.unknownAccountCount > 0 ? ` (${summary.unknownAccountCount} leg(s) recorded no account)` : ""),
        );
      }

      // The fresh-read check. Verified trap this exists for: ornith-1.0-35B is a Qwen 3.5
      // derivative, so an ornith read of qwen-implemented work LOOKS cross-family
      // (different host, different account) and SHARES WEIGHTS — same failure mode, no
      // real independence. Keying on family catches it; keying on seat name would not.
      if (disjointFrom.length > 0) {
        const missing = disjointFrom.filter((id) => !(id in runNodes));
        if (missing.length > 0) {
          throw new Error(
            `epistemics:floor: disjointFrom names ${missing.length} node id(s) not in this run: ${missing.join(", ")}`,
          );
        }
        const readerIds = sources.length > 0 ? sources : Object.keys(runNodes).filter((id) => !disjointFrom.includes(id));
        const readers = familiesOf(runNodes, readerIds);
        const priors = familiesOf(runNodes, disjointFrom);
        const overlap = [...readers.families].filter((f) => priors.families.has(f));
        if (overlap.length > 0) {
          violations.push(
            `not a fresh read: family overlap [${overlap.join(", ")}] between the reader and ` +
              `[${disjointFrom.join(", ")}] — same weights err the same way, whatever the host or account`,
          );
        }
        // Unprovable disjointness is a violation, not a pass: an unidentifiable family
        // cannot be shown to differ from anything.
        if (readers.unknown > 0 || priors.unknown > 0) {
          violations.push(
            `disjointness unprovable: ${readers.unknown} reader leg(s) and ${priors.unknown} prior leg(s) ` +
              `have no established family — pin their model so the family resolves`,
          );
        }
      }

      const result = {
        ok: violations.length === 0,
        mode,
        violations,
        independenceCount: summary.independenceCount,
        supplyChainCount: summary.supplyChainCount,
        inferFamilies: summary.inferFamilies,
        unknownFamilyCount: summary.unknownFamilyCount,
        failedInferCount: summary.failedInferCount,
        sharedAccounts: summary.sharedAccounts,
        scope: sources.length > 0 ? "sources" : "run",
      };
      if (violations.length > 0 && mode === "block") {
        // The message carries every violation, because a gate that says only "closed"
        // sends the reader back to re-derive what it already knew.
        throw new Error(`epistemics:floor CLOSED — ${violations.join(" | ")}`);
      }
      return result;
    },
  }),
];
