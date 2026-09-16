/**
 * WorkflowOutputStore — LIVE output for run nodes.
 *
 * Two sources, same key (correlationId::nodeId):
 *  1. STREAMED buffers — core:exec (and any node) streams stdout/stderr here via
 *     caps.streamOutput while it runs; the dashboard tails it
 *     (GET /workflow/run/:id/output?node=<id>) so you can watch a long shell node
 *     live instead of only seeing its result at the end.
 *  2. DECLARED log files — a node that redirects its OWN output to a file (e.g.
 *     core:exec with `logFile`, the command doing `… > run.log 2>&1`) registers
 *     that path via caps.registerOutputFile. The pipe we'd otherwise tail is empty,
 *     so when there's no streamed buffer the tail is read from that file on demand.
 *
 * get() PREFERS the streamed buffer (the live pipe view) and falls back to the file
 * tail — so a node that both streams AND declares a file shows the buffer until it's
 * evicted, then the file. File reads are change-detected (size+mtime): a 1.5s
 * dashboard poll on an unchanged file is a cheap stat, not a fresh 256 KB read.
 *
 * Streamed buffers are bounded both ways: a per-node TAIL cap (keep the most recent
 * bytes — that's where a training run's results are) and a cap on how many node-
 * buffers we keep (oldest evicted). File tails are read last-MAX_TAIL_BYTES on
 * demand (bounded regardless of file size). Per-run state (buffer + file
 * registration + the file-tail cache) is dropped by clear(), which the runner wires
 * to run-record pruning so nothing leaks past a run's lifetime. Streamed buffers are
 * in-memory and lost on a supervisor restart (which also kills a streamed run); a
 * registered file path is the durable view — the file outlives the buffer.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";

const MAX_TAIL_BYTES = 256 * 1024; // keep the last 256 KB per node
const MAX_NODES = 200; // total node-buffers retained (oldest evicted)

export class WorkflowOutputStore {
  private buf = new Map<string, string>();
  private files = new Map<string, string>();
  // path -> last (size, mtime, tail). Lets a steady-state poll short-circuit to a
  // cheap stat instead of re-reading 256 KB of an unchanged file; entries are
  // dropped with their run by clear().
  private fileCache = new Map<string, { size: number; mtimeMs: number; tail: string }>();

  private key(correlationId: string, nodeId: string): string {
    return `${correlationId}::${nodeId}`;
  }

  append(correlationId: string, nodeId: string, chunk: string): void {
    if (!correlationId || !nodeId || !chunk) return;
    const k = this.key(correlationId, nodeId);
    let s = (this.buf.get(k) ?? "") + chunk;
    if (s.length > MAX_TAIL_BYTES) s = s.slice(s.length - MAX_TAIL_BYTES);
    // Re-insert last so Map insertion order tracks recency for eviction.
    this.buf.delete(k);
    this.buf.set(k, s);
    while (this.buf.size > MAX_NODES) {
      const oldest = this.buf.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buf.delete(oldest);
    }
  }

  /** Declare that this run-node writes its output to `path` (the command redirects
   *  there itself, e.g. `… > run.log 2>&1`). When there's no streamed buffer, get()
   *  reads the tail from disk. Not capped/evicted: one path string per node, dropped
   *  with the run by clear(). */
  registerFile(correlationId: string, nodeId: string, path: string): void {
    if (!correlationId || !nodeId || !path) return;
    this.files.set(this.key(correlationId, nodeId), path);
  }

  /** The current output tail for one run-node: the streamed buffer if non-empty,
   *  else the last MAX_TAIL_BYTES of its declared log file, else "". */
  get(correlationId: string, nodeId: string): string {
    const k = this.key(correlationId, nodeId);
    const buffered = this.buf.get(k);
    if (buffered) return buffered;
    const file = this.files.get(k);
    return file ? this.fileTail(file) : "";
  }

  /** Tail a declared log file, re-reading from disk only when it changed since the
   *  last poll (size or mtime differs) — the steady-state poll is just a stat. */
  private fileTail(path: string): string {
    try {
      if (!existsSync(path)) return "";
      const st = statSync(path);
      const cached = this.fileCache.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.tail;
      const tail = readTail(path, MAX_TAIL_BYTES, st.size);
      this.fileCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, tail });
      return tail;
    } catch {
      return "";
    }
  }

  /** Node ids that have output for a run — streamed buffer OR registered file. */
  nodes(correlationId: string): string[] {
    const prefix = `${correlationId}::`;
    const ids = new Set<string>();
    for (const k of this.buf.keys()) if (k.startsWith(prefix)) ids.add(k.slice(prefix.length));
    for (const k of this.files.keys()) if (k.startsWith(prefix)) ids.add(k.slice(prefix.length));
    return [...ids];
  }

  /** Drop a run's buffers + file registrations + cached file tails. Wired to run-
   *  record pruning (runner) so per-run output state can't outlive the run. */
  clear(correlationId: string): void {
    const prefix = `${correlationId}::`;
    for (const k of [...this.buf.keys()]) if (k.startsWith(prefix)) this.buf.delete(k);
    for (const [k, path] of [...this.files.entries()]) {
      if (k.startsWith(prefix)) {
        this.files.delete(k);
        this.fileCache.delete(path);
      }
    }
  }
}

/** Read the last `maxBytes` of a `size`-byte file as UTF-8 ("" if empty). Bounded —
 *  never reads more than the cap regardless of file size. When started mid-file, the
 *  partial first line is dropped if the window contains a newline; a single line
 *  longer than the window is returned with only a leading partial codepoint (U+FFFD)
 *  stripped — so the head is never visibly garbled. Throws on fs errors (the caller
 *  guards with try/catch); the file is known to exist (caller stat'd it). */
function readTail(path: string, maxBytes: number, size: number): string {
  if (size === 0) return "";
  const start = size > maxBytes ? size - maxBytes : 0;
  const len = size - start;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(len);
    const read = readSync(fd, buffer, 0, len, start);
    const text = buffer.subarray(0, read).toString("utf-8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    if (nl >= 0) return text.slice(nl + 1); // drop the partial first line
    // Single line longer than the window: no line to drop, but the head may be a
    // split multibyte char decoded as U+FFFD — strip that one codepoint so the tail
    // doesn't start with a visible replacement glyph.
    return text.charCodeAt(0) === 0xfffd ? text.slice(1) : text;
  } finally {
    closeSync(fd);
  }
}
