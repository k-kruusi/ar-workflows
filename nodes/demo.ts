/**
 * Demo primitives — drive the demo-progress DAG (live run view + resume) without a
 * GPU. Migrated from handlers.ts under their existing type strings + result shapes
 * so the demo-progress definition and the run-store resume test are unchanged.
 * (core:delay / core:gate are the go-forward general versions; these stay for the
 * demo's exact contract.)
 */
import { existsSync } from "node:fs";
import { defineNode, type NodeDef } from "./contract.js";

export const demoNodes: NodeDef[] = [
  defineNode({
    type: "demo:delay",
    description: "Demo: sleeps `ms` (clamped 0…600000), returns { sleptMs }.",
    run: async ({ inputs }) => {
      const ms = inputs.num("ms", { default: 1000, min: 0, max: 600_000 });
      await new Promise((r) => setTimeout(r, ms));
      return { sleptMs: ms };
    },
  }),

  defineNode({
    type: "demo:gate",
    description: "Demo: succeeds iff a sentinel file exists, else throws — the resume-from-failure demonstration.",
    run: async ({ inputs }) => {
      const sentinel = inputs.str("sentinel");
      if (sentinel && existsSync(sentinel)) return { gate: "open", sentinel };
      throw new Error(`gate closed: sentinel not found (${sentinel || "<none provided>"})`);
    },
  }),
];
