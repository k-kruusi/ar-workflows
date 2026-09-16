import type { WorkflowRunProgress } from "./run-store.js";

export const DEFAULT_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export type RetryMatchResult =
  | { kind: "resume"; run: WorkflowRunProgress }
  | { kind: "in-flight"; run: WorkflowRunProgress };

/**
 * Stable key-order-independent JSON serialization for params comparison.
 * Objects: sorted keys, recursive. Arrays: preserve order. Primitives: JSON.stringify.
 * undefined object values are dropped (matches JSON.parse round-trip behavior).
 */
export function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    // NaN/Infinity → "null" (matches JSON.stringify behavior, prevents false collisions)
    if (!Number.isFinite(v)) return "null";
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  return "null"; // functions, symbols → null (safe: can't appear in JSON-parsed params)
}

/**
 * Find a prior run of the same named workflow with identical params.
 * Scans `runs` (expects store.list() order — most-recent-first).
 *
 * Priority: a "running" match (in-flight) wins over a "failed"/"partial" match.
 * "completed" and "cancelled" are excluded — completed is memoization (anti-goal),
 * cancelled is operator intent (must not be silently revived).
 */
export function findResumableRun(
  runs: WorkflowRunProgress[],
  workflowId: string,
  params: Record<string, unknown>,
  opts?: { windowMs?: number },
): RetryMatchResult | undefined {
  const needle = canonicalize(params);
  const windowMs = opts?.windowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const now = Date.now();

  let resumable: WorkflowRunProgress | undefined;

  for (const run of runs) {
    if (run.workflowId !== workflowId) continue;
    if (canonicalize(run.params) !== needle) continue;

    // In-flight wins immediately — never spawn a duplicate
    if (run.status === "running") {
      return { kind: "in-flight", run };
    }
    // First (= most recent) failed/partial within the window
    if (!resumable && (run.status === "failed" || run.status === "partial")) {
      if (now - run.updatedAt <= windowMs) {
        resumable = run;
      }
    }
  }
  return resumable ? { kind: "resume", run: resumable } : undefined;
}
