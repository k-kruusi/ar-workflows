/**
 * model:generate — a completion from a cognitive-router TIER, not an agentic loop.
 *
 * This is the transport that lets a LOCAL model (gemma on turboquant, ornith on
 * helmet-fire) be a REVIEWER leg. agent:run speaks claude|grok|opencode
 * (agent-run.ts) and workerProfile needs an Anthropic-protocol upstream; local
 * servers speak OpenAI. cognitive-router already fronts them all behind
 * /generate + a tier table, so this node borrows that abstraction rather than
 * teaching agent:run another transport. A reviewer needs judgment on text it was
 * handed — not tools, not a repo — so a completion is the right shape, and it
 * also dodges the router's /agent → local-stub gap.
 *
 * `infer` in NODE_KINDS. Its receipt keys `modelConfigured` off the tier's model
 * (echoed by our own router), so familyOf resolves it and it folds into the
 * independence accounting exactly like an agent:run leg. Returns `reply` (not
 * `result`) so it is a DROP-IN for an agent:run reviewer leg: a definition reading
 * {{nodes.X.result.reply}} does not change when the seat behind X does.
 *
 * KNOWN LIMITATION, stated not hidden: /generate returns the completion text but
 * NOT finish_reason, so this node can detect a TOTAL truncation (empty text from a
 * reasoning model that spent its whole budget thinking — the guard below) but not a
 * PARTIAL one (a review cut off mid-sentence still arrives as non-empty text).
 * Closing that needs the router to pass finish_reason through; tracked as follow-up.
 */
import { Agent as UndiciAgent } from "undici";
import { defineNode, type NodeDef } from "./contract.js";
import { sha256, type InferenceReceipt } from "../epistemics.js";

/** Undici's 300s headers/body timeouts are NOT the node's timeout — they are a
 *  transport-layer cap this node has no other way to lift. Disabling them hands
 *  timeout authority back to the task-graph engine's node.timeoutMs, which is the
 *  only place a caller can actually see and set it. Module-scope so the connection
 *  pool is shared across nodes rather than rebuilt per call. */
const longRunDispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });

/** Reasoning models (gemma-4 QAT, ornith) emit chain-of-thought BEFORE content, so
 *  a review needs room to think AND answer. Measured: gemma-4-A4B spent ~74 tokens
 *  reasoning before a one-word answer, returning EMPTY content + finish_reason
 *  "length" at maxTokens 16. A reviewer's budget must clear the thinking phase with
 *  margin, so the floor is high on purpose. */
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_ROUTER_URL = "http://localhost:3068";

interface GenerateResponse {
  result?: string;
  provider?: string;
  model?: string;
  tokens?: { input?: number; output?: number };
  latencyMs?: number;
  tier?: string;
}

