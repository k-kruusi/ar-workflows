/**
 * Workflow epistemic classification — derive/infer catalog, InferenceReceipt,
 * SubRunRollup, and pure read helpers.
 *
 * New types live here (not in run-store or contract) so no contended file needs
 * to change to introduce them. The catalog (NODE_KINDS) is the single source of
 * truth for every node type, including circulation's dynamically-folded types.
 */
import { createHash } from "node:crypto";
import type { AgentRunUsage } from "./nodes/agent-run.js"; // type-only; no runtime cycle

/** Epistemic status of a node's output.
 *  derive  – deterministic computation (same inputs → same output; reproducible).
 *  infer   – LLM/agent-mediated judgment (contingent on model+prompt+context).
 *  unknown – honest default for a type absent from NODE_KINDS or a legacy run.
 *            NEVER silently coerced to derive/infer (Honest Response principle). */
export type EpistemicKind = "derive" | "infer";
export type EpistemicKindResolved = EpistemicKind | "unknown";

/** Single source of truth. Keyed by node `type`. Includes types NOT in the static
 *  registry (e.g. circulation's dynamically-folded grade:verify / organ:run) so
 *  folded nodes classify too. */
export const NODE_KINDS: Record<string, EpistemicKind> = {
  // derive — mechanical / deterministic
  "core:noop": "derive",
  /** Mechanical fan-in. Classifying this `derive` is load-bearing, not bookkeeping:
   *  it is what lets a multi-model panel keep an independence count > 1. Joining the
   *  same verdicts with an agent:run would make the join `infer`, and every verdict
   *  downstream of it would inherit that one model's failure mode. */
  "core:merge": "derive",
  /** Legacy alias of core:noop (supervisor.ts) — still registered in allNodeDefs. */
  "noop": "derive",
  "core:delay": "derive",
  "core:gate": "derive",
  /** derive, and the classification is what licenses it to BLOCK: the floor is a COUNT
   *  of distinct weight families/accounts computed from receipts, with no model in the
   *  loop. An advisory grade must never be a hard gate (873fab61); a count is not a grade. */
  "epistemics:floor": "derive",
  "core:exec": "derive",
  "demo:delay": "derive",
  "demo:gate": "derive",
  "agent:state": "derive",
  "agent:notify": "derive",
  "supervisor:cancel": "derive",
  "supervisor:resetConversation": "derive",
  "supervisor:clearSessionFile": "derive",
  "supervisor:flushStats": "derive",
  "supervisor:send": "derive",
  "supervisor:start": "derive",
  "supervisor:stop": "derive",
  "workflow:run": "derive", // orchestration; sub-inference lives on the child run
  "coverage:init": "derive", // ledger seed; mechanical
  "coverage:mark": "derive", // ledger append; mechanical
  "coverage:summary": "derive", // ledger reduce; mechanical
  "review:anchor-check": "derive", // deterministic file:line citation resolution (regex + fs); no model
  /** derive: its own doc is explicit that v1 classification is DETERMINISTIC and
   *  "does not spend a model call" — it probes the cognitive-router and reports
   *  reachability, but the tier/seat decision is rules-only. Catalogued here even
   *  though route.ts is not yet committed, on the same footing as circulation's
   *  grade:verify/organ:run: NODE_KINDS is the single source of truth and may name
   *  a type ahead of (or without) its registration. */
  "route:envelope": "derive",
  /** derive, not infer: the VERDICT is a model's judgment, but this node only parses
   *  the leading token out of it — same text in, same boolean out, no model call.
   *  Same footing as review:anchor-check, which also reads model prose mechanically. */
  "review:verdict": "derive",
  /** derive: extracts a JSON object from model prose (fence-tolerant). Same text in,
   *  same graph out, no model call. The node exists so workflow:run can keep refusing
   *  strings. Registered in allNodeDefs; catalog must name it or CI fails loudly. */
  "graph:parse": "derive",
  // infer — generative / advisory model turn
  "agent:run": "infer",
  /** A completion from a router tier (local or hosted model). Generative judgment,
   *  same class as agent:run — its receipt keys familyOf off the tier's model. */
  "model:generate": "infer",
  "agent:ask": "infer",
  "agent:whisper": "infer",
  "judge:score": "infer",
  "grade:verify": "infer", // circulation
  "organ:run": "infer",   // circulation
};

export function classifyKind(type: string | undefined): EpistemicKindResolved {
  if (!type) return "unknown";
  return NODE_KINDS[type] ?? "unknown";
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Model-family prefixes, most specific first. Matched against `modelConfigured`
 *  (config), never against `model` (runtime telemetry — see that field's note).
 *
 *  A family is the unit of CORRELATED ERROR: two verdicts from one family are one
 *  verdict sampled twice. The list is deliberately additive-only — an unrecognised
 *  pin resolves "unknown" and buys no independence, which is the honest failure
 *  (see UNKNOWN_FAMILY below) rather than a guess that silently inflates a count. */
const FAMILY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["claude-", "claude"], ["sonnet", "claude"], ["opus", "claude"],
  ["haiku", "claude"], ["fable", "claude"],
  ["grok", "grok"],
  ["deepseek", "deepseek"],
  /** Ornith is a Qwen 3.5 derivative, so it shares Qwen's failure mode and must NOT
   *  count as independent from a qwen-1 seat — different host and account, SAME
   *  weights. Every entry here is verified from the artifact's own metadata, never
   *  the model card:
   *    - 35B MoE  — repo config.json: architectures ["Qwen3_5MoeForConditionalGeneration"],
   *      model_type qwen3_5_moe.
   *    - 9B DENSE — GGUF metadata via ollama /api/show: general.architecture "qwen35",
   *      block_count 32, embedding_length 4096, param_size 8.95B, and NO expert_count
   *      (hence dense). Measured 2026-08-09 against the live ollama seat.
   *
   *  A previous revision of this comment claimed the family was SPLIT by variant —
   *  dense post-trained on Gemma 4, MoE on Qwen 3.5 — and that branch was documented
   *  but never implemented. The 9B measurement above contradicts it, and implementing
   *  it as written would have been worse than the gap it described: mapping a dense
   *  Ornith to "google" keys a Qwen model as Google, which BOTH fakes independence
   *  from a qwen seat AND collides with the real gemma-4 local seat. That is an
   *  inflated count — the one failure direction this table exists to prevent.
   *
   *  Match the specific size, never a bare "ornith". Only variants whose weights we
   *  have actually read belong here; anything else falls to UNKNOWN_FAMILY and buys
   *  zero independence, which is the honest refusal. */
  ["ornith-1.0-35b", "qwen"], ["ornith-35b", "qwen"],
  ["ornith-1.0-9b", "qwen"], ["ornith-9b", "qwen"],
  ["qwen", "qwen"],
  /** Muse-Glimmer (helmet-fire's endpoint since 2026-08-12, replacing Ornith-35B).
   *  GGUF header, read from the loaded artifact by claude@helmet-fire and NOT
   *  re-read here: general.architecture "muse-glimmer" (its own arch, alias of
   *  nothing already in this table), general.name "Muse Glimmer Hf",
   *  general.size_label "28B" — the "30B" in the served id is rounding, so key any
   *  param-count table off 28B. basename/finetune absent.
   *
   *  Mapped to META, not to a new "muse-glimmer" family — a deliberate departure
   *  from the recommendation that came with the metadata, which reasoned that a
   *  distinct architecture implies a distinct family. This table does not key on
   *  architecture: gemma and gemini are different architectures and share one
   *  family ("same lab and data lineage — likely correlated error"), and that is
   *  the precedent that governs here. Muse-Glimmer is Meta lineage distilled from
   *  Muse Spark, and a distilled student inherits its teacher's failure modes by
   *  construction — which is the thing this table measures.
   *
   *  The two directions are not symmetric, which is what decides it. Minting a new
   *  family says a muse leg is independent of a llama leg; if that is wrong the
   *  count is INFLATED, the one failure direction this table exists to prevent.
   *  Mapping to meta can only UNDER-count, which the header above calls the honest
   *  refusal. Costs nothing today — no llama seat is live in this fleet — and is a
   *  one-line change to split out if someone measures the correlation and finds it
   *  absent. Bare prefix (not size-pinned like ornith) because here the family
   *  claim rests on the arch string the artifact reports about ITSELF, whereas
   *  "ornith" was a product name spanning two different bases. */
  /** Teacher and student share a row ON PURPOSE. Muse-Glimmer is a distill (and
   *  quantization) of Muse Spark, so whatever else is true, a glimmer leg and a
   *  spark leg are ONE opinion — the student was trained on the teacher's outputs.
   *  Keeping muse-spark unmapped would leave that trap armed for the day a spark
   *  seat is added: it would fall to UNKNOWN_FAMILY, and a later well-meaning
   *  entry giving it its own family would make the pair read as independent.
   *
   *  The LABEL "meta" is the part still resting on a relayed claim (Muse Spark is
   *  Meta lineage — claude@helmet-fire, not verified here). If Spark turns out to
   *  belong to some other lab, BOTH rows get relabelled together and the
   *  teacher/student invariant above is unaffected — that is why they are written
   *  as one unit. Quantization is a serving detail and never a family matter. */
  ["muse-glimmer", "meta"], ["muse-spark", "meta"],
  ["glm", "glm"],
  ["kimi", "kimi"], ["k3", "kimi"], ["moonshot", "kimi"],
  ["minimax", "minimax"],
  ["gpt-", "openai"], ["o1-", "openai"], ["o3-", "openai"],
  /** gemma shares gemini's lab and data lineage — one family, likely correlated
   *  error. This is the local reviewer's weight family (turboquant serves gemma-4). */
  ["gemma", "google"], ["gemini", "google"],
  ["llama", "meta"],
  ["mistral", "mistral"], ["mixtral", "mistral"],
];

/** Honest default for a leg whose weight family could not be established from
 *  config. NEVER folded into a real family and NEVER counted as independent —
 *  same discipline as `unknown` in EpistemicKindResolved. */
export const UNKNOWN_FAMILY = "unknown";

/** Weight family behind an inference, from CONFIG ONLY.
 *
 *  Resolution order, strongest evidence first:
 *    1. `modelConfigured` — the pin we wrote (param, or the profile's ANTHROPIC_MODEL).
 *    2. `runtime: "grok"` — a separate transport that cannot be redirected by a
 *       profile (agent:run rejects grok + workerProfile), so the runtime IS the family.
 *    3. UNKNOWN_FAMILY.
 *
 *  `model` (runtime telemetry) is deliberately not consulted, and the reason is
 *  availability and provenance rather than mendacity: it is absent on thin and
 *  engine-minimal receipts, and it is reported BY the path whose independence we are
 *  trying to establish. Config is present earlier and cannot be shaped by the
 *  upstream. See the note on InferenceReceipt.model — on real runs that telemetry
 *  has agreed with config, so this is a choice of the stronger key, not a rejection
 *  of a liar.
 *
 *  KNOWN GAP, measured not theorised: a native leg that pins no model and borrows no
 *  profile (runtime "claude", model unset → the CLI default) resolves UNKNOWN, and so
 *  buys no independence even though it is plainly a claude leg. Every leg of
 *  adversarial-design-six-family pins or borrows, so that definition scores 6/6 — but
 *  a definition that leaves `model` off would under-count. Closing it means admitting
 *  telemetry as a labelled weaker tier; deliberately not done yet. */
export function familyOf(receipt: Pick<InferenceReceipt, "modelConfigured" | "runtime">): string {
  const pin = receipt.modelConfigured?.trim().toLowerCase();
  if (pin) {
    for (const [prefix, family] of FAMILY_PREFIXES) {
      if (pin.startsWith(prefix) || pin.includes(prefix)) return family;
    }
  }
  if (receipt.runtime === "grok") return "grok";
  return UNKNOWN_FAMILY;
}

/** Non-secret route identity from an upstream env block (the workerProfile merge,
 *  or process env for a native leg).
 *
 *  Returns ONLY derived, non-reversible values: `routeHost` is host:port with path,
 *  query and userinfo stripped; `accountId` is a domain-separated SHA-256 prefix of
 *  the auth token. The token itself never leaves this function, is never logged and
 *  is never persisted — the receipt keeps a correlation key, not a credential.
 *
 *  The domain prefix matters: hashing a bare token would let the digest be matched
 *  against a table of digests computed elsewhere. Salting with a fixed non-secret
 *  string scopes these digests to this one purpose.
 *
 *  Absent/unparseable inputs yield absent fields — never a fabricated placeholder,
 *  because "no account recorded" and "this account" must stay distinguishable. */
export function routeIdentityFromEnv(
  env: Record<string, string | undefined> | undefined,
): { routeHost?: string; accountId?: string } {
  if (!env) return {};
  const out: { routeHost?: string; accountId?: string } = {};
  const base = env.ANTHROPIC_BASE_URL;
  if (base) {
    try {
      out.routeHost = new URL(base).host;
    } catch {
      // Boundary data (a hand-edited workspace.json). An unparseable URL records
      // no host rather than a guessed one — see the Honest Response principle.
    }
  }
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (token) out.accountId = sha256(`ar-account-v1:${token}`).slice(0, 12);
  return out;
}

/** Attached to every infer node's persisted state. Every field beyond the required
 *  five is optional-honest: present iff truthfully known — never a fabricated zero
 *  (mirrors AgentRunUsage, agent-run.ts:110-124). */
export interface InferenceReceipt {
  v: 1;
  kind: "infer";
  nodeId: string;
  nodeType: string;
  at: number;                                  // ms epoch, node settle
  completeness: "rich" | "thin" | "engine-minimal";
  runtime?: "claude" | "grok" | "opencode" | "dispatch" | "fleet-agent";
  /** RUNTIME-REPORTED — the model id the CLI's usage accounting says it dispatched
   *  to. Distinct from config, and distinct AGAIN from what the model says it is.
   *
   *  WHY A WORKER CALLS ITSELF CLAUDE, since this gets misdiagnosed as the model
   *  lying and then quoted as if it were. It is neither a lie nor a hallucination:
   *  it is our own prompt read back to us. A borrowed-route worker is the SAME
   *  `claude` CLI with ANTHROPIC_BASE_URL pointed elsewhere, so the harness composes
   *  its usual system prompt, unaware the weights changed. Captured verbatim by the
   *  traffic mirror (cartridges/traffic-mirror/state/system-prompts/) for qwen-1,
   *  deepseek-dorian and glm-geoff, each of which receives BOTH of:
   *
   *      "You are a Claude agent, built on Anthropic's Claude Agent SDK."   (opening)
   *      "You are powered by the model qwen3.8-max."          (one environment bullet)
   *
   *  So the true model is NOT withheld — it is outvoted. "Claude" appears 28 times
   *  and owns the sentence that says what the agent IS; the real id appears once, in
   *  an enumeration of surroundings. Asked "what are you?", a model answers from the
   *  identity section, because that is the section that answers that question.
   *
   *  The consequence for provenance is structural, not a matter of degree: a worker's
   *  prose identity is a function of OUR prompt assembly, so believing it is
   *  laundering our own input back as evidence. No amount of confidence in the answer
   *  can fix that, which is why no future tier may promote it.
   *
   *  THIS FIELD IS NOT THAT. It comes from the CLI's usage accounting, and on the
   *  real evidence available it is ACCURATE — correctly reporting deepseek-v4-pro,
   *  glm-5.2, k3[1m] and qwen3.8-max on run wf-1786029765267-kcqh14. It is still not
   *  what `familyOf` keys on, for a narrower reason: it is telemetry from the path
   *  being measured (a redirect serving different weights than the id claims is
   *  invisible to it) and it is absent on thin/engine-minimal receipts.
   *  `modelConfigured` is config WE wrote — available earlier, unshapeable by the
   *  upstream. Prefer it; treat this as corroboration worth noticing when it
   *  disagrees, and do not call it a lie. */
  model?: string;
  /** TRUSTED PROVENANCE — the model pin as CONFIGURED (agent:run's `model` param,
   *  or the workerProfile cartridge's ANTHROPIC_MODEL when the param is absent).
   *  Read server-side from our own config, so a model cannot misreport it. This is
   *  the field `familyOf` keys on. */
  modelConfigured?: string;
  /** The cartridge whose upstream route was borrowed for this spawn (agent:run's
   *  `workerProfile`). Config-derived identity for a leg whose weights are not
   *  identifiable from `runtime` alone. */
  workerProfile?: string;
  /** traffic-mirror / compaction container key for this spawn (e.g. seat-kimi@worker
   *  or wf-<corr>-<node>@worker for profile-less agent:run). Observability only. */
  mirrorAgent?: string;
  /** host:port of the upstream this inference was dispatched to — the SHARED
   *  TRANSPORT. Distinct model families reached through one host share every
   *  failure mode at and below that host (the 2026-08-05 traffic-mirror empty-200
   *  incident degraded three "independent" families at once). Never carries a
   *  path, query or credential. */
  routeHost?: string;
  /** Domain-separated SHA-256 prefix of the upstream auth token — an opaque
   *  ACCOUNT correlation key, never the token itself and never reversible to it.
   *  Two receipts sharing an accountId rode one commercial account: one billing
   *  relationship, one rate limiter, one revocation event. Distinct weights behind
   *  a shared accountId are NOT three independent supply chains. */
  accountId?: string;
  agent?: string;                              // fleet agent asked (judge/whisper) — model surrogate
  sessionId?: string | null;                   // resume identity (agent:run)
  /** SHA-256 of the prompt actually hashed. promptScope names WHICH prompt:
   *  "param"     = interpolated node `prompt` param (generic path);
   *  "assembled" = full sent prompt incl. conventions preamble (agent:run self-enrich). */
  promptSha256?: string;
  promptScope?: "param" | "assembled";
  contextSnapshotId?: string;
  conventionsPackage?: string;
  conventionPaths?: string[];
  tools?: string;                              // policy surface, e.g. "ar-tools"
  replyHash?: string;
  replyChars?: number;
  usage?: AgentRunUsage;                       // absent for whisper-based infer — NOT zero
  error?: string;                             // present iff the infer node FAILED
}

/** Denormalized onto a workflow:run (derive) node so the audit answer survives the
 *  child run being pruned (MAX_FINISHED=50). `resolved: false` ⇒ child unreachable;
 *  counts are still authoritative because they were copied at seal time. */
export interface SubRunRollup {
  workflowId: string;
  correlationId: string;
  terminalNodeId?: string;
  resolved: boolean;
  inferCount: number;
  models: string[];
  costUsd?: number;                            // absent if no child receipt carried usage
}

export interface EpistemicsSummary {
  deriveCount: number;
  inferCount: number;                          // counts failed/skipped infer nodes too
  unknownCount: number;
  totalInferCostUsd?: number;                  // absent if NO receipt carried usage
}

/** Minimal node state shape needed by summarize/receiptsFor.
 *  Structurally satisfied by LiveNodeState after the run-store update. */
export interface EpistemicsNode {
  kind?: EpistemicKindResolved;
  nodeType?: string;
  receipt?: InferenceReceipt;
}

/** Compute epistemic summary over a run's node states (pure read, no I/O). */
export function summarizeEpistemics(nodes: Record<string, EpistemicsNode>): EpistemicsSummary {
  let deriveCount = 0, inferCount = 0, unknownCount = 0;
  let totalInferCostUsd: number | undefined;
  for (const st of Object.values(nodes)) {
    if (st.kind === "derive") {
      deriveCount++;
    } else if (st.kind === "infer") {
      inferCount++;
      const cost = st.receipt?.usage?.costUsd;
      if (cost !== undefined) totalInferCostUsd = (totalInferCostUsd ?? 0) + cost;
    } else {
      unknownCount++;
    }
  }
  const summary: EpistemicsSummary = { deriveCount, inferCount, unknownCount };
  if (totalInferCostUsd !== undefined) summary.totalInferCostUsd = totalInferCostUsd;
  return summary;
}

/** How many genuinely uncorrelated sources a run's inferences actually came from.
 *
 *  WHY THIS IS NOT `inferCount`: N agents sampled from one model are ONE opinion
 *  sampled N times, and their agreement is indistinguishable from evidence. A panel
 *  reporting "3 reviewers, complete" while all three share weights is a single point
 *  of failure wearing a rosette. See papers/agentruntime/invariant-3-independent-verification.md.
 *
 *  TWO AXES, because they fail independently:
 *    - `independenceCount` — distinct WEIGHT families. Collapses when legs share a model.
 *    - `supplyChainCount`  — distinct ACCOUNTS. Collapses when distinct families ride
 *      one subscription: on this fleet qwen / deepseek / glm are three families behind
 *      ONE token, so a three-family panel can still have a supply-chain count of 1.
 *      That single account is one rate limiter, one revocation, one mis-cached route.
 *
 *  Three deliberate refusals to inflate:
 *    1. FAILED infer nodes are excluded. A leg that threw produced no verdict, so it
 *       buys no independence — even though summarizeEpistemics counts it in inferCount.
 *    2. UNKNOWN families are counted SEPARATELY and never as independent. An
 *       unidentifiable leg cannot be shown to be uncorrelated with any other.
 *    3. `derive` is NOT folded in as a class. Most derive nodes (core:noop, core:merge)
 *       verify nothing, so crediting a run for having one would manufacture
 *       independence out of plumbing. Earning a derive-class verification signal is
 *       invariant #1's job and is not inferable from node kinds alone. */
export interface IndependenceSummary {
  /** Distinct known weight families among SUCCEEDED infer receipts, sorted. */
  inferFamilies: string[];
  /** `inferFamilies.length`. The number a floor/gate would compare against. */
  independenceCount: number;
  /** Succeeded infer receipts whose family could not be established from config. */
  unknownFamilyCount: number;
  /** Succeeded infer receipts excluded because the node failed. */
  failedInferCount: number;
  /** Distinct known account ids among succeeded infer receipts, sorted. */
  accounts: string[];
  /** `accounts.length`. Absent account ids are NOT counted — see unknownAccountCount. */
  supplyChainCount: number;
  /** Succeeded infer receipts carrying no account id (native legs, legacy runs).
   *  Not merged with each other and not split apart: unprovable either way. */
  unknownAccountCount: number;
  /** Populated ONLY where one account served more than one family — the correlation
   *  a family count alone cannot see. Empty is the good case. */
  sharedAccounts: Array<{ accountId: string; families: string[] }>;
}

/** Compute the independence summary over a run's node states (pure read, no I/O). */
export function summarizeIndependence(nodes: Record<string, EpistemicsNode>): IndependenceSummary {
  const families = new Set<string>();
  const accounts = new Set<string>();
  const byAccount = new Map<string, Set<string>>();
  let unknownFamilyCount = 0, failedInferCount = 0, unknownAccountCount = 0;

  for (const st of Object.values(nodes)) {
    if (st.kind !== "infer" || !st.receipt) continue;
    if (st.receipt.error !== undefined) { failedInferCount++; continue; }

    const family = familyOf(st.receipt);
    if (family === UNKNOWN_FAMILY) unknownFamilyCount++; else families.add(family);

    const accountId = st.receipt.accountId;
    if (accountId === undefined) {
      unknownAccountCount++;
    } else {
      accounts.add(accountId);
      // Unknown-family legs still join the account bucket: they cannot prove
      // independence, but they CAN prove correlation, and that half is knowable.
      let seen = byAccount.get(accountId);
      if (!seen) { seen = new Set<string>(); byAccount.set(accountId, seen); }
      seen.add(family);
    }
  }

  const sharedAccounts: IndependenceSummary["sharedAccounts"] = [];
  for (const [accountId, fams] of byAccount) {
    if (fams.size > 1) sharedAccounts.push({ accountId, families: [...fams].sort() });
  }
  sharedAccounts.sort((a, b) => a.accountId.localeCompare(b.accountId));

  const inferFamilies = [...families].sort();
  const accountList = [...accounts].sort();
  return {
    inferFamilies,
    independenceCount: inferFamilies.length,
    unknownFamilyCount,
    failedInferCount,
    accounts: accountList,
    supplyChainCount: accountList.length,
    unknownAccountCount,
    sharedAccounts,
  };
}

/** Filter infer nodes that have a receipt (pure read, no graph join — nodeType is stored). */
export function receiptsFor(
  nodes: Record<string, EpistemicsNode>,
): Array<{ nodeId: string; nodeType?: string; receipt: InferenceReceipt }> {
  const out: Array<{ nodeId: string; nodeType?: string; receipt: InferenceReceipt }> = [];
  for (const [nodeId, st] of Object.entries(nodes)) {
    if (st.kind === "infer" && st.receipt) {
      out.push({ nodeId, nodeType: st.nodeType, receipt: st.receipt });
    }
  }
  return out;
}

/** Build a generic InferenceReceipt from a node's result.
 *  completeness: "rich" if usage present, "thin" otherwise. */
export function buildInferReceipt(
  nodeType: string,
  nodeId: string,
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  at: number,
): InferenceReceipt {
  const usage = result.usage as AgentRunUsage | undefined;
  const receipt: InferenceReceipt = {
    v: 1, kind: "infer", nodeId, nodeType, at,
    completeness: usage ? "rich" : "thin",
  };
  if (usage) {
    receipt.usage = usage;
    if (usage.model) receipt.model = usage.model;
  }
  if (typeof result.sessionId === "string" || result.sessionId === null) {
    receipt.sessionId = result.sessionId as string | null;
  }
  const promptStr = typeof params.prompt === "string" ? params.prompt : undefined;
  if (promptStr) {
    receipt.promptSha256 = sha256(promptStr);
    receipt.promptScope = "param";
  }
  // Reply chars from reply or reasoning (both optional-honest)
  const replyText = typeof result.reply === "string" ? result.reply
    : typeof result.reasoning === "string" ? result.reasoning
    : undefined;
  if (replyText !== undefined) receipt.replyChars = replyText.length;
  // Runtime and agent — only set when present in params; absent fields never fabricated
  if (typeof params.runtime === "string") {
    const rt = params.runtime;
    if (rt === "claude" || rt === "grok" || rt === "dispatch" || rt === "fleet-agent") {
      receipt.runtime = rt as InferenceReceipt["runtime"];
    }
  }
  if (typeof params.agent === "string") receipt.agent = params.agent;
  // Config-side provenance. `params.model` is the pin WE wrote, so it is trusted for
  // family attribution in a way `usage.model` (set above from the runtime's echo) is
  // not. This generic path cannot resolve routeHost/accountId — those need the
  // profile env, which only the I/O owner (agent-run.ts) holds.
  if (typeof params.model === "string" && params.model !== "") receipt.modelConfigured = params.model;
  if (typeof params.workerProfile === "string" && params.workerProfile !== "") {
    receipt.workerProfile = params.workerProfile;
  }
  return receipt;
}

/** An error that carries the agent session it died in.
 *
 *  `agent:run` learns the session id at the same instant it learns the run failed —
 *  the CLI envelope reports `session_id` alongside `is_error` — but a bare `throw`
 *  drops it, so the completed turns of a deep failure become unresumable. Attaching
 *  it here is what lets the failure receipt (and therefore the run store, which
 *  persists that receipt onto the failed node) keep a resumable handle.
 *
 *  Genuinely optional, and NOT a hidden invariant: the CLI can fail *before* any
 *  session exists (auth rejected at startup), in which case there is nothing to
 *  carry. Boundary data, so it is read defensively rather than asserted. */
export interface SessionBearingError extends Error {
  agentSessionId?: string;
}

/** Read a session id off a thrown value, or undefined when it carries none.
 *  Takes `unknown` because it reads a catch binding at the engine boundary — the
 *  thrown value is not guaranteed to be an Error, or an object at all. */
export function sessionIdFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const id = (error as SessionBearingError).agentSessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Build an engine-minimal failure receipt for an infer node that threw. */
export function buildFailureReceipt(
  nodeType: string,
  nodeId: string,
  params: Record<string, unknown>,
  error: unknown,
  at: number,
): InferenceReceipt {
  const receipt: InferenceReceipt = {
    v: 1, kind: "infer", nodeId, nodeType, at,
    completeness: "engine-minimal",
    error: String(error),
  };
  const promptStr = typeof params.prompt === "string" ? params.prompt : undefined;
  if (promptStr) {
    receipt.promptSha256 = sha256(promptStr);
    receipt.promptScope = "param";
  }
  // Resume identity survives the failure when the thrower attached it. Absent
  // fields are never fabricated (same rule as buildInferReceipt above): a run that
  // died before a session existed reports no sessionId rather than a null-ish one.
  const sessionId = sessionIdFromError(error);
  if (sessionId) receipt.sessionId = sessionId;
  return receipt;
}

/** Denormalize a child run's infer summary onto a workflow:run node so it survives child prune. */
export function buildSubRunRollup(
  childRun: { workflowId: string; correlationId: string; nodes: Record<string, EpistemicsNode> },
  terminalNodeId?: string,
  resolved = true,
): SubRunRollup {
  let inferCount = 0;
  const models: string[] = [];
  let costUsd: number | undefined;
  for (const st of Object.values(childRun.nodes)) {
    if (st.kind === "infer") {
      inferCount++;
      const m = st.receipt?.model;
      if (m && !models.includes(m)) models.push(m);
      // Also pull from multi-model splits
      const splits = st.receipt?.usage?.models;
      if (splits) {
        for (const ms of splits) {
          if (ms.model && !models.includes(ms.model)) models.push(ms.model);
        }
      }
      const cost = st.receipt?.usage?.costUsd;
      if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    }
  }
  const rollup: SubRunRollup = {
    workflowId: childRun.workflowId,
    correlationId: childRun.correlationId,
    terminalNodeId,
    resolved,
    inferCount,
    models,
  };
  if (costUsd !== undefined) rollup.costUsd = costUsd;
  return rollup;
}
