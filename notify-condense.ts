/**
 * Default-on condense for agent:notify / fireNotify — trims noisy workflow output
 * (spinners, progress floods) via the quarantine silo before it hits agent context.
 *
 * Fails CLOSED, never open: every message that reaches the condense path is first
 * run through a deterministic sanitize stage (collapse \r animation frames, strip
 * ANSI), and if condense itself errors/times-out the fallback is the sanitized text
 * hard-truncated to a byte cap with an explicit `[truncated N bytes]` marker — never
 * the full raw original (that was the old bug: pollution came back exactly when the
 * output was big/weird, the worst case). Below the applicability threshold a small
 * clean message still returns unchanged.
 */
import { log } from "../logger.js";
import { loadCondenseContent } from "./load-condense.js";
import { funnel } from "../../dependencies/token-funnel/dist/index.js";

const DEFAULT_MIN_CHARS = 2048;

/** Byte cap for the deterministic condense-failure fallback. Kept above the 3072-ish
 *  messages the existing tests exercise (a few KB of clean text isn't the pollution
 *  case) but small enough to bound a big/weird failure. Env-overridable. */
const DEFAULT_FALLBACK_CAP_BYTES = 4096;

/** task-graph node timeout should exceed silo work (120s) + margin. */
export const NOTIFY_CONDENSE_NODE_TIMEOUT_MS = 180_000;

export interface CondenseNotifyOpts {
  minChars?: number;
  task?: string;
  engine?: "llm" | "test";
}

export interface CondenseNotifyResult {
  text: string;
  condensed: boolean;
  skipped?: "below_threshold" | "disabled";
  /** Which fail-closed fallback fired (condense returned !ok / threw). Its `text` is
   *  the SANITIZED input, hard-truncated to the cap — NOT the raw original. */
  passThrough?: "condense_failed" | "condense_error";
  originalBytes?: number;
  condensedBytes?: number;
  /** Bytes cut by the deterministic truncation fallback (0 if it fit under the cap). */
  droppedBytes?: number;
  error?: string;
}

/** exec-notify shape: preserve exit header + stderr block mechanically. */
export interface ExecNotifySections {
  prefix: string;
  body: string;
  suffix: string;
}

export function splitExecNotifyMessage(message: string): ExecNotifySections | null {
  const m = message.match(/^([\s\S]*?\n\n)([\s\S]*?)(\n\nSTDERR:\n[\s\S]*)$/);
  if (!m) return null;
  const prefix = m[1];
  if (!/exit\s*[\w-]*\s*[\d-]/i.test(prefix) && !/finished/i.test(prefix)) return null;
  return { prefix: m[1], body: m[2], suffix: m[3] };
}

function resolveMinChars(override?: number): number {
  if (override != null && override > 0) return override;
  const env = Number(process.env.NOTIFY_CONDENSE_MIN_CHARS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_MIN_CHARS;
}

function resolveFallbackCap(): number {
  const env = Number(process.env.NOTIFY_CONDENSE_FALLBACK_CAP);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_FALLBACK_CAP_BYTES;
}

/**
 * Deterministic pre-condense cleanup. ALWAYS runs before the condense model sees the
 * text (and before the failure-fallback truncation), so the model never wastes tokens
 * on terminal control noise and the fallback is already clean:
 *   - CRLF is normalized first, so a Windows line ending isn't mistaken for a frame;
 *   - `\r` animation frames collapse to their final line (a spinner/progress bar
 *     rewinds to column 0 with a bare \r — only the last segment is what's visible);
 *   - ANSI escape sequences (SGR colors, cursor moves, erase-line) are stripped.
 */
export function sanitizeOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const deframed = normalized
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf("\r");
      return i === -1 ? line : line.slice(i + 1);
    })
    .join("\n");
  return deframed.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[=>]/g, "");
}

/**
 * Hard-truncate to a byte cap, KEEPING THE TAIL (for exec output the end holds the
 * final status / result / error) and prepending a `[truncated N bytes]` marker.
 * Char-safe: drops whole characters from the front, never splitting a multi-byte
 * codepoint into mojibake. The marker's own bytes sit on top of the cap (the cap
 * bounds retained content, not the annotation).
 */
export function hardTruncateTail(text: string, capBytes: number): { text: string; droppedBytes: number } {
  const total = Buffer.byteLength(text, "utf-8");
  if (total <= capBytes) return { text, droppedBytes: 0 };
  let kept = text;
  while (Buffer.byteLength(kept, "utf-8") > capBytes && kept.length > 0) {
    const over = Buffer.byteLength(kept, "utf-8") - capBytes;
    kept = kept.slice(Math.max(1, over)); // drop ≥1 char/iteration — guarantees progress
  }
  // If the front cut landed between an astral char's surrogate pair, drop the dangling
  // low surrogate so the tail can't start with a lone half-codepoint (a `�` seam).
  if (kept.length > 0) {
    const first = kept.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) kept = kept.slice(1);
  }
  const droppedBytes = total - Buffer.byteLength(kept, "utf-8");
  return { text: `[truncated ${droppedBytes} bytes]\n${kept}`, droppedBytes };
}

/** The fail-closed fallback: sanitized text truncated to the cap. NEVER the raw
 *  original. Shared by both failure modes (condense !ok / condense threw). */
