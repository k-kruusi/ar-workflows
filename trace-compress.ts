/**
 * Trace response compression — the sync /workflow boundary.
 *
 * A synchronous POST /workflow returns the full ExecutionTrace to the caller
 * (dashboard Run dialog, chrono, mcp-server's run_workflow tool — i.e. straight
 * into an agent's context). Node payloads ride along raw: core:exec stdout up
 * to its 1MB capture cap, agent:run replies of tens of KB. The agent:notify
 * condense path (notify-condense.ts) deliberately no-ops on sync runs — "the
 * caller already has the trace inline" — which made THIS response the
 * uncompressed delivery surface: every exec-notify run in the store (16/16,
 * 2026-08-01 audit) delivered its full stdout this way.
 *
 * The run store (data/workflow-runs/<cid>.json + GET /workflow/run/:id) is the
 * full-fidelity record and is untouched. This module compresses a COPY of the
 * trace for the response only: any string field over the cap goes through
 * token-funnel (never drops failure signal), then a tail-keep cap (results
 * print at the end — core:exec's own convention) with a marker naming the
 * dropped bytes and pointing at the record.
 */
import assert from "node:assert/strict";
import { funnel } from "../../dependencies/token-funnel/dist/index.js";

/** Per-field cap in characters for the response copy. Above this, content is
 *  funneled, then tail-capped. 4000 ≈ a readable inspection window; the record
 *  keeps everything. Env-overridable; WORKFLOW_TRACE_COMPRESS=0 disables. */
const DEFAULT_FIELD_CAP_CHARS = 4000;

/** Recursion bound for the payload walk — node results are shallow by
 *  convention (stdout/reply/… at top level); deeper nesting is structural. */
const MAX_WALK_DEPTH = 4;

export interface TraceCompressStats {
  fieldsCompressed: number;
  originalBytes: number;
  responseBytes: number;
}

function resolveFieldCap(): number {
  const env = Number(process.env.WORKFLOW_TRACE_FIELD_CAP_CHARS);
  if (Number.isFinite(env) && env >= 256) return env;
  return DEFAULT_FIELD_CAP_CHARS;
}

export function traceCompressEnabled(): boolean {
  return process.env.WORKFLOW_TRACE_COMPRESS !== "0";
}

function pointer(correlationId: string): string {
  return `full output in the run record: GET /workflow/run/${correlationId} (data/workflow-runs/${correlationId}.json)`;
}

/** Compress one over-cap string: funnel first (deterministic, failure-signal
 *  preserving), then a tail-keep cap with a labeled cut marker. */
function compressField(text: string, cap: number, correlationId: string): string {
  const funneled = funnel(text);
  if (funneled.length <= cap) {
    return `${funneled}\n[trace-compress: funneled ${text.length} → ${funneled.length} chars — ${pointer(correlationId)}]`;
  }
  const kept = funneled.slice(funneled.length - cap);
  return `[trace-compress: kept tail ${cap} of ${funneled.length} chars (original ${text.length}) — ${pointer(correlationId)}]\n${kept}`;
}

function walk(
  value: unknown,
  depth: number,
  cap: number,
  correlationId: string,
  stats: TraceCompressStats,
): unknown {
  if (typeof value === "string") {
    if (value.length <= cap) return value;
    const out = compressField(value, cap, correlationId);
    stats.fieldsCompressed += 1;
    stats.originalBytes += value.length;
    stats.responseBytes += out.length;
    return out;
  }
  if (depth >= MAX_WALK_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, depth + 1, cap, correlationId, stats));
  }
  // Plain-object walk. Node results are plain JSON by the node contract
  // ("must return a plain object" — src/workflows/nodes/README.md).
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = walk(v, depth + 1, cap, correlationId, stats);
  }
  return out;
}

interface TraceLike {
  correlationId: string;
  nodeResults: Array<{ result?: unknown }>;
}

/** Compress a COPY of an ExecutionTrace for a sync /workflow response. The
 *  input is never mutated — the engine trace is shared with the run store and
 *  the live run view, both of which keep full fidelity. Stats are attached as
 *  `traceCompression` so the caller can see the cut was made (Honest Response:
 *  a compressed view must say so). */
export function compressTraceForResponse<T extends TraceLike>(
  trace: T,
  opts: { capChars?: number } = {},
): T & { traceCompression?: TraceCompressStats } {
  if (!traceCompressEnabled()) return trace;
  assert(
    typeof trace.correlationId === "string" && trace.correlationId.length > 0,
    "trace.correlationId must be set — the engine mints it before any node runs (runGraphAtDepth)",
  );
  assert(
    Array.isArray(trace.nodeResults),
    "trace.nodeResults must be an array — ExecutionTrace contract (dependencies/task-graph/src/types.ts)",
  );
  const cap = opts.capChars ?? resolveFieldCap();
  const stats: TraceCompressStats = { fieldsCompressed: 0, originalBytes: 0, responseBytes: 0 };
  const copy: T = {
    ...trace,
    nodeResults: trace.nodeResults.map((nr) => ({
      ...nr,
      result: walk(nr.result, 0, cap, trace.correlationId, stats),
    })),
  };
  if (stats.fieldsCompressed > 0) {
    return { ...copy, traceCompression: stats };
  }
  return copy;
}
