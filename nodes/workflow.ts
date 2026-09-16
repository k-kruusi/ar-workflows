/**
 * workflow.ts — the `workflow:run` node: DAG-of-DAGs composition.
 *
 * Runs another workflow (named via `workflow`, or inline via `graph`) as a single
 * node, waits for it to settle, and surfaces its terminal node's result as this
 * node's own result — so `{{nodes.<id>.result.<field>}}` reads straight through
 * exactly as it would for a plain `agent:run` node. This is what lets a thin
 * "task-master" graph point at `adversarial-design` then `review-gauntlet`
 * without inlining either one's internal node chain.
 *
 * All the nesting-depth bookkeeping (the guard against runaway/cyclic recursion)
 * lives inside `caps.workflow` (a closure over WorkflowRunner's private
 * `invokeNested`) — this node never sees or threads a depth value itself.
 */
import type { TaskGraph } from "@agentruntime/task-graph";
import { defineNode, type NodeDef } from "./contract.js";

/** A terminal node is one with no outgoing edges — absent from every `edge.from`. */
function terminalNodeIds(graph: TaskGraph): string[] {
  const fromSet = new Set(graph.edges.map((e) => e.from));
  return graph.nodes.filter((n) => !fromSet.has(n.id)).map((n) => n.id);
}

export const workflowNodes: NodeDef[] = [
  defineNode({
    type: "workflow:run",
    description:
      "Runs another workflow (named via `workflow`, or inline via `graph`) as a single node. " +
      "Waits for completion and surfaces the terminal node's result as this node's own result, " +
      "so {{nodes.<id>.result.<field>}} reads straight through. Optional `resultNode` names which " +
      "terminal to surface when the sub-graph has more than one. IMPORTANT: set this node's own " +
      "timeoutMs generously — it wraps the ENTIRE sub-workflow's runtime (default 30s will not work).",
    run: async ({ inputs, caps, correlationId }) => {
      const workflowId = inputs.has("workflow") ? inputs.str("workflow") : undefined;
      const inlineGraph = inputs.has("graph") ? inputs.obj<TaskGraph>("graph") : undefined;
      const subParams = inputs.obj("params", { default: {} });
      const resultNodeOverride = inputs.has("resultNode") ? inputs.str("resultNode") : undefined;

      if (!workflowId && !inlineGraph) {
        throw new Error('workflow:run: provide "workflow" (named) or "graph" (inline)');
      }
      if (workflowId && inlineGraph) {
        throw new Error('workflow:run: provide "workflow" or "graph", not both');
      }
      if (!correlationId) {
        throw new Error("workflow:run: missing correlationId — this node must execute inside a tracked run");
      }

      // --- Pre-flight: derive terminal node(s) BEFORE running the sub-workflow ---
      const graphForTerminals = inlineGraph ?? caps.workflow.describe(workflowId!);
      if (!graphForTerminals) {
        throw new Error(`workflow:run: unknown workflow "${workflowId}" (not found in definitions)`);
      }

      let terminalId: string;
      if (resultNodeOverride) {
        if (!graphForTerminals.nodes.some((n) => n.id === resultNodeOverride)) {
          throw new Error(
            `workflow:run: resultNode "${resultNodeOverride}" does not exist in sub-workflow "${graphForTerminals.id}" ` +
              `(available: ${graphForTerminals.nodes.map((n) => n.id).join(", ")})`,
          );
        }
        terminalId = resultNodeOverride;
      } else {
        const terminals = terminalNodeIds(graphForTerminals);
        if (terminals.length !== 1) {
          throw new Error(
            `workflow:run: sub-workflow "${graphForTerminals.id}" has ${terminals.length} terminal node(s) ` +
              `(${terminals.join(", ") || "none"}) — set "resultNode" to specify which one to surface`,
          );
        }
        terminalId = terminals[0];
      }

      // --- Execute the sub-workflow ---
      const trace = inlineGraph
        ? await caps.workflow.runGraph(inlineGraph, subParams, correlationId)
        : await caps.workflow.run(workflowId!, subParams, correlationId);

      // --- Failure propagation ---
      // Refuse on anything but a NATURALLY-completed run. Since issue #655,
      // execGraph stamps control-state terminals ("cancelled"/"paused", or
      // "failed" from a tripped budget) onto the returned trace when its halt
      // gate stopped dispatch mid-run — the engine alone computes status from
      // recorded results, so such a half-run used to arrive here reading
      // "completed" and surface to the parent as legitimate success.
      if (trace.status !== "completed") {
        const failed = trace.nodeResults
          .filter((r) => r.status === "failed" || r.status === "timed_out")
          .map((r) => `${r.nodeId}: ${r.error ?? r.status}`);
        const halted =
          trace.status === "cancelled" || trace.status === "paused"
            ? ` — halted mid-run by operator ${trace.status}; undispatched nodes are absent from the trace, resumable via correlationId ${trace.correlationId}`
            : "";
        throw new Error(
          `workflow:run: sub-workflow "${trace.workflowId}" did not complete ` +
            `(status: ${trace.status}${failed.length ? `, failed nodes: ${failed.join("; ")}` : ""}${halted})`,
        );
      }

      // --- Extract terminal node's result ---
      const terminalResult = trace.nodeResults.find((r) => r.nodeId === terminalId);
      if (!terminalResult?.result) {
        throw new Error(
          `workflow:run: terminal node "${terminalId}" produced no result in ` +
            `"${trace.workflowId}" (run ${trace.correlationId})`,
        );
      }

      return {
        ...(terminalResult.result as Record<string, unknown>),
        __wfMeta: {
          workflowId: trace.workflowId,
          correlationId: trace.correlationId,
          terminalNodeId: terminalId,
        },
      };
    },
  }),
];
