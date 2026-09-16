/**
 * route:envelope — deterministic task→seat routing (the tier router).
 *
 * Picks the ENVELOPE for a task, not just a model: tier (junior / senior /
 * architect), borrowed seat (workerProfile), reviewer runtime, and gate
 * policy. Deterministic rules first (doctrine: deterministic-first, model at
 * the edges); the cognitive-router service (:3068) is probed and reported —
 * v1 does not spend a model call on classification, the seam is recorded for
 * the next step. Fail-loud throughout: no seat available is an error, never a
 * silent fallback to a frontier seat (the spend knob never hides).
 *
 * Unresolved template literals ("{{params.x}}" passed through from a caller
 * that omitted an optional param) are treated as ABSENT at this boundary —
 * boundary input, defensive by design.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineNode } from "./contract.js";
import { MONOREPO_ROOT } from "./agent-run.js";

/** Seat preference for bulk work — rotated, never hardcoded per definition. */
const SEAT_PREFERENCE = ["glm-geoff", "deepseek-dorian", "qwen-1", "kimi-1"];
const DOC_PREFIXES = ["papers/", "docs/", "skills/", "fog/", "contracts/"];
const ROUTER_HEALTH_URL = "http://127.0.0.1:3068/health";
const ROUTER_PROBE_MS = 1500;

function isDocPath(p: string): boolean {
  return p.endsWith(".md") || DOC_PREFIXES.some((pre) => p.startsWith(pre));
}

/** Unresolved template literal → treat as absent. */
function clean(s: string): string {
  return /^\{\{[^}]+\}\}$/.test(s.trim()) ? "" : s;
}

export const routeNodes = [
  defineNode({
    type: "route:envelope",
    description:
      "Deterministic task→envelope router. Inputs: task (required), confine? (comma paths), " +
      "gateCommand?. Returns { tier, workerProfile, reviewerRuntime, gateRequired, reason, " +
      "warnings, seats, routerService, routerTier, router, envelope }. Tiers: junior (docs-only " +
      "or confined+gated build on a borrowed seat), senior (unconfined or ungated — warned, " +
      "split recommended), architect (design/decompose-shaped — frontier seat is the CALLER's " +
      "choice, never bulk). Fails loud when no borrowed seat is available. Probes " +
      "cognitive-router :3068 and reports reachability; v1 classification is deterministic " +
      "(the model-call branch is the next step). routerTier maps the route-tier vocabulary " +
      "to cognitive-router tiers (junior→sentry, senior→auditor, architect→synthesizer); " +
      "the router.{service,health,suggestedTier} field is the seam — a human flips the " +
      "policy later.",
    run: async ({ inputs }) => {
      const task = inputs.str("task", { required: true });
      const confine = clean(inputs.str("confine", { default: "" }));
      const gateCommand = clean(inputs.str("gateCommand", { default: "" }));
      const paths = confine.split(",").map((s) => s.trim()).filter(Boolean);
      const warnings: string[] = [];

      // Live-fleet seat check — routing against dead cartridges is the retired-model scar.
      const checked = SEAT_PREFERENCE.map((seat) => ({
        seat,
        available: existsSync(join(MONOREPO_ROOT, "cartridges", seat, "workspace.json")),
      }));
      const chosen = checked.find((c) => c.available)?.seat ?? null;
      if (!chosen) {
        throw new Error(
          `route:envelope: no borrowed seat available — checked ${SEAT_PREFERENCE.join(", ")} under ` +
            `cartridges/ and none has a workspace.json. Bring a seat up before routing bulk work.`,
        );
      }

      // Cognitive-router probe (guarded; v1 stays deterministic, the seam is reported).
      let routerService: "up" | "down" = "down";
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ROUTER_PROBE_MS);
      try {
        const res = await fetch(ROUTER_HEALTH_URL, { signal: ctl.signal });
        routerService = res.ok ? "up" : "down";
      } catch {
        routerService = "down";
      } finally {
        clearTimeout(timer);
      }
      if (routerService === "down") {
        warnings.push("cognitive-router :3068 unreachable — deterministic rules only");
      }

      const docsOnly = paths.length > 0 && paths.every(isDocPath);
      const architectish = /^(design|decompose|architect|spec)\b/i.test(task.trim());

      let tier: string;
      let workerProfile: string | null;
      const reviewerRuntime = "grok";
      let reason: string;

      if (architectish) {
        tier = "architect";
        workerProfile = null;
        reason =
          "design/decomposition-shaped task — architect tier: frontier seat chosen by the caller; kickoff/escalation only, never bulk";
        warnings.push("architect tier is frontier spend — confirm this cannot be a confined junior build first");
      } else if (docsOnly) {
        tier = "junior";
        workerProfile = chosen;
        reason = "docs-only surface — junior seat with cross-family review";
      } else if (paths.length > 0 && gateCommand) {
        tier = "junior";
        workerProfile = chosen;
        reason = "confined build with mechanical gate — junior seat under gate; review stays advisory (873fab61)";
      } else {
        tier = "senior";
        workerProfile = chosen;
        reason =
          "unconfined or ungated work — senior seat; STRONGLY consider splitting into confined + gated tasks before dispatch";
        warnings.push(
          paths.length === 0
            ? "no confine supplied — unconfined dispatch is the sprawl vector"
            : "no gateCommand supplied — the mechanical gate is the only pass/fail (doctrine 873fab61)",
        );
      }

      // Cognitive-router tier mapping (the seam — policy change is human-flipped later).
      // Vocabulary: junior→sentry (cheap), senior→auditor (mid), architect→synthesizer (strong).
      const ROUTER_TIER: Record<string, string> = {
        junior: "sentry",
        senior: "auditor",
        architect: "synthesizer",
      };
      const routerTier = ROUTER_TIER[tier] ?? "sentry";

      if (routerService === "up" && tier === "junior") {
        warnings.push(
          "bulk work eligible for cognitive-router cheap tier (TA value routing) — local seats enter via the router providers, never as judge/adjudication tiers",
        );
      }

      return {
        tier,
        workerProfile,
        reviewerRuntime,
        gateRequired: tier !== "architect" && !docsOnly,
        reason,
        warnings,
        seats: { checked, chosen },
        routerService,
        routerTier,
        router: {
          service: "cognitive-router",
          health: routerService,
          suggestedTier: routerTier,
        },
        envelope: { ...(workerProfile ? { workerProfile } : {}), reviewerRuntime, confine, gateCommand },
      };
    },
  }),
];
