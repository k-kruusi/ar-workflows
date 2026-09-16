import type { TaskGraph } from "@agentruntime/task-graph";

/** What the validator needs to know about registered node types — the runner's
 *  NodeRegistry satisfies this structurally. */
export interface NodeTypeLookup {
  has(type: string): boolean;
  types(): string[];
}

// The ENVELOPE: every structural field a definition may carry. This is the whole
// scope — node `params` CONTENTS are each handler's own boundary (typed inputs
// with honest errors in nodes/contract.ts), so no per-node param schemas here.
//
// Top-level "params" is tolerated: it isn't read by the engine, but definitions
// in the wild (skill-evolution.json) use it to document their expected run
// params, and those graphs are valid.
const GRAPH_KEYS = new Set(["id", "name", "description", "nodes", "edges", "params", "resultNode"]);
const NODE_KEYS = new Set(["id", "type", "params", "meta", "retries", "timeoutMs"]);
const EDGE_KEYS = new Set(["from", "to", "condition", "on"]);
const EDGE_ON = new Set(["success", "failure", "always"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Definition-time envelope validation for a workflow graph. Runs at LOAD (file
 * scan) and at every execution entry (inline graphs) — BEFORE the run store is
 * initialized and before any node executes, so a typo'd field, an unknown node
 * type, or a dangling edge fails with a clear, named error instead of mid-run
 * after real token spend.
 *
 * This is a system BOUNDARY (deserialized JSON from definition files and HTTP
 * bodies), so it validates defensively rather than asserting. It deliberately
 * does NOT re-implement what task-graph's validate() already rejects at execute
 * start (duplicate node ids, cycles) — that check still runs pre-dispatch. The
 * dangling-edge check IS repeated here because the node-id set is already in
 * hand and failing at file-load keeps a broken definition out of the registry
 * entirely (warn + skip) instead of failing on every run.
 *
 * All problems are collected and reported in one error, so a definition author
 * fixes the file in one pass instead of replaying whack-a-mole.
 */
export function validateEnvelope(value: unknown, nodeTypes: NodeTypeLookup): TaskGraph {
  if (!isPlainObject(value)) {
    throw new Error(
      "Invalid workflow definition: expected a JSON object with { id, name, description, nodes, edges }",
    );
  }
  const problems: string[] = [];

  for (const key of Object.keys(value)) {
    if (!GRAPH_KEYS.has(key)) {
      problems.push(`unknown top-level field "${key}" (allowed: ${[...GRAPH_KEYS].join(", ")})`);
    }
  }
  for (const field of ["id", "name", "description"] as const) {
    if (typeof value[field] !== "string") problems.push(`"${field}" must be a string`);
  }
  if (typeof value.id === "string" && value.id.trim() === "") problems.push(`"id" must be non-empty`);

  const nodeIds = new Set<string>();
  if (!Array.isArray(value.nodes)) {
    problems.push(`"nodes" must be an array`);
  } else {
    for (const [i, node] of value.nodes.entries()) {
      if (!isPlainObject(node)) {
        problems.push(`nodes[${i}] must be an object`);
        continue;
      }
      const label = typeof node.id === "string" && node.id ? `node "${node.id}"` : `nodes[${i}]`;
      for (const key of Object.keys(node)) {
        if (!NODE_KEYS.has(key)) {
          problems.push(`${label}: unknown field "${key}" (allowed: ${[...NODE_KEYS].join(", ")})`);
        }
      }
      if (typeof node.id !== "string" || node.id.trim() === "") {
        problems.push(`nodes[${i}]: "id" must be a non-empty string`);
      } else {
        nodeIds.add(node.id);
      }
      if (typeof node.type !== "string" || node.type === "") {
        problems.push(`${label}: "type" must be a non-empty string`);
      } else if (!nodeTypes.has(node.type)) {
        problems.push(
          `${label}: unknown node type "${node.type}" — registered types: ${nodeTypes.types().sort().join(", ")}`,
        );
      }
      if (!isPlainObject(node.params)) {
        problems.push(`${label}: "params" must be an object (use {} for a node with no params)`);
      }
      if (node.meta !== undefined && !isPlainObject(node.meta)) {
        problems.push(`${label}: "meta" must be an object`);
      }
      for (const numField of ["retries", "timeoutMs"] as const) {
        if (node[numField] !== undefined && !Number.isFinite(node[numField])) {
          problems.push(`${label}: "${numField}" must be a finite number`);
        }
      }
    }
  }

  // The output contract: resultNode, when declared, must name a real node —
  // a typo here fails every run_workflow_result call with a "produced no
  // result" mystery instead of naming the mistake at load time.
  if (value.resultNode !== undefined) {
    if (typeof value.resultNode !== "string") {
      problems.push(`"resultNode" must be a string`);
    } else if (!nodeIds.has(value.resultNode)) {
      problems.push(`"resultNode" references unknown node "${value.resultNode}"`);
    }
  }

  if (!Array.isArray(value.edges)) {
    problems.push(`"edges" must be an array`);
  } else {
    for (const [i, edge] of value.edges.entries()) {
      if (!isPlainObject(edge)) {
        problems.push(`edges[${i}] must be an object`);
        continue;
      }
      const label = typeof edge.from === "string" && typeof edge.to === "string"
        ? `edge "${edge.from}" -> "${edge.to}"`
        : `edges[${i}]`;
      for (const key of Object.keys(edge)) {
        if (!EDGE_KEYS.has(key)) {
          problems.push(`${label}: unknown field "${key}" (allowed: ${[...EDGE_KEYS].join(", ")})`);
        }
      }
      for (const endpoint of ["from", "to"] as const) {
        const ref = edge[endpoint];
        if (typeof ref !== "string" || ref === "") {
          problems.push(`edges[${i}]: "${endpoint}" must be a non-empty string`);
        } else if (!nodeIds.has(ref)) {
          problems.push(`${label}: "${endpoint}" references unknown node "${ref}"`);
        }
      }
      // An unrecognized `on` value is worse than a hard error at run time: the
      // engine's shouldRun matches it against no behavior branch, so the edge
      // silently imposes NO constraint and the target runs unconditionally.
      if (edge.on !== undefined && !EDGE_ON.has(edge.on as string)) {
        problems.push(`${label}: invalid "on" value ${JSON.stringify(edge.on)} (allowed: ${[...EDGE_ON].join(", ")})`);
      }
      if (edge.condition !== undefined && typeof edge.condition !== "string") {
        problems.push(`${label}: "condition" must be a string`);
      }
    }
  }

  if (problems.length > 0) {
    const id = typeof value.id === "string" && value.id ? ` "${value.id}"` : "";
    throw new Error(`Invalid workflow definition${id}: ${problems.join("; ")}`);
  }
  // Every structural field is now verified to match TaskGraph's shape — this is
  // the validated form of the old bare `as TaskGraph` cast at the parse site.
  return value as unknown as TaskGraph;
}