export const modelNodes: NodeDef[] = [
  defineNode({
    type: "model:generate",
    description:
      "A completion from a cognitive-router TIER (POST /generate). The transport for a " +
      "LOCAL model as a reviewer leg — gemma via the `turboquant` provider, etc. Inputs: " +
      "tier (required — a configured router tier, e.g. 'local-review'; must resolve to a " +
      "provider/model the router knows), prompt (required), maxTokens? (default 4096 — a " +
      "reasoning model must clear its thinking phase before it emits an answer, so keep this " +
      "generous), routerUrl? (default http://localhost:3068). Returns { reply, tier, provider, " +
      "model, tokens, latencyMs } — `reply` mirrors agent:run so this is a drop-in for a " +
      "reviewer leg. HONEST RESPONSE: empty text with output tokens spent is a reasoning model " +
      "exhausting maxTokens before answering — that FAILS the node with an actionable message, " +
      "never returns an empty review as success. `infer` — carries a receipt keyed on the " +
      "tier's model so it counts toward independence.",
    run: async ({ inputs, caps, correlationId, nodeId }) => {
      const tier = inputs.str("tier", { required: true });
      const prompt = inputs.str("prompt", { required: true });
      const maxTokens = inputs.num("maxTokens", { default: DEFAULT_MAX_TOKENS, min: 1, max: 131072 });
      const routerUrl = inputs.str("routerUrl", { default: DEFAULT_ROUTER_URL });
      const endpoint = `${routerUrl.replace(/\/+$/, "")}/generate`;

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier, prompt, maxTokens }),
          // Node 22's built-in fetch is undici, which imposes a 300s headersTimeout
          // and a 300s bodyTimeout REGARDLESS of any node-level timeoutMs. A local
          // reasoning seat routinely generates for longer (measured: gemma-4 at a
          // 32k budget on a 13k-char prompt), so without this dispatcher the socket
          // dies at 5 minutes and the node's own timeout never gets to apply.
          // src/runtimes/providers.ts hit this one layer down and fixes it the same
          // way; this node reached the router by plain fetch and inherited the bug.
          // @ts-expect-error — undici dispatcher accepted by Node.js built-in fetch
          dispatcher: longRunDispatcher,
        });
      } catch (err) {
        // DELIVERY failed — but WHICH delivery failure decides where the caller
        // looks, so do not collapse them. A headers/body timeout means the router
        // was reached and simply took too long; reporting that as "could not reach"
        // sent a full A/B chasing a router that was up and healthy the whole time.
        const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
        if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
          throw new Error(
            `model:generate: tier "${tier}" exceeded the HTTP client timeout talking to ${endpoint} (${code}). ` +
              `The router was REACHED — this is not a connectivity failure. A local reasoning seat can generate ` +
              `for many minutes; raise the node's timeoutMs and re-run.`,
          );
        }
        // Router genuinely unreachable — name the endpoint so the caller knows the
        // router (not the model) is down (localhost binds ::1; 127.0.0.1 conn-fails
        // — the .EVOLVE.md probe-shape trap).
        throw new Error(`model:generate: could not reach cognitive-router at ${endpoint} — ${(err as Error).message}`);
      }

      const bodyText = await res.text();
      if (!res.ok) {
        // The router's 400 leaks the live tier list — surface it verbatim, it is the
        // most actionable thing a caller with a bad tier name can get.
        throw new Error(`model:generate: tier "${tier}" → HTTP ${res.status}: ${bodyText.slice(0, 400)}`);
      }

      let parsed: GenerateResponse;
      try {
        parsed = JSON.parse(bodyText) as GenerateResponse;
      } catch {
        throw new Error(`model:generate: router returned non-JSON for tier "${tier}": ${bodyText.slice(0, 200)}`);
      }

      const reply = typeof parsed.result === "string" ? parsed.result : "";
      const outputTokens = parsed.tokens?.output;
      if (reply.trim() === "") {
        // The failure this node exists to catch: a reasoning model that spent its
        // whole budget thinking and emitted no content. Reported empty text as a 200
        // is the ambiguous-garbage the Honest Response principle forbids.
        const spent = typeof outputTokens === "number" ? `${outputTokens} output token(s) spent` : "output tokens unknown";
        throw new Error(
          `model:generate: tier "${tier}" returned EMPTY text (${spent}, maxTokens ${maxTokens}). ` +
            `A reasoning model likely exhausted its budget before answering — raise maxTokens.`,
        );
      }

      // Rich receipt: modelConfigured is the tier's model as the ROUTER reports it —
      // config we wrote, echoed back, not the model's word for itself. Keys familyOf.
      if (correlationId && nodeId) {
        const receipt: InferenceReceipt = {
          v: 1, kind: "infer", nodeId, nodeType: "model:generate", at: Date.now(),
          completeness: parsed.tokens ? "rich" : "thin",
          promptSha256: sha256(prompt),
          promptScope: "param",
          replyChars: reply.length,
        };
        if (parsed.model) { receipt.modelConfigured = parsed.model; receipt.model = parsed.model; }
        // routeHost is the router, not the true upstream — the router abstracts which
        // box actually served this. A local seat's host-as-account key is therefore
        // NOT knowable here (honest absence → unknownAccountCount), which is correct:
        // "served locally, host unknown through the router" is the true state.
        try { receipt.routeHost = new URL(routerUrl).host; } catch { /* leave absent */ }
        caps.receipt.capture(correlationId, nodeId, receipt);
      }

      return {
        reply,
        tier: parsed.tier ?? tier,
        provider: parsed.provider ?? null,
        model: parsed.model ?? null,
        tokens: parsed.tokens ?? null,
        latencyMs: parsed.latencyMs ?? null,
      };
    },
  }),
];
