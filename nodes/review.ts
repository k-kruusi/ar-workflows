/**
 * review:anchor-check — validate plain file:line citations in reviewer output
 * before the coder consumes them.
 *
 * Reviewers are prompted to cite file:line for each discipline issue. A
 * hallucinated citation (referencing a non-existent file or out-of-range line)
 * burns a coder revision turn against a phantom. This node intercepts the
 * reviewer reply, resolves each plain citation against the working directory,
 * and annotates unresolvable ones with
 * [UNVERIFIED CITATION: <token> does not resolve]
 * so the coder can see through them while still reading the finding.
 *
 * Full receipt tokens (path:Lx-Ly@commit#hash, gated at safe-commit) are
 * left untouched — the negative lookahead (?!@) excludes them.
 */
// PLAIN_CITE_RE (and its receipt-excluding lookahead) plus the resolver were
// extracted to dependencies/cite-harvest so this node and the claims-verify
// seam share one citation-regex source. Behavior is byte-identical.
import { PLAIN_CITE_RE, resolvesCitation } from "@agentruntime/cite-harvest";
import { defineNode, type NodeDef } from "./contract.js";

export const reviewNodes: NodeDef[] = [
  defineNode({
    type: "review:anchor-check",
    description:
      "Validates plain file:line citations in reviewer prose against cwd. " +
      "Unresolvable ones are annotated [UNVERIFIED CITATION: <token> does not resolve]. " +
      "Full receipt tokens (path:Lx@commit#hash) are left to the safe-commit gate. " +
      "No citations → annotatedText === text (byte-identical, constraint). " +
      "Resolver failure → text passed through unannotated (never blocks the gauntlet). " +
      "Inputs: text (reviewer reply), cwd. " +
      "Output: { annotatedText, citationCount, unresolvedCount }.",
    run: async ({ inputs, caps }) => {
      const text = inputs.str("text", { required: true });
      const cwd = inputs.str("cwd", { required: true });

      try {
        // Fresh RegExp each call so lastIndex starts at 0.
        const re = new RegExp(PLAIN_CITE_RE.source, "g");
        const matches = [...text.matchAll(re)];

        // Constraint: no citations → return text unchanged (byte-identical).
        if (matches.length === 0) {
          return { annotatedText: text, citationCount: 0, unresolvedCount: 0 };
        }

        let annotated = "";
        let lastIndex = 0;
        let unresolvedCount = 0;

        for (const match of matches) {
          const [token, path, lineRef] = match;
          if (typeof match.index !== "number") throw new Error("matchAll always populates index on every successful match — ECMAScript spec");
          const idx = match.index;

          annotated += text.slice(lastIndex, idx);

          if (!resolvesCitation(cwd, path, lineRef)) {
            unresolvedCount++;
            annotated += `${token} [UNVERIFIED CITATION: ${token} does not resolve]`;
          } else {
            annotated += token;
          }

          lastIndex = idx + token.length;
        }

        annotated += text.slice(lastIndex);
        return { annotatedText: annotated, citationCount: matches.length, unresolvedCount };
      } catch (e) {
        // Constraint: any resolver failure passes text through unannotated — never blocks.
        const msg = e instanceof Error ? e.message : String(e);
        caps.log("warn", "anchor_check_failed", { error: msg, cwd });
        return { annotatedText: text, citationCount: 0, unresolvedCount: 0 };
      }
    },
  }),

  defineNode({
    type: "review:verdict",
    description:
      "Parses a reviewer's LEADING verdict token into a branchable boolean, so an edge can gate on it. " +
      'Approving verdicts: APPROVE, NO-VETO. Blocking: REJECT, VETO, ESCALATE. ' +
      "Output: { verdict, approved, blocked, reason } — `reason` is the reviewer's justification " +
      "(text after the token, truncated at 2000 chars), carried on the result so a blocked run " +
      "records WHY in its own trace rather than only in an opt-in notify. " +
      "FAIL-CLOSED: an absent or unrecognized leading token THROWS — it never degrades to approved:true, " +
      "so a reviewer that ignored its output contract fails the run loudly instead of silently shipping. " +
      "Only the FIRST token counts; a verdict buried mid-reply is not a verdict. " +
      "Inputs: text (reviewer reply, or the anchor-checked annotatedText — annotation only ever appends " +
      "after a citation, so the leading token survives it). " +
      'Wire as: { from: "<verdict-node>", to: "ship", condition: "nodes.<verdict-node>.result.approved === true" } ' +
      "plus a blocked-branch edge on approved === false.",
    run: async ({ inputs, caps }) => {
      const text = inputs.str("text", { required: true });

      // Strip only PRESENTATION before reading the token: leading whitespace, and
      // the markdown a reviewer may wrap it in (**APPROVE**, `REJECT`, > VETO, # APPROVE).
      // Deliberately NOT a search — anchoring at the start is what makes a verdict
      // buried in prose fail closed instead of passing.
      const leading = text.replace(/^[\s>#*_`"'\-[\]()]+/, "");
      const match = /^([A-Za-z]+(?:-[A-Za-z]+)?)/.exec(leading);
      if (!match) {
        throw new Error(
          `review:verdict: reply does not begin with a verdict token — reviewers are prompted "your reply MUST BEGIN with exactly one token". Got: ${JSON.stringify(text.slice(0, 120))}`,
        );
      }

      const verdict = match[1].toUpperCase();
      // NO-VETO is the gracián reviewer's pass (skills/veto_on.md): that reviewer has
      // no APPROVE verb, so passing is the ABSENCE of veto. Matched before VETO —
      // the hyphenated alternative in the regex above keeps them distinct tokens.
      const APPROVING = new Set(["APPROVE", "NO-VETO"]);
      const BLOCKING = new Set(["REJECT", "VETO", "ESCALATE"]);

      if (!APPROVING.has(verdict) && !BLOCKING.has(verdict)) {
        throw new Error(
          `review:verdict: leading token "${verdict}" is not a known verdict (approving: ${[...APPROVING].join(", ")}; blocking: ${[...BLOCKING].join(", ")}). Refusing to guess — an unreadable verdict must not read as approval.`,
        );
      }

      const approved = APPROVING.has(verdict);
      // The reviewer's justification, carried on the RESULT rather than left only
      // in a sibling notify node. A notify is opt-in (it no-ops when the caller
      // passed no agent), so without this a blocked run records THAT it was
      // blocked at a node that does not say WHY — and the reason is the whole
      // point of blocking. Truncated: this is a record, not the transcript.
      const rest = leading.slice(match[1].length).replace(/^[\s:,.—-]+/, "").trim();
      const reason = rest.length > 2000 ? `${rest.slice(0, 2000)}… (truncated)` : rest;
      caps.log("info", "review_verdict", { verdict, approved });
      return { verdict, approved, blocked: !approved, reason };
    },
  }),
];
