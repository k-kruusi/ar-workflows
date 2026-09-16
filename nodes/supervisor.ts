/**
 * Supervisor primitives — container lifecycle ops as nodes. Migrated from
 * handlers.ts under their existing type strings + result shapes. Each is a thin
 * node over caps.supervisor.* (the one place that touches the container runtime),
 * so the node files stay pure.
 */
import { defineNode, type NodeDef } from "./contract.js";

export const supervisorNodes: NodeDef[] = [
  defineNode({
    type: "noop",
    description: "Does nothing; returns { ok:true }. (Legacy alias of core:noop.)",
    run: async () => ({ ok: true }),
  }),

  defineNode({
    type: "supervisor:cancel",
    description: "Cancel the target container's in-flight request.",
    run: async ({ inputs, caps }) => caps.supervisor.cancel(inputs.str("name", { required: true })),
  }),

  defineNode({
    type: "supervisor:resetConversation",
    description: "Reset the target's conversation; returns { ok, previousSession }.",
    run: async ({ inputs, caps }) =>
      caps.supervisor.resetConversation(inputs.str("name", { required: true }), inputs.bool("hasArtifact")),
  }),

  defineNode({
    type: "supervisor:clearSessionFile",
    description: "Clear the target's persisted session file.",
    run: async ({ inputs, caps }) => caps.supervisor.clearSessionFile(inputs.str("name", { required: true })),
  }),

  defineNode({
    type: "supervisor:flushStats",
    description: "Flush container stats to disk.",
    run: async ({ caps }) => caps.supervisor.flushStats(),
  }),

  defineNode({
    type: "supervisor:send",
    description: "Send to a container WITHOUT awaiting a reply — fire-and-forget: `sent:true` means ENQUEUED, not read or answered, so a recipient that works for 20 minutes cannot time this node out. Returns { sent, reason? } (sent:false + reason when the target is not running). Does not reject a busy queue-ack (cf. agent:whisper, which does await).",
    run: async ({ inputs, caps }) =>
      caps.supervisor.send(inputs.str("name", { required: true }), inputs.str("message", { required: true })),
  }),

  defineNode({
    type: "supervisor:start",
    description: "Start a container.",
    run: async ({ inputs, caps }) => caps.supervisor.start(inputs.str("name", { required: true })),
  }),

  defineNode({
    type: "supervisor:stop",
    description: "Stop a container.",
    run: async ({ inputs, caps }) => caps.supervisor.stop(inputs.str("name", { required: true })),
  }),
];
