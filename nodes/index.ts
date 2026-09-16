/**
 * The workflow-node library: the shared contract + every composable primitive.
 *
 * registerNodes() folds every node onto a NodeRegistry with caps built from the
 * supervisor's WorkflowDeps. This is now the SINGLE registration path — the old
 * in-line handlers.ts has been retired; its nodes were ported onto the contract
 * (see core/demo/agent/judge/supervisor.ts) under their existing type strings, so
 * nothing in the definitions, the research loop, or the demo DAG changed.
 *
 * Adding a node later: write a defineNode({ type, run }) in the relevant file
 * (or a new file), add it to that file's exported array, and it registers here.
 */
import type { NodeRegistry } from "@agentruntime/task-graph";
import type { WorkflowOutputStore } from "../output-store.js";
import { registerNodeDefs, type RunControlCaps, type WorkflowInvoker, type ReceiptCaps } from "./contract.js";
import { buildCaps, type WorkflowDeps } from "./caps.js";
import { coreNodes } from "./core.js";
import { demoNodes } from "./demo.js";
import { agentNodes } from "./agent.js";
import { agentRunNodes } from "./agent-run.js";
import { judgeNodes } from "./judge.js";
import { coverageNodes } from "./coverage.js";
import { supervisorNodes } from "./supervisor.js";
import { workflowNodes } from "./workflow.js";
import { reviewNodes } from "./review.js";
import { routeNodes } from "./route.js";
import { modelNodes } from "./model.js";
import { epistemicsFloorNodes } from "./epistemics-floor.js";
import { graphNodes } from "./graph.js";

/** Every primitive shipped in this folder, in registration order. */
export const allNodeDefs = [
  ...coreNodes,
  ...demoNodes,
  ...agentNodes,
  ...agentRunNodes,
  ...judgeNodes,
  ...coverageNodes,
  ...supervisorNodes,
  ...workflowNodes,
  ...reviewNodes,
  ...routeNodes,
  ...modelNodes,
  ...epistemicsFloorNodes,
  ...graphNodes,
];

export function registerNodes(
  registry: NodeRegistry,
  deps: WorkflowDeps,
  dataDir: string,
  outputStore?: WorkflowOutputStore,
  runControl?: RunControlCaps,
  workflowInvoker?: WorkflowInvoker,
  receiptCaps?: ReceiptCaps,
): void {
  const caps = buildCaps(deps, dataDir, outputStore, runControl, workflowInvoker, receiptCaps);
  registerNodeDefs(registry, allNodeDefs, caps);
}

/** Every node module and the NodeDef array it exports.
 *
 *  Deliberately duplicated beside the static imports above: add a node file, add it
 *  in BOTH places. The static list is what the process loads at startup; this one is
 *  what a HOT RELOAD re-reads. `loadAllNodeDefs` fails loud on a missing export, so
 *  a file added here but not exporting the named array is caught immediately. */
const NODE_MODULES: ReadonlyArray<readonly [string, string]> = [
  ["./core.js", "coreNodes"],
  ["./demo.js", "demoNodes"],
  ["./agent.js", "agentNodes"],
  ["./agent-run.js", "agentRunNodes"],
  ["./judge.js", "judgeNodes"],
  ["./coverage.js", "coverageNodes"],
  ["./supervisor.js", "supervisorNodes"],
  ["./workflow.js", "workflowNodes"],
  ["./review.js", "reviewNodes"],
  ["./route.js", "routeNodes"],
  ["./model.js", "modelNodes"],
  ["./epistemics-floor.js", "epistemicsFloorNodes"],
  ["./graph.js", "graphNodes"],
];

/**
 * Re-import every node module, optionally with a cache-bust token.
 *
 * WHY THIS EXISTS: `reloadNodes` used to `import("./nodes/index.js?v=<bust>")` and call
 * `registerNodes`. That busts the ESM cache for index.js ONLY — index.js then imports
 * "./core.js" and "./agent-run.js" with PLAIN specifiers, which resolve to the modules
 * already in the cache. So a hot reload re-read the index and silently re-registered
 * STALE handlers, while reporting ok. Observed 2026-08-10: two engine fixes were built
 * into dist, /nodes/reload returned ok, and both were still absent from the running
 * registry. A reload that reports success and changes nothing is worse than one that
 * refuses — it makes the code you are looking at and the code that runs disagree.
 *
 * The bust has to be applied to EACH module, which is why the list above exists.
 */
export async function loadAllNodeDefs(bust?: string): Promise<typeof allNodeDefs> {
  const q = bust ? `?v=${encodeURIComponent(bust)}` : "";
  const out: typeof allNodeDefs = [];
  for (const [spec, exportName] of NODE_MODULES) {
    const mod = (await import(spec + q)) as Record<string, unknown>;
    const defs = mod[exportName];
    if (!Array.isArray(defs)) {
      throw new Error(
        `loadAllNodeDefs: ${spec} does not export an array named "${exportName}" — ` +
          `NODE_MODULES is out of sync with the module's exports.`,
      );
    }
    out.push(...(defs as typeof allNodeDefs));
  }
  return out;
}

/** registerNodes, but re-reading every node module from disk under `bust`. */
export async function registerNodesFresh(
  registry: NodeRegistry,
  deps: WorkflowDeps,
  dataDir: string,
  outputStore?: WorkflowOutputStore,
  runControl?: RunControlCaps,
  workflowInvoker?: WorkflowInvoker,
  receiptCaps?: ReceiptCaps,
  bust?: string,
): Promise<void> {
  const caps = buildCaps(deps, dataDir, outputStore, runControl, workflowInvoker, receiptCaps);
  registerNodeDefs(registry, await loadAllNodeDefs(bust), caps);
}

export * from "./contract.js";
export { buildCaps, type WorkflowDeps } from "./caps.js";
export { coreNodes } from "./core.js";
export { demoNodes } from "./demo.js";
export { agentNodes } from "./agent.js";
export { agentRunNodes } from "./agent-run.js";
export { judgeNodes } from "./judge.js";
export { coverageNodes } from "./coverage.js";
export { supervisorNodes } from "./supervisor.js";
export { workflowNodes } from "./workflow.js";
export { reviewNodes } from "./review.js";
export { routeNodes } from "./route.js";
export { modelNodes } from "./model.js";
export { epistemicsFloorNodes } from "./epistemics-floor.js";
