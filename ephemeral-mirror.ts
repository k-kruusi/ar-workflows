/**
 * Compaction / traffic-mirror container key for an ephemeral agent:run leg that
 * has no workerProfile. Must stay in lockstep with
 * packages/workflows/src/lib/ephemeral-mirror.ts (panel copies the formula —
 * browser bundle cannot import supervisor src).
 *
 * Format: `<correlationId>-<nodeId>@worker` (sanitized). traffic-mirror splits
 * on `@` for upstream lookup (base name → global Anthropic UPSTREAM when no
 * workspace exists) and labels events with the full decorated name so
 * compaction can key a stream per in-flight node.
 */
export function ephemeralMirrorAgent(correlationId: string, nodeId: string): string {
  const safe = (s: string): string => {
    const t = s.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return t || "x";
  };
  return `${safe(correlationId)}-${safe(nodeId)}@worker`;
}

/** Base URL host for the local traffic-mirror (no trailing slash, no /c/…). */
export function trafficMirrorOrigin(): string {
  const raw =
    process.env.TRAFFIC_MIRROR_URL ||
    process.env.TRAFFIC_MIRROR_BASE ||
    "http://127.0.0.1:3075";
  return raw.replace(/\/$/, "");
}

/** ANTHROPIC_BASE_URL value that labels this worker on the mirror. */
export function ephemeralMirrorBaseUrl(correlationId: string, nodeId: string): string {
  const agent = ephemeralMirrorAgent(correlationId, nodeId);
  return `${trafficMirrorOrigin()}/c/${agent}`;
}
