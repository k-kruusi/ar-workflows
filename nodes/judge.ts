/**
 * Judge primitive — asks an agent to score, parses a leading 0..1 metric from the
 * reply. The metric is a loop's ratchet. LLM grades are ADVISORY only (no single
 * LLM is a clean gate); the parsed number drives keep/discard, not a hard verdict.
 * Migrated from handlers.ts — same type string + { metric, reasoning } shape.
 */
import { defineNode, isQueueAck, type NodeDef } from "./contract.js";

export const judgeNodes: NodeDef[] = [
  defineNode({
    type: "judge:score",
    description: "Asks an agent to score; parses a leading 0..1 metric from the reply (the loop's ratchet). LLM grades are advisory.",
    run: async ({ inputs, caps }) => {
      const agent = inputs.str("agent", { required: true });
      const prompt = inputs.str("prompt", { required: true });
      const reply = await caps.whisper(agent, prompt);
      if (isQueueAck(reply)) {
        throw new Error(`judge:score: "${agent}" is busy — message queued, not answered. Target an idle agent.`);
      }
      // First number in [0,1] from the reply (e.g. "0.72 — because ...").
      const m = reply.match(/(?:^|[^\d.])(0(?:\.\d+)?|1(?:\.0+)?)(?![\d.])/);
      const metric = m ? Number(m[1]) : null;
      if (metric === null) {
        throw new Error(`judge:score: could not parse a 0..1 score from the agent reply: "${reply.slice(0, 120)}"`);
      }
      return { metric, reasoning: reply };
    },
  }),
];
