/**
 * Agent primitives — sense and act on a fleet agent through injected caps.
 * These are the building blocks of the poke/watchdog: agent:state is the SENSE
 * step, agent:whisper is the ACT step (guarded so it never floods a busy queue).
 */
import { defineNode, isQueueAck, type NodeDef } from "./contract.js";

export const agentNodes: NodeDef[] = [
  defineNode({
    type: "agent:state",
    description: "Senses a fleet agent: { status, isProcessing, messagesHandled, uptimeMs }. The watchdog's read step.",
    run: async ({ inputs, caps }) => {
      const agent = inputs.str("agent", { required: true });
      const state = caps.agentState(agent);
      if (!state) throw new Error(`agent:state: unknown agent "${agent}"`);
      return { ...state };
    },
  }),

  defineNode({
    type: "agent:whisper",
    description: "Sends a message to a fleet agent, returns { agent, reply }. Throws if the agent is BUSY (queued, not answered) — never poke/flood a live queue; sense first.",
    run: async ({ inputs, caps }) => {
      const agent = inputs.str("agent", { required: true });
      const message = inputs.str("message", { required: true });
      const reply = await caps.whisper(agent, message);
      if (isQueueAck(reply)) {
        throw new Error(
          `agent:whisper: "${agent}" is busy — message queued, not answered ("${reply.slice(0, 80)}"). Sense with agent:state first, or target an idle agent.`,
        );
      }
      return { agent, reply };
    },
  }),

  // Fire-and-forget delivery for notifications (a job's result). Dispatches and
  // returns immediately WITHOUT awaiting the recipient — unlike agent:whisper,
  // which AWAITS the reply and times out the node if the recipient is busy (the
  // live exec-notify bug). supervisor:send is fire-and-forget too now, but it
  // returns { sent } rather than a reply, and skips the condense hop. This is the
  // right whisper node for "run a task → tell someone the result".
  defineNode({
    type: "agent:notify",
    description:
      "Delivers a message into an agent's conversation FIRE-AND-FORGET: delivery to the recipient does not await a reply, but this node MAY await condense first (quarantine silo, up to ~120s). Set the graph node timeoutMs >= 180000 when condense is on (see exec-notify blueprint). " +
      "By default `condense` is true — long or repetitive noisy output is condensed before delivery; pass condense:false for the raw message. Optional `task` / `minChars`. " +
      "SYNC-RUN AWARE: on a synchronous `POST /workflow` (the caller already gets the full trace inline) this no-ops with { skipped:'sync_run' } to avoid echoing the same content back — pass `always:true` to force delivery even on a sync run. A CANCELLED run no-ops with { skipped:'run_cancelled' } (no stale 'finished' whisper). " +
      "EMPTY/absent agent → no-op ({ dispatched:false }). UNKNOWN agent throws before condense runs. " +
      "TEMPLATES in message: {{run.correlationId}}, {{run.workflowId}}, {{run.workflowName}}, {{nodes.<id>.result.*}}, {{params.*}}. " +
      "{{run.status}} is NOT in scope — at notify-node time the run is still in-flight; unresolved paths stay literal so a typo is visible. " +
      "For terminal status after settle, use POST /workflow body notify (fireNotify), not agent:notify.",
    run: async ({ inputs, caps, correlationId }) => {
      const agent = inputs.str("agent");
      const message = inputs.str("message", { required: true });
      const condense = inputs.bool("condense", { default: true });
      const always = inputs.bool("always", { default: false });
      const task = inputs.str("task");
      const minChars = inputs.has("minChars") ? inputs.num("minChars", { min: 1 }) : undefined;
      // A cancelled run must not fire a now-stale notification (a "✅ finished" whisper
      // for a run the operator killed). Suppress before touching the recipient.
      if (correlationId && caps.run.isCancelled(correlationId)) {
        return { agent, dispatched: false, skipped: "run_cancelled" };
      }
      // Self-echo guard: a SYNC run returns the whole trace to its caller inline, so a
      // notify here would deliver the SAME content a second time (5 redundant echoes
      // in one session, observed live). No-op on sync unless the node opts in with
      // always:true. Async runs (the whole point of notify) are unaffected.
      if (!always && correlationId && caps.run.mode(correlationId) === "sync") {
        return { agent, dispatched: false, skipped: "sync_run" };
      }
      if (!agent) {
        return { agent: "", dispatched: false, reason: "no agent configured — notify skipped" };
      }
      if (!caps.agentState(agent)) {
        throw new Error(`agent:notify: unknown agent "${agent}"`);
      }
      const { condenseNotifyMessage } = await import("../notify-condense.js");
      const condensed = await condenseNotifyMessage(message, condense, { task: task || undefined, minChars });
      const delivery = caps.notify(agent, condensed.text);
      return {
        agent,
        ...delivery,
        condensed: condensed.condensed,
        ...(condensed.skipped ? { condenseSkipped: condensed.skipped } : {}),
        ...(condensed.passThrough ? { condensePassThrough: condensed.passThrough } : {}),
        ...(condensed.droppedBytes != null ? { condenseDroppedBytes: condensed.droppedBytes } : {}),
        ...(condensed.originalBytes != null ? { originalBytes: condensed.originalBytes } : {}),
        ...(condensed.condensedBytes != null ? { condensedBytes: condensed.condensedBytes } : {}),
      };
    },
  }),

  // Migrated from handlers.ts — identical contract (param "prompt", returns
  // { agent, reply }) so the research-loop's debate-refine round is unchanged.
  // agent:whisper is the same primitive with param "message"; agent:ask is kept
  // distinct for the existing definitions/tests that speak "prompt".
  defineNode({
    type: "agent:ask",
    description: "Sends a prompt to a fleet agent and returns { agent, reply }. Throws if the agent is busy (queue-ack). Used by the research loop's debate-refine round.",
    run: async ({ inputs, caps }) => {
      const agent = inputs.str("agent", { required: true });
      const prompt = inputs.str("prompt", { required: true });
      const reply = await caps.whisper(agent, prompt);
      if (isQueueAck(reply)) {
        throw new Error(
          `agent:ask: "${agent}" is busy — message queued, not answered ("${reply.slice(0, 80)}"). Target an idle agent.`,
        );
      }
      return { agent, reply };
    },
  }),
];