function fallbackResult(
  sanitized: string,
  capBytes: number,
  passThrough: "condense_failed" | "condense_error",
  error?: string,
): CondenseNotifyResult {
  const { text, droppedBytes } = hardTruncateTail(sanitized, capBytes);
  log("warn", "notify_condense_fallback", {
    passThrough,
    reason: error,
    sanitizedBytes: Buffer.byteLength(sanitized, "utf-8"),
    droppedBytes,
  });
  return {
    text,
    condensed: false,
    passThrough,
    error,
    originalBytes: Buffer.byteLength(sanitized, "utf-8"),
    condensedBytes: Buffer.byteLength(text, "utf-8"),
    droppedBytes,
  };
}

/** Detect spinner/progress floods that are short in bytes but long in lines. */
export function isRepetitiveNoise(message: string): boolean {
  const lines = message.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 20) return false;
  const counts = new Map<string, number>();
  for (const line of lines) {
    const norm = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (norm.length < 3) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  return max >= 8 && max / lines.length >= 0.25;
}

export function shouldCondenseNotify(message: string, minChars?: number): boolean {
  if (Buffer.byteLength(message, "utf-8") >= resolveMinChars(minChars)) return true;
  return isRepetitiveNoise(message);
}

function resolveEngine(opts: CondenseNotifyOpts): "llm" | "test" {
  if (opts.engine) return opts.engine;
  if (process.env.NOTIFY_CONDENSE_ENGINE === "test") return "test";
  if (process.env.QUARANTINE_SILO?.toLowerCase() === "test") return "test";
  return "llm";
}

async function condenseSegment(
  segment: string,
  opts: CondenseNotifyOpts,
  capBytes: number,
): Promise<CondenseNotifyResult> {
  // ALWAYS sanitize before the model (and before the fallback truncation) — the
  // condense path never sees raw terminal-control noise.
  const sanitized = sanitizeOutput(segment);
  // Deterministic pass: funnel collapses progress floods (1%…2%…3%, spinner
  // frames, consecutive duplicates) without an LLM. If it reduces enough to
  // fall under the threshold we skip the docker silo entirely — fast + cheap.
  const funneled = funnel(sanitized);
  if (!shouldCondenseNotify(funneled, opts.minChars)) {
    log("info", "notify_funnel_sufficient", {
      originalBytes: Buffer.byteLength(sanitized, "utf-8"),
      funnelBytes: Buffer.byteLength(funneled, "utf-8"),
    });
    return {
      text: funneled,
      condensed: true,
      originalBytes: Buffer.byteLength(sanitized, "utf-8"),
      condensedBytes: Buffer.byteLength(funneled, "utf-8"),
    };
  }
  try {
    const condenseContent = await loadCondenseContent();
    const result = await condenseContent(funneled, opts.task, { engine: resolveEngine(opts) });
    if (!result.ok) {
      // Condense reported failure (e.g. no docker) — deterministic fallback, not raw.
      return fallbackResult(funneled, capBytes, "condense_failed", result.error);
    }
    log("info", "notify_condensed", {
      originalBytes: result.originalBytes,
      condensedBytes: result.condensedBytes,
    });
    return {
      text: result.text,
      condensed: true,
      originalBytes: result.originalBytes,
      condensedBytes: result.condensedBytes,
    };
  } catch (err) {
    // The silo itself threw (loader/model error) — deterministic fallback, not raw.
    return fallbackResult(funneled, capBytes, "condense_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Condense `message` when enabled and applicable; otherwise return unchanged.
 * Never throws — failures pass through with a warn log.
 */
export async function condenseNotifyMessage(
  message: string,
  enabled: boolean,
  opts: CondenseNotifyOpts = {},
): Promise<CondenseNotifyResult> {
  if (!enabled) {
    return { text: message, condensed: false, skipped: "disabled" };
  }
  if (!shouldCondenseNotify(message, opts.minChars)) {
    return { text: message, condensed: false, skipped: "below_threshold" };
  }

  const cap = resolveFallbackCap();
  try {
    const sections = splitExecNotifyMessage(message);
    if (sections && shouldCondenseNotify(sections.body, opts.minChars)) {
      const body = await condenseSegment(sections.body, opts, cap);
      // STDERR suffix ("\n\nSTDERR:\n<content>") is never sent to the silo, but
      // still needs sanitize+funnel to collapse tqdm floods in the STDERR stream.
      const stderrContent = sections.suffix.replace(/^\n\nSTDERR:\n/, "");
      const stderrFunnelled = funnel(sanitizeOutput(stderrContent));
      const suffix = "\n\nSTDERR:\n" + stderrFunnelled;
      return {
        text: sections.prefix + body.text + suffix,
        condensed: body.condensed,
        ...(body.passThrough ? { passThrough: body.passThrough, error: body.error } : {}),
        ...(body.droppedBytes != null ? { droppedBytes: body.droppedBytes } : {}),
        originalBytes: body.originalBytes,
        condensedBytes: body.condensedBytes,
      };
    }
    return await condenseSegment(message, opts, cap);
  } catch (err) {
    // Last-resort guard: even if sanitize/split itself threw, fail CLOSED — sanitized
    // + hard-truncated, never the raw original.
    const error = err instanceof Error ? err.message : String(err);
    return fallbackResult(sanitizeOutput(message), cap, "condense_error", error);
  }
}