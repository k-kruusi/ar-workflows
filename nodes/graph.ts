/**
 * graph.ts — `graph:parse`: the bridge from model output to an executable DAG.
 *
 * WHY IT EXISTS, measured rather than assumed. goal-exp Run 0
 * (wf-1786369149442-pox9pt) ran three cells against `workflow:run`:
 *   A. graph as a literal object                         -> completed
 *   B. graph via full-template interpolation of an object -> completed
 *   C. graph as a STRING from an upstream node's stdout   -> FAILED
 *      `workflow:run: input "graph" must be an object`
 * Cell C is exactly the shape `agent:run` produces (`.reply`) and `model:generate`
 * produces (`.reply`) — every model-output field in this engine is a string, and
 * `inputs.obj` refuses strings by design (contract.ts). So the DAG-of-DAGs
 * mechanism was real but unreachable from an orchestrator agent: it could only
 * dispatch by shelling out to POST /workflow, which forfeits budget nesting,
 * cancel propagation and tree-kill, and forces a `shell` grant on a planner that
 * should need none.
 *
 * This node is that missing half. It is deliberately a SEPARATE node rather than
 * teaching `workflow:run` to accept a string:
 *   - `workflow:run`'s contract stays honest (an object input means an object);
 *   - markdown-fence tolerance belongs at the model boundary, not in the executor;
 *   - the parse becomes its own run-record node, so "the orchestrator emitted
 *     garbage" and "the round failed" are distinguishable failures;
 *   - it gives later gates (envelope shape now; pairwise-disjoint worker confines
 *     next) one place to live, on the object, before any spend.
 *
 * THIS FILE IS A BOUNDARY. Consuming output you did not write is precisely where
 * defensive programming is correct (skills/program_style.md) — validate loudly
 * here so every consumer downstream may assert instead. Every rejection names what
 * was wrong and where, because ambiguous garbage burns the next agent's context
 * (CLAUDE.md, The Honest Response Principle).
 *
 * NOT DONE HERE: node types are not checked against the registry. `validateEnvelope`
 * already owns that on dispatch (runner.ts:550); duplicating it would create a
 * second source of truth that drifts.
 */
import { defineNode, type NodeDef } from "./contract.js";

interface ParsedGraph {
  id: string;
  name: string;
  description: string;
  nodes: Array<{ id?: unknown; type?: unknown }>;
  edges: Array<{ from?: unknown; to?: unknown }>;
}

/** Pull the first balanced JSON object out of arbitrary model prose.
 *
 *  Brace counting has to respect string literals, or a description containing "}"
 *  truncates the object and the caller gets a parse error for a graph that was
 *  actually fine. Returns null when there is no `{` at all — an honest "nothing
 *  here", distinct from "found something that would not parse". */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const haystack = fenced ? fenced[1] : text;

  const start = haystack.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const c = haystack[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null;
}

/** Envelope + structural validation. Throws with the offending field named.
 *  `validateEnvelope` will re-check id/name/description on dispatch; checking here
 *  too is not duplication of AUTHORITY but of TIMING — it moves the rejection off
 *  the dispatch path and onto a named node, before a run record is minted. */
function assertGraphShape(g: unknown): asserts g is ParsedGraph {
  if (g === null || typeof g !== "object" || Array.isArray(g)) {
    throw new Error('graph:parse: parsed value must be an object (a graph), got ' + (Array.isArray(g) ? "an array" : typeof g));
  }
  const o = g as Record<string, unknown>;
  for (const field of ["id", "name", "description"] as const) {
    if (typeof o[field] !== "string" || (o[field] as string).trim() === "") {
      throw new Error(`graph:parse: envelope field "${field}" is required and must be a non-empty string — validateEnvelope rejects the dispatch without it`);
    }
  }
  if (!Array.isArray(o.nodes) || o.nodes.length === 0) {
    throw new Error('graph:parse: "nodes" must be a non-empty array — a round with no nodes is a lie, not a plan');
  }
  if (o.edges !== undefined && !Array.isArray(o.edges)) {
    throw new Error('graph:parse: "edges" must be an array when present');
  }

  const ids = new Set<string>();
  o.nodes.forEach((n, i) => {
    if (n === null || typeof n !== "object" || Array.isArray(n)) {
      throw new Error(`graph:parse: nodes[${i}] must be an object`);
    }
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || node.id.trim() === "") {
      throw new Error(`graph:parse: nodes[${i}] is missing a non-empty string "id"`);
    }
    if (typeof node.type !== "string" || node.type.trim() === "") {
      throw new Error(`graph:parse: nodes[${i}] ("${node.id}") is missing a non-empty string "type"`);
    }
    if (ids.has(node.id)) throw new Error(`graph:parse: duplicate node id "${node.id}" at nodes[${i}]`);
    ids.add(node.id);
  });

  for (const [i, e] of ((o.edges ?? []) as Array<Record<string, unknown>>).entries()) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error(`graph:parse: edges[${i}] must be an object`);
    }
    for (const end of ["from", "to"] as const) {
      const v = e[end];
      if (typeof v !== "string" || !ids.has(v)) {
        throw new Error(`graph:parse: edges[${i}].${end} = "${String(v)}" does not name a node in this graph`);
      }
    }
  }
}

export const graphNodes: NodeDef[] = [
  defineNode({
    type: "graph:parse",
    description:
      "Parse a model-authored workflow graph out of free text into a real OBJECT, so it can be " +
      "handed to workflow:run's `graph` input (which refuses strings). Tolerates ```json fences, " +
      "bare fences, and JSON embedded in prose. Inputs: text (required — an agent:run/model:generate " +
      "reply). Returns { graph, id, name, nodeCount, edgeCount, nodeTypes }. Validates the envelope " +
      "(id/name/description), that nodes is non-empty with unique id+type on every node, and that " +
      "every edge endpoint names a node in the graph — throwing a NAMED error otherwise, before any " +
      "dispatch is minted. Node types are NOT checked against the registry here; validateEnvelope " +
      "owns that on dispatch. Wire as: agent:run -> graph:parse -> workflow:run " +
      '{ graph: "{{nodes.<parse-id>.result.graph}}" }.',
    run: async ({ inputs }) => {
      const text = inputs.str("text", { required: true });

      const json = extractJsonObject(text);
      if (json === null) {
        throw new Error(
          "graph:parse: no JSON object found in the text — the seat produced no graph. " +
            `First 200 chars: ${JSON.stringify(text.slice(0, 200))}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        throw new Error(
          `graph:parse: found a JSON-shaped block but could not parse it (${err instanceof Error ? err.message : String(err)}). ` +
            `First 200 chars of the block: ${JSON.stringify(json.slice(0, 200))}`,
        );
      }

      assertGraphShape(parsed);

      const nodeTypes = [...new Set(parsed.nodes.map((n) => String(n.type)))].sort();
      return {
        graph: parsed,
        id: parsed.id,
        name: parsed.name,
        nodeCount: parsed.nodes.length,
        edgeCount: (parsed.edges ?? []).length,
        nodeTypes: nodeTypes.join(","),
      };
    },
  }),
];
