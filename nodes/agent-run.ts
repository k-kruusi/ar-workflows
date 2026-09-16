/**
 * agent-run.ts — the `agent:run` node: spawn an EPHEMERAL agent in a cwd.
 *
 * `agent:ask` / `agent:whisper` send a message to a PRE-EXISTING, named live
 * fleet agent (via caps.whisper) and await its reply — they commandeer that
 * agent's persistent session. `agent:run` is the opposite primitive: it spawns a
 * FRESH `claude -p` worker scoped to a given `cwd` (a git worktree), runs one
 * prompt, and returns `{ sessionId, reply }`. Pass the returned `sessionId` back
 * in to `--resume` the same worker on a later turn — that's how a work→review
 * loop carries the coder's history forward across rounds. It is the same `claude`
 * CLI the claude-cli runtime adapter spawns, exposed as a durable workflow node.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync, mkdirSync, rmdirSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { defineNode, type NodeDef } from "./contract.js";
import { killChildTree } from "../proc-kill.js";
import { sha256, routeIdentityFromEnv, type InferenceReceipt, type SessionBearingError } from "../epistemics.js";
import { resolveNodeConfig, type DeclaredNodeConfig } from "../node-presets.js";
import type { ConventionBundle } from "../conventions/types.js";
import {
  resolveArToolsPaths,
  buildArToolsMcpConfig,
  buildArToolsLocalMcpConfig,
  buildClaudeDisallowedTools,
  buildClaudeArgs,
  buildGrokConfigToml,
  buildGrokLocalConfigToml,
  buildGrokToolFlags,
  buildGrokArgs,
  WORKER_PROFILE_ENV_KEYS,
} from "./agent-run-tools.js";
import { parseCapabilities } from "./agent-run-capabilities.js";
import { runOpencode } from "./agent-run-opencode.js";
import { admitSpawn, type SpawnEnvelope } from "./agent-run-gate.js";
import { NullEscrow } from "./agent-run-escrow.js";
import { resolveTier, dispatch } from "../../runtimes/index.js";
import { structuredGenerate, StructuredOutputError } from "@agentruntime/structured-output";
import { ephemeralMirrorAgent, ephemeralMirrorBaseUrl } from "../ephemeral-mirror.js";

/**
 * WORKER_ENVELOPE_V1 — deny-by-default capabilities on agent:run (base-node rung 2).
 *
 * DEFAULT ON. Set `WORKER_ENVELOPE_V1=0` (or "false") to fall back to the legacy
 * behaviour, in which `--disallowedTools` is set ONLY on the `tools:"ar-tools"`
 * path and every default worker therefore keeps `Bash`. The escape hatch exists
 * because the flip is fleet-wide; it is not a supported long-term mode, and taking
 * it is logged per-spawn so an operator can see the envelope is off.
 */
export function workerEnvelopeEnabled(): boolean {
  const v = process.env.WORKER_ENVELOPE_V1;
  return v !== "0" && v !== "false";
}

/** Env vars that make a nested `claude -p` believe it is inside another Claude
 *  session (and refuse / misbehave). Stripped from the spawn env. */
const NESTED_STRIP = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/** This module's dir (src/workflows/nodes) and the monorepo root three up from it
 *  (the inner agentruntime/ holding agentruntime.json, src/, packages/). Used to
 *  resolve the ar-tools MCP paths the SAME way the supervisor does — see
 *  resolveArToolsPaths / container-manager.ts:84-87,157. Exported so the litmus
 *  test can spawn a real worker in a cwd where those paths resolve. */
const NODES_DIR = dirname(fileURLToPath(import.meta.url));
export const MONOREPO_ROOT = resolve(NODES_DIR, "..", "..", "..");

/** workerProfile: borrow a cartridge's upstream route (e.g. "kimi-1" → the
 *  traffic-mirror path to api.kimi.com, model "k3") for an EPHEMERAL worker.
 *  Reads the profile cartridge's workspace.json env block SERVER-SIDE and keeps
 *  only the WORKER_PROFILE_ENV_KEYS allowlist — the token is scoped to this one
 *  spawn (the .EVOLVE.md 2026-07-19 fleet-poisoning lesson), never logged,
 *  never placed in argv, never written into the prompt. Throws NAMED errors
 *  (Honest Response) that identify the profile and the missing key — never the
 *  secret value. Exported for the profile unit test. */
export function resolveWorkerProfileEnv(profile: string, rootDir: string): Record<string, string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error(`agent:run: workerProfile "${profile}" is not a plain container name (letters, digits, - and _ only)`);
  }
  const wsPath = join(rootDir, "cartridges", profile, "workspace.json");
  if (!existsSync(wsPath)) {
    throw new Error(`agent:run: workerProfile "${profile}" — no workspace.json at cartridges/${profile}/ (a profile is a cartridge whose env block carries the worker's upstream route)`);
  }
  let envBlock: Record<string, unknown>;
  try {
    envBlock = (JSON.parse(readFileSync(wsPath, "utf8")) as { env?: Record<string, unknown> }).env ?? {};
  } catch (err) {
    throw new Error(`agent:run: workerProfile "${profile}" — workspace.json is not valid JSON: ${(err as Error).message}`);
  }
  const out: Record<string, string> = {};
  for (const k of WORKER_PROFILE_ENV_KEYS) {
    const v = envBlock[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  if (!out.ANTHROPIC_BASE_URL) {
    throw new Error(`agent:run: workerProfile "${profile}" has no ANTHROPIC_BASE_URL in its env block — it does not route to an alternate upstream (nothing to borrow)`);
  }
  // Mark the borrowed route as WORKER traffic. The profile's base URL is the
  // cartridge's own (…/c/<name>), so without a marker traffic-mirror — and
  // compaction, which observes its events — files this EPHEMERAL worker's calls
  // under the CARTRIDGE's name. That is what made four cartridges correctly
  // declaring disableBuiltinTools:true look like they were violating it, and it
  // cost two sessions before anyone checked WHEN the calls happened.
  //
  // traffic-mirror splits this segment on "@": the base name still resolves the
  // upstream (routing unchanged), the suffix only labels emitted events. That
  // half shipped first (1b3ae143) and is inert without a suffix, so an older
  // mirror simply sees an unknown container name rather than a broken route —
  // but it MUST be live before this, never after.
  //
  // Conservative by construction: only a trailing /c/<name> is decorated, so a
  // profile pointing straight at a vendor upstream is untouched, and the [^/@]
  // class means an already-marked URL is never double-marked.
  out.ANTHROPIC_BASE_URL = out.ANTHROPIC_BASE_URL.replace(
    /\/c\/([^/@]+)$/,
    (_match, name: string) => `/c/${name}@worker`,
  );
  return out;
}

/** Resolve the claude binary — check common install locations before falling back to PATH.
 *  Exported (additive) so the ar-tools litmus test can `spawnSync(resolveClaudeBinary(),
 *  ["--version"])` to gate itself on claude actually being installed. */
export function resolveClaudeBinary(): string {
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      const localBin = join(userProfile, ".local", "bin", "claude.exe");
      if (existsSync(localBin)) return localBin;
    }
  }
  return "claude";
}

/** Lifecycle hooks so agent:run children are registered + killable like core:exec. */
export interface AgentRunChildHooks {
  correlationId?: string;
  nodeId?: string;
  recordChild?: (correlationId: string, nodeId: string, pid: number, command: string) => void;
  clearChild?: (correlationId: string, nodeId: string) => void;
  signal?: AbortSignal;
}

/**
 * Record a spawned agent:run child for the orphan-sweep + tree-kill on cancel/timeout.
 * Mirrors core:exec's caps.run.recordChild / killChildTree / clearChild pattern
 * (genesis card e7256b3e PR0). Exported for lifecycle tests.
 */
export function wireAgentRunChild(
  child: ChildProcess,
  command: string,
  hooks: AgentRunChildHooks,
): () => void {
  const { correlationId, nodeId, recordChild, clearChild, signal } = hooks;
  if (correlationId && nodeId && child.pid && recordChild) {
    recordChild(correlationId, nodeId, child.pid, command);
  }
  const onAbort = (): void => { killChildTree(child); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (signal) signal.removeEventListener("abort", onAbort);
    if (correlationId && nodeId && clearChild) clearChild(correlationId, nodeId);
  };
}

/** `claude -p --output-format json`'s flat usage block — snake_case, as observed on the wire. */
interface ClaudeUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Per-model entry of `modelUsage` — camelCase, keyed by the actual model id used
 *  (newer CLIs only; disambiguates when `--model` names a tier alias). */
interface ClaudeModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface ClaudeResult {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: ClaudeUsageBlock;
  modelUsage?: Record<string, ClaudeModelUsageEntry>;
}

/** Per-model split within a multi-model `usage.models` breakdown. */
export interface ModelUsageSplit {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

/** agent:run's additive usage report. Every field is optional-honest: present only
 *  when the runtime actually reported it — never a fabricated zero. */
export interface AgentRunUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  /** Present only when modelUsage names more than one model — the per-model split
   *  the flat fields above are summed from. */
  models?: ModelUsageSplit[];
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
}

/** Map a parsed ClaudeResult to the workflow-facing usage shape. Pure — no I/O — so
 *  it's unit-testable without spawning `claude`. `requestedModel` is the fallback
 *  identity used only when the CLI didn't report `modelUsage` (older CLIs): we prefer
 *  the runtime's own reported model id over what the caller asked for. */
export function claudeResultToUsage(result: ClaudeResult, requestedModel?: string): AgentRunUsage | undefined {
  const models: ModelUsageSplit[] = Object.entries(result.modelUsage ?? {}).map(([model, u]) => {
    const split: ModelUsageSplit = { model };
    if (u.inputTokens !== undefined) split.inputTokens = u.inputTokens;
    if (u.outputTokens !== undefined) split.outputTokens = u.outputTokens;
    if (u.cacheReadInputTokens !== undefined) split.cacheReadTokens = u.cacheReadInputTokens;
    if (u.cacheCreationInputTokens !== undefined) split.cacheCreationTokens = u.cacheCreationInputTokens;
    if (u.costUSD !== undefined) split.costUsd = u.costUSD;
    return split;
  });

  const usage: AgentRunUsage = {};

  if (models.length === 1) {
    const [only] = models;
    usage.model = only.model;
    if (only.inputTokens !== undefined) usage.inputTokens = only.inputTokens;
    if (only.outputTokens !== undefined) usage.outputTokens = only.outputTokens;
    if (only.cacheReadTokens !== undefined) usage.cacheReadTokens = only.cacheReadTokens;
    if (only.cacheCreationTokens !== undefined) usage.cacheCreationTokens = only.cacheCreationTokens;
  } else if (models.length > 1) {
    usage.models = models;
    const inputSum = sumDefined(models.map((m) => m.inputTokens));
    const outputSum = sumDefined(models.map((m) => m.outputTokens));
    const cacheReadSum = sumDefined(models.map((m) => m.cacheReadTokens));
    const cacheCreationSum = sumDefined(models.map((m) => m.cacheCreationTokens));
    if (inputSum !== undefined) usage.inputTokens = inputSum;
    if (outputSum !== undefined) usage.outputTokens = outputSum;
    if (cacheReadSum !== undefined) usage.cacheReadTokens = cacheReadSum;
    if (cacheCreationSum !== undefined) usage.cacheCreationTokens = cacheCreationSum;
  } else {
    // No modelUsage (older CLI) — fall back to the flat usage block and the requested
    // model, since there's no runtime-reported id to prefer.
    if (requestedModel) usage.model = requestedModel;
    if (result.usage?.input_tokens !== undefined) usage.inputTokens = result.usage.input_tokens;
    if (result.usage?.output_tokens !== undefined) usage.outputTokens = result.usage.output_tokens;
    if (result.usage?.cache_read_input_tokens !== undefined) usage.cacheReadTokens = result.usage.cache_read_input_tokens;
    if (result.usage?.cache_creation_input_tokens !== undefined) usage.cacheCreationTokens = result.usage.cache_creation_input_tokens;
  }

  const costUsd = result.total_cost_usd ?? sumDefined(models.map((m) => m.costUsd));
  if (costUsd !== undefined) usage.costUsd = costUsd;
  if (result.num_turns !== undefined) usage.numTurns = result.num_turns;
  if (result.duration_ms !== undefined) usage.durationMs = result.duration_ms;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Spawn a one-shot `claude -p` in `cwd`, resolve its parsed JSON result.
 *  No shell: claude.exe resolves on PATH and args pass as an array (no escaping). */
/** Spawn a one-shot `claude -p` in `cwd`, piping the prompt via stdin to avoid
 *  ENAMETOOLONG on Windows (the OS command-line limit is ~32k chars; a workflow
 *  prompt that interpolates two designs easily exceeds that). */
/** Spawn a one-shot `claude -p` in `cwd`, piping the prompt via stdin.
 *  No process-level timeout — the task-graph engine's node.timeoutMs is the
 *  single authority (eliminates the double-timer race that killed long runs).
 *  Exported (additive) so the workerProfile test can assert the spawn env merge
 *  without driving the whole node. */
export function runClaude(opts: {
  prompt: string;
  cwd: string;
  sessionId: string;
  model: string;
  skipPerms: boolean;
  tools?: string;
  /** The worker envelope from admitSpawn. Present ⇒ WORKER_ENVELOPE_V1 path:
   *  `--disallowedTools` is set for EVERY spawn and the ar-tools child is gated to
   *  the granted TOOLS subset. Absent ⇒ the legacy pre-envelope behaviour. */
  envelope?: SpawnEnvelope;
  /** Cancel/orphan tracking — same channel core:exec uses via caps.run. */
  childHooks?: AgentRunChildHooks;
  /** workerProfile env (allowlisted upstream route + scoped token) — merged LAST
   *  so it wins over the inherited supervisor env for exactly those keys. */
  profileEnv?: Record<string, string>;
}): Promise<ClaudeResult> {
  // ── The envelope layer. THE INVERSION: `disallowedTools` used to be assigned
  //    ONLY inside the ar-tools branch, so a worker that asked for no tools got no
  //    --disallowedTools flag at all and kept every built-in, Bash included. Under
  //    the envelope it is ALWAYS set from the gate's computed list, and this branch
  //    now decides only whether to ALSO write an --mcp-config (and with which TOOLS
  //    subset). Validated up front so a missing bridge/entry fails with a named
  //    path (Honest Response), not a silently-broken claude run. ──
  let mcpConfigPath: string | undefined;
  let mcpTmpDir: string | undefined;
  let disallowedTools: string | undefined;

  const attachArTools: false | "ar-tools" | "ar-tools-local" = opts.envelope
    ? opts.envelope.attachArTools
    : (opts.tools === "ar-tools" || opts.tools === "ar-tools-local" ? opts.tools : false);

  if (opts.envelope) disallowedTools = opts.envelope.disallowedTools;

  if (attachArTools !== false) {
    const paths = resolveArToolsPaths(MONOREPO_ROOT);
    if (!existsSync(paths.evolutionBridgePath)) {
      throw new Error(`agent:run: ar-tools evolution bridge not found at ${paths.evolutionBridgePath}`);
    }
    if (!existsSync(paths.stdioServerPath)) {
      throw new Error(`agent:run: ar-tools stdio server not found at ${paths.stdioServerPath}`);
    }
    mcpTmpDir = mkdtempSync(join(tmpdir(), "mcp-"));
    mcpConfigPath = join(mcpTmpDir, "mcp-config.json");
    const cfgOpts = opts.envelope?.mcpToolsSubset !== undefined
      ? { toolsSubset: opts.envelope.mcpToolsSubset }
      : {};
    const cfg = (attachArTools === "ar-tools-local")
      ? buildArToolsLocalMcpConfig(paths, cfgOpts)
      : buildArToolsMcpConfig(paths, cfgOpts);
    writeFileSync(mcpConfigPath, JSON.stringify(cfg), "utf8");
    // Legacy path only — under the envelope this is already set from the gate's
    // computed list and must not be widened back to the blanket 18 names.
    if (!opts.envelope) disallowedTools = buildClaudeDisallowedTools().join(",");
  }

  const args = buildClaudeArgs({
    skipPerms: opts.skipPerms,
    sessionId: opts.sessionId,
    model: opts.model,
    mcpConfigPath,
    disallowedTools,
  });

  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of NESTED_STRIP) delete env[k];
  if (opts.profileEnv) Object.assign(env, opts.profileEnv);

  const claudeBin = resolveClaudeBinary();
  // Genesis 67283abe: one automatic retry when the CLI exits but stdout is not
  // parseable JSON (envelope hiccup). Does NOT retry spawn failures, model
  // refusals that still emit valid JSON, or tool errors inside a parsed result.
  const MAX_PARSE_ATTEMPTS = 2; // first try + one retry
  const PARSE_RETRY_BACKOFF_MS = 400;

  return new Promise<ClaudeResult>((resolve, reject) => {
    /** Remove the MCP config temp file + its dir. Called only after the final
     *  attempt (success or give-up) so a parse-retry can reuse the same config. */
    const cleanupMcpTemp = () => {
      if (mcpConfigPath) { try { unlinkSync(mcpConfigPath); } catch { /* ok — may already be gone */ } }
      if (mcpTmpDir) { try { rmSync(mcpTmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
    };

    let attempt = 0;
    let lastStderr = "";
    let lastStdout = "";

    const spawnOnce = (): void => {
      attempt += 1;
      let stdout = "";
      let stderr = "";

      // posix: detached so killChildTree's negative-pgid is a real TREE kill (mirrors
      // core:exec). win32 relies on taskkill /T instead — do NOT detach (new console).
      const child = spawn(claudeBin, args, {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });

      // Register for orphan-sweep + cooperative cancel / runner timeout tree-kill.
      const commandSig = `${claudeBin} ${args.join(" ")}`;
      const unwire = wireAgentRunChild(child, commandSig, opts.childHooks ?? {});

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("error", (err) => {
        unwire();
        cleanupMcpTemp();
        // Spawn failures are not envelope hiccups — do not retry.
        reject(new Error(`agent:run: spawn failed: ${err.message}`));
      });

      child.on("close", () => {
        unwire();
        lastStdout = stdout;
        lastStderr = stderr;
        const parsed = parseClaudeEnvelope(stdout);
        if (parsed) {
          cleanupMcpTemp();
          return resolve(parsed);
        }
        if (attempt < MAX_PARSE_ATTEMPTS) {
          setTimeout(spawnOnce, PARSE_RETRY_BACKOFF_MS);
          return;
        }
        cleanupMcpTemp();
        const text = lastStdout.trim();
        reject(new Error(
          `agent:run: claude produced no parseable JSON` +
          (attempt > 1 ? ` after ${attempt} attempts` : "") +
          `${lastStderr ? ` — ${lastStderr.slice(0, 300)}` : text ? ` — ${text.slice(0, 300)}` : ""}`,
        ));
      });

      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    };

    spawnOnce();
  });
}

/** Parse `claude -p --output-format json` stdout into a ClaudeResult, or null. */
/** Build the error for a claude envelope that reported `is_error`, carrying the
 *  session handle when the CLI supplied one.
 *
 *  The CLI reports `session_id` ALONGSIDE `is_error`, so the resume handle exists
 *  at the exact instant we decide to fail — the same field the success path reads
 *  two lines below the throw. A bare `throw new Error(...)` dropped it, which is
 *  what made a deep-turn failure (a gauntlet dying at revise_2) unresumable: the
 *  completed turns were still on disk, but nothing recorded which session held
 *  them. Carrying it lets the failure receipt keep the handle, and the run store
 *  persists that receipt onto the failed node.
 *
 *  Exported as a pure fn for the same reason `claudeResultToUsage` and
 *  `parseClaudeEnvelope` are: the contract is unit-testable without spawning
 *  claude. genesis e7256b3e. */
export function claudeErrorFromResult(r: ClaudeResult): SessionBearingError {
  const err: SessionBearingError = new Error(
    `agent:run: claude reported an error (${r.subtype ?? "unknown"}): ${(r.result ?? "").slice(0, 300)}`,
  );
  // Genuinely optional, not a hidden invariant: the CLI can fail before any
  // session exists (auth rejected at startup), and an empty handle is not
  // resumable. Absent stays absent — never fabricated.
  if (r.session_id) err.agentSessionId = r.session_id;
  return err;
}

export function parseClaudeEnvelope(stdout: string): ClaudeResult | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as ClaudeResult;
  } catch {
    /* try trailing object — CLI sometimes prefixes noise */
  }
  const m = text.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      return JSON.parse(m[0]) as ClaudeResult;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve the grok binary — mirrors the grok-worker-loader.mjs logic. */
function resolveGrokBinary(): string {
  if (process.env.GROK_BIN) return process.env.GROK_BIN;
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      const candidate = join(userProfile, ".grok", "bin", "grok.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "grok";
}

/** Read the rare `usage`/`model` fields off a parsed grok NDJSON line, if present
 *  (mirrors grok-worker-loader.mjs's handling — the CLI emits usage inconsistently,
 *  so every field is optional; absence means the CLI didn't report it, not zero). */
function readGrokUsageEvent(obj: unknown, capture: { inputTokens?: number; outputTokens?: number; model?: string }): void {
  if (typeof obj !== "object" || obj === null) return;
  const o = obj as Record<string, unknown>;
  if (o.usage && typeof o.usage === "object") {
    const u = o.usage as Record<string, unknown>;
    const input = u.input_tokens ?? u.inputTokens;
    const output = u.output_tokens ?? u.outputTokens;
    if (typeof input === "number") capture.inputTokens = input;
    if (typeof output === "number") capture.outputTokens = output;
  }
  if (typeof o.model === "string") capture.model = o.model;
}

// ── The shared .grok gate (issue #660) ─────────────────────────────────────────
// Grok discovers project MCP servers ONLY at `<cwd>/.grok/config.toml` — verified
// against the installed grok 1.0.4: there is no --mcp-config equivalent flag or env,
// `--cwd` moves config discovery TOGETHER with the session cwd, and GROK_HOME
// relocates the whole grok home (auth.json + sessions), which would strand the
// worker's credentials and break the --resume contract. So the per-spawn mkdtemp
// isolation the claude path enjoys (`--mcp-config <tmp>`) is not available here, and
// two overlapping legs on one cwd would clobber the same file (different capability
// envelopes write different TOOLS subsets into it) — then the first finisher would
// unlink it out from under the survivor's still-running child. The gate below gives
// each ar-tools leg EXCLUSIVE ownership of that file for its child's whole lifetime:
// setup writes happen under the lock, teardown deletes only when no sibling leg can
// still be starting up, so no child ever reads a foreign subset and no finisher
// deletes a live sibling's config. Keyed on the RESOLVED cwd (fan-out siblings share
// the literal cwd input). In-process scope: two supervisors driving the same worktree
// sit outside this gate; runGrok's stage+rename write keeps even that worst case to
// last-writer-wins rather than a torn TOML.
interface SharedGrokConfigQueue {
  busy: boolean;
  waiters: Array<() => void>;
}
const sharedGrokConfigQueues = new Map<string, SharedGrokConfigQueue>();

/** Run `fn` while holding exclusive ownership of `<cwd>/.grok/config.toml` against
 *  every other agent:run grok leg in this process. FIFO per cwd; other cwds never
 *  contend. The queue entry is pruned when the last waiter leaves. */
async function withExclusiveGrokConfig<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(cwd);
  let queue = sharedGrokConfigQueues.get(key);
  if (!queue) {
    queue = { busy: false, waiters: [] };
    sharedGrokConfigQueues.set(key, queue);
  }
  const q = queue;
  // Queue behind BOTH a live holder and anyone already waiting — plain `busy` alone
  // would let an arrival overtake woken-but-not-yet-resumed waiters and break FIFO.
  if (q.busy || q.waiters.length > 0) {
    await new Promise<void>((waken) => { q.waiters.push(waken); });
  }
  q.busy = true;
  try {
    return await fn();
  } finally {
    q.busy = false;
    const waken = q.waiters.shift();
    if (waken) waken();
    else sharedGrokConfigQueues.delete(key);
  }
}

/** Spawn a one-shot `grok --prompt-file` in `cwd`, collect NDJSON, return text + sessionId. */
/** Spawn a one-shot `grok --prompt-file` in `cwd`, collect NDJSON, return text + sessionId.
 *  No process-level timeout — the task-graph engine's node.timeoutMs is the single authority. */
function runGrok(opts: {
  prompt: string;
  cwd: string;
  sessionId: string;
  model: string;
  skipPerms: boolean;
  tools?: string;
  /** Same envelope the claude path gets — WITHOUT this, deny-by-default would apply
   *  to claude only and the hole would simply move to grok. */
  envelope?: SpawnEnvelope;
  childHooks?: AgentRunChildHooks;
}): Promise<{ text: string; sessionId: string | null; usage: AgentRunUsage }> {
  const grokBin = resolveGrokBinary();

  // ── The envelope layer, grok side. Same inversion as runClaude: the deny-list is
  //    ALWAYS passed (via --disallowed-tools), and the ar-tools branch only decides
  //    whether to also write <cwd>/.grok/config.toml, which grok auto-discovers with
  //    no flag (grok-worker-loader.mjs:180-181). Validated up front (Honest Response). ──
  let toolFlags: string[] | undefined;

  const attachArTools: false | "ar-tools" | "ar-tools-local" = opts.envelope
    ? opts.envelope.attachArTools
    : (opts.tools === "ar-tools" || opts.tools === "ar-tools-local" ? opts.tools : false);

  if (opts.envelope) {
    toolFlags = buildGrokToolFlags(opts.envelope.disallowedTools, opts.envelope.granted.includes("web"));
  }

  const env: Record<string, string | undefined> = { ...process.env };
  const useShell = process.platform === "win32";

  const promptFile = join(tmpdir(), `grok-wf-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  let grokConfigPath: string | undefined;
  let grokDir: string | undefined;
  /** Staging file for the atomic config write; unlinked if a throw lands between
   *  writeFileSync and renameSync. */
  let grokStagePath: string | undefined;

  /** Remove the prompt temp file + the ar-tools .grok config (best-effort rmdir of
   *  the now-empty .grok dir). Called in BOTH close and error, and after any setup
   *  throw (#660: that throw used to leak the prompt file created moments earlier). */
  const cleanup = () => {
    try { unlinkSync(promptFile); } catch {}
    if (grokStagePath) { try { unlinkSync(grokStagePath); } catch {} }
    if (grokConfigPath) { try { unlinkSync(grokConfigPath); } catch {} }
    if (grokDir) { try { rmdirSync(grokDir); } catch {} }
  };

  const run = async (): Promise<{ text: string; sessionId: string | null; usage: AgentRunUsage }> => {
    try {
      writeFileSync(promptFile, opts.prompt, "utf8");

      if (attachArTools !== false) {
        const paths = resolveArToolsPaths(MONOREPO_ROOT);
        if (!existsSync(paths.evolutionBridgePath)) {
          throw new Error(`agent:run(grok): ar-tools evolution bridge not found at ${paths.evolutionBridgePath}`);
        }
        if (!existsSync(paths.stdioServerPath)) {
          throw new Error(`agent:run(grok): ar-tools stdio server not found at ${paths.stdioServerPath}`);
        }
        grokDir = join(opts.cwd, ".grok");
        mkdirSync(grokDir, { recursive: true });
        grokConfigPath = join(grokDir, "config.toml");
        const cfgOpts = opts.envelope?.mcpToolsSubset !== undefined
          ? { toolsSubset: opts.envelope.mcpToolsSubset }
          : {};
        const toml = (attachArTools === "ar-tools-local")
          ? buildGrokLocalConfigToml(paths, cfgOpts)
          : buildGrokConfigToml(paths, cfgOpts);
        // Stage-then-rename: a reader outside this process's gate (another supervisor on
        // the same worktree) can never observe a half-written TOML — rename over an
        // existing destination is atomic on every filesystem Node supports.
        grokStagePath = `${grokConfigPath}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(grokStagePath, toml, "utf8");
        renameSync(grokStagePath, grokConfigPath);
        grokStagePath = undefined;
        // Legacy path only — under the envelope toolFlags is already the gate's list.
        if (!opts.envelope) toolFlags = buildGrokToolFlags();
      }

      const args = buildGrokArgs({
        skipPerms: opts.skipPerms,
        promptFile,
        model: opts.model,
        sessionId: opts.sessionId,
        toolFlags,
      });

      return await new Promise((resolve, reject) => {
        // posix detached for process-group tree-kill (same as runClaude / core:exec).
        // win32 uses shell + taskkill /T — no detached.
        const child = spawn(grokBin, args, {
          cwd: opts.cwd,
          env,
          shell: useShell,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });

        const commandSig = `${grokBin} ${args.join(" ")}`;
        const unwire = wireAgentRunChild(child, commandSig, opts.childHooks ?? {});

        let stdoutBuf = "";
        let assembledText = "";
        let sessionId: string | null = opts.sessionId || null;
        const capturedUsage: { inputTokens?: number; outputTokens?: number; model?: string } = {};

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString("utf8");
          const lines = stdoutBuf.split("\n");
          stdoutBuf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === "text" && typeof obj.data === "string") assembledText += obj.data;
              if (obj.type === "end" && obj.sessionId) sessionId = obj.sessionId;
              readGrokUsageEvent(obj, capturedUsage);
            } catch { /* not JSON — stray progress */ }
          }
        });

        child.on("error", (err) => {
          unwire();
          cleanup();
          reject(new Error(`agent:run(grok): spawn failed: ${err.message}`));
        });

        child.on("close", (code) => {
          unwire();
          cleanup();
          if (stdoutBuf.trim()) {
            try {
              const obj = JSON.parse(stdoutBuf.trim());
              if (obj.type === "text" && typeof obj.data === "string") assembledText += obj.data;
              if (obj.type === "end" && obj.sessionId) sessionId = obj.sessionId;
              readGrokUsageEvent(obj, capturedUsage);
            } catch {}
          }
          if (code !== 0 && !assembledText) {
            reject(new Error(`agent:run(grok): exited with code ${code}`));
          } else {
            // Honest-absent: the grok CLI rarely reports usage at all (see readGrokUsageEvent) —
            // only `model` is guaranteed, falling back to what was requested.
            const usage: AgentRunUsage = { model: capturedUsage.model || opts.model || "grok" };
            if (capturedUsage.inputTokens !== undefined) usage.inputTokens = capturedUsage.inputTokens;
            if (capturedUsage.outputTokens !== undefined) usage.outputTokens = capturedUsage.outputTokens;
            resolve({ text: assembledText.trim() || "(empty response from grok)", sessionId, usage });
          }
        });
      });
    } catch (err) {
      // Setup threw before a child existed (missing bridge path, read-only cwd, …) —
      // the close/error handlers above never ran, so reclaim what setup created
      // instead of leaking it (#660), then surface the original error untouched.
      cleanup();
      throw err;
    }
  };

  // Only an ar-tools leg touches the shared <cwd>/.grok/config.toml — a plain grok leg
  // has no shared state and must not serialize behind one another.
  return attachArTools !== false ? withExclusiveGrokConfig(opts.cwd, run) : run();
}

export const agentRunNodes: NodeDef[] = [
  defineNode({
    type: "agent:run",
    description:
      "Spawn an EPHEMERAL agent in a given cwd with a prompt; returns { sessionId, reply, usage? } — " +
      "usage carries per-model token/cost data when the runtime reported it (optional-honest, never fabricated). " +
      "Supports multiple runtimes via the `runtime` param: 'claude' (default) or 'grok'. " +
      "Unlike agent:ask (which whispers a PRE-EXISTING named live agent), this spawns a fresh, session-scoped " +
      "worker isolated to the cwd — the worktree-scoped coder/reviewer primitive. Pass `sessionId` to --resume a " +
      "prior turn so the worker carries its history across a loop. Inputs: prompt (req), cwd (req), runtime? " +
      "(default 'claude'), sessionId?, model?, tier? (resolves model via tier-resolver.ts; explicit model " +
      "always wins), skipPermissions? (default true), tools? — set to 'ar-tools' (or 'ar-tools-local' without web_fetch) to give the worker the fleet's " +
      "AgentRuntime MCP toolset (file/shell/grep/vitals via the evolution bridge); this ALSO disallows the " +
      "conflicting built-ins (Bash/Read/Write/…) so every call flows through MCP. Absent → unchanged (built-ins, " +
      "no MCP). Not compatible with a tier that dispatches to a non-anthropic provider. " +
      "conventions? — set to 'off' to skip convention injection (default 'auto': auto-injects " +
      "CLAUDE.md + referenced skill docs scoped to the cwd before the prompt). " +
      "workerProfile? — borrow a cartridge's upstream route for this worker (e.g. 'kimi-1' runs " +
      "k3 via traffic-mirror): the profile's allowlisted env (base URL, scoped token, model " +
      "pins) is read server-side from its workspace.json and merged into THIS spawn only — " +
      "never logged, never in argv, claude runtime only. " +
      "schema? — a JSON Schema (as a JSON STRING). When set, the reply must validate against " +
      "it: on failure the specific validation errors are fed back and the agent retries in the " +
      "SAME session (instructor pattern), up to schemaRetries (default 3). The validated object " +
      "is returned as `structured` — read it via {{nodes.<id>.result.structured.<field>}} — and " +
      "`reply` carries the same JSON as text. Use this instead of parsing a leading token out of " +
      "prose: a fail-closed parser is a dead end in an autonomous loop with no human to re-ask. " +
      "schemaRetries? — attempts before giving up (default 3). " +
      "skills? — set to 'auto-match' to auto-select skills from .skill-index/index.json by " +
      "task text (embedding if Ollama present, lexical fallback otherwise); or a comma-separated " +
      "list of repo-root-relative paths for explicit skill injection. skillMatchMode is logged " +
      "when auto-match fires ('embedding', 'lexical', or 'none'). " +
      "preset? — a named shape from the node kit (src/workflows/node-presets.ts): 'reasoner' " +
      "(no tools), 'scout' (fs.read), 'researcher' (fs.read,web), 'verifier' (fs.read,shell), " +
      "'builder' (fs.read,fs.write,shell), plus .observed / .observed-local variants that route " +
      "calls through ar-tools for audit. A preset SUPPLIES capabilities/observe/tools — declaring " +
      "a preset AND any of them together THROWS, so a definition can never claim one envelope and " +
      "run another. Prefer a preset: it is reviewable in the panel, an inline string is not. " +
      "capabilities? — DENY-BY-DEFAULT worker envelope: a comma-separated string of the verbs " +
      "this worker may use ('fs.read', 'fs.write', 'shell', 'web'). OMITTED MEANS NO FILE, SHELL, " +
      "OR WEB TOOLS AT ALL — a pure-text reasoner. Everything not granted is passed to the CLI as " +
      "--disallowedTools, so the worker literally lacks the verb. An unknown verb throws. " +
      "observe? — default false. false routes granted verbs through the CLI's built-ins (fast, no " +
      "MCP child). true routes them through the ar-tools MCP server so the evolution bridge " +
      "observes every call (required for any bond-bearing node — built-in calls are NOT " +
      "observable); requires tools:'ar-tools'.",
    run: async ({ inputs, caps, correlationId, nodeId }) => {
      const runtime = inputs.str("runtime", { default: "claude" });
      const prompt = inputs.str("prompt", { required: true });
      const cwd = inputs.str("cwd", { required: true });
      const sessionId = inputs.str("sessionId");
      const model = inputs.str("model");
      const skipPerms = inputs.bool("skipPermissions", { default: true });
      const workerProfile = inputs.str("workerProfile");
      const conventions = inputs.str("conventions", { default: "auto" });

      // ── Worker envelope (rung 2): deny-by-default capabilities ────────────
      // `capabilities` is a COMMA-SEPARATED STRING read via inputs.str and split
      // exactly like the `skills` field below — the inputs contract exposes
      // str/num/bool/obj/has/raw and NO .arr (contract.ts:239-252), so an array
      // input would be a fabrication. Absent ⇒ {caps:[], declared:false}: a valid,
      // maximally-restricted worker plus a loud audit line, never silent breakage.
      //
      // A `preset` names a reviewable shape from the kit (node-presets.ts) and
      // SUPPLIES capabilities/observe/tools rather than annotating them: declaring
      // both a preset and an inline grant throws, so a definition can never claim
      // one envelope and run another. Resolved BEFORE the tools validation below,
      // because a preset supplies `tools` too and an unknown value must be rejected
      // wherever it came from. inputs.has() distinguishes "not written" from
      // "written empty" — the latter is a real deny-everything grant, not absence.
      const declaredConfig: DeclaredNodeConfig = {
        preset: inputs.has("preset") ? inputs.str("preset") : undefined,
        capabilities: inputs.has("capabilities") ? inputs.str("capabilities") : undefined,
        observe: inputs.has("observe") ? inputs.bool("observe") : undefined,
        tools: inputs.has("tools") ? inputs.str("tools") : undefined,
      };
      const resolvedConfig = resolveNodeConfig(declaredConfig);
      const tools = resolvedConfig.tools;
      const observe = resolvedConfig.observe;

      // Only "ar-tools" is a known toolset. Reject an unknown non-empty value loudly
      // rather than silently ignoring it (Honest Response).
      if (tools && tools !== "ar-tools" && tools !== "ar-tools-local") {
        throw new Error(`agent:run: unknown tools "${tools}" (supported: ar-tools, ar-tools-local)`);
      }

      const capabilitiesRaw = resolvedConfig.capabilities;
      const capSet = parseCapabilities(capabilitiesRaw, observe);

      // ── Convention injection (all runtime paths) ──────────────────────────
      // `skills` is either "auto-match" (match task text against .skill-index)
      // or a comma-separated list of repo-root-relative paths injected on top
      // of the cwd-auto bundle. Empty string / absent = no explicit skills.
      const skillsRaw = inputs.has("skills") ? inputs.str("skills") : "";
      const isAutoMatch = skillsRaw === "auto-match";
      const explicitSkills = (!isAutoMatch && skillsRaw)
        ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      // ── Structured output (instructor pattern) ────────────────────────────
      // `schema` is a JSON Schema as a STRING, because every node input in this
      // engine is a scalar and a workflow definition carries it as JSON text.
      // Absent = the ordinary free-text path, unchanged.
      let structuredSchema: Record<string, unknown> | undefined;
      if (inputs.has("schema")) {
        const raw = inputs.str("schema").trim();
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw);
            // Validate at the boundary — a malformed schema must fail HERE, before a
            // spawn is paid for, not as a confusing validation error N attempts later.
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new Error("schema must be a JSON object");
            }
            structuredSchema = parsed as Record<string, unknown>;
          } catch (err) {
            throw new Error(`agent:run: "schema" is not a valid JSON Schema object — ${(err as Error).message}`);
          }
        }
      }
      const schemaRetries = inputs.has("schemaRetries") ? inputs.num("schemaRetries") : 3;
      let structuredData: Record<string, unknown> | undefined;
      let structuredAttempts: number | undefined;

      let effectivePrompt = prompt;
      let bundle: ConventionBundle | undefined;
      if (conventions !== "off") {
        bundle = await caps.conventions.resolve(cwd, prompt);

        let skillsToMerge = explicitSkills;
        let skillMatchMode: string | undefined;
        if (isAutoMatch) {
          const { autoMatch } = await import("../conventions/auto-match.js");
          const matchResult = await autoMatch(prompt, MONOREPO_ROOT);
          skillsToMerge = matchResult.paths;
          skillMatchMode = matchResult.mode;
        }

        if (skillsToMerge.length > 0) {
          const { mergeExplicitSkills } = await import("../conventions/resolve.js");
          bundle = mergeExplicitSkills(bundle, skillsToMerge, MONOREPO_ROOT);
        }
        if (!bundle.empty) {
          const { formatConventionsPreamble } = await import("../conventions/resolve.js");
          effectivePrompt = formatConventionsPreamble(bundle) + "\n\n---\n\n" + prompt;
          caps.log("info", "conventions_injected", {
            cwd,
            package: bundle.resolvedPackageDir,
            count: bundle.matched.length,
            paths: bundle.matched.map((m) => m.path),
            explicitSkills: skillsToMerge.length > 0 ? skillsToMerge : undefined,
            skillMatchMode: skillMatchMode ?? undefined,
          });
        } else {
          caps.log("info", "conventions_empty", { cwd, package: bundle.resolvedPackageDir });
        }
      }

      // ── Tier resolution (additive — explicit model always wins) ──
      const tierName = inputs.has("tier") ? inputs.str("tier") : "";
      let effectiveModel = model;

      if (tierName) {
        if (runtime !== "claude") {
          throw new Error(
            `agent:run: tier "${tierName}" resolves to an anthropic-backed model — only usable with ` +
              `runtime "claude" (got runtime "${runtime}")`,
          );
        }
        const resolved = resolveTier(tierName);
        if (resolved.providerType !== "anthropic") {
          // The dispatch path spawns no claude/grok worker, so it can't carry an ar-tools
          // MCP config. Refuse loudly instead of silently dropping the tools request.
          if (tools) {
            throw new Error(
              `agent:run: tools "${tools}" is not supported on the tier-dispatch path — tier "${tierName}" ` +
                `resolves to provider "${resolved.providerType}" (not anthropic), which agent:run dispatches ` +
                `without spawning a claude/grok worker (no MCP config). Use runtime "claude" or "grok" with an explicit model.`,
            );
          }
          caps.log("info", "agent_run_start", { runtime: "dispatch", cwd, tier: tierName });
          const out = await dispatch(tierName, effectivePrompt, { timeout: resolved.timeout || undefined });
          caps.log("info", "agent_run_done", { runtime: "dispatch", session: null, replyLen: String(out.result).length });
          return { sessionId: null, reply: String(out.result), isError: false };
        }
        if (!model) effectiveModel = resolved.model;
      }

      // ── Worker profile (alternate upstream, e.g. k3 via traffic-mirror) ──
      // Resolved AFTER tier resolution and BEFORE the EM seam, so the executor
      // key the seam matches on is the model the worker will ACTUALLY run
      // (the profile's ANTHROPIC_MODEL when no explicit model was given).
      let profileEnv: Record<string, string> | undefined;
      /** Compaction / traffic-mirror container key for this spawn (observability). */
      let mirrorAgent: string | undefined;
      if (workerProfile) {
        if (runtime !== "claude") {
          throw new Error(
            `agent:run: workerProfile "${workerProfile}" is claude-transport only (the profile supplies an ` +
              `anthropic-compatible upstream route); got runtime "${runtime}"`,
          );
        }
        profileEnv = resolveWorkerProfileEnv(workerProfile, MONOREPO_ROOT);
        if (!effectiveModel && profileEnv.ANTHROPIC_MODEL) effectiveModel = profileEnv.ANTHROPIC_MODEL;
        mirrorAgent = `${workerProfile}@worker`;
      } else if (runtime === "claude" && correlationId && nodeId) {
        // No seat profile: still label the spawn on traffic-mirror so compaction
        // can key a stream per in-flight node (hollow-combat a2 etc.). Upstream
        // falls through to the mirror's global Anthropic UPSTREAM when the lane
        // name has no workspace.json. Formula: ephemeralMirrorAgent(corr, node).
        mirrorAgent = ephemeralMirrorAgent(correlationId, nodeId);
        profileEnv = {
          ANTHROPIC_BASE_URL: ephemeralMirrorBaseUrl(correlationId, nodeId),
        };
        caps.log("info", "ephemeral_mirror_lane", {
          mirrorAgent,
          baseUrl: profileEnv.ANTHROPIC_BASE_URL,
        });
      }

      // ── Experience-memory corrections (Slice-5 seam — additive, promoted-only) ──
      // effectivePrompt/effectiveModel are FINAL here: the prospective signature
      // keys on what will actually be dispatched. Corrections prepend AHEAD of the
      // conventions preamble (most task-relevant content first). The cap resolves
      // honest-empty on any failure, so a broken EM store can never fail a dispatch.
      // An unpinned model ("" → CLI default) skips resolution entirely: mined
      // records carry CONCRETE model stamps, so "unknown" could never legitimately
      // match — resolving anyway would couple matches to shared ignorance.
      if (effectiveModel) {
        const taskFamily = inputs.str("taskFamily") || nodeId || "agent-run";
        const corr = await caps.corrections.resolve({
          taskFamily,
          packageDir: cwd,
          runtime,
          model: effectiveModel,
          promptSketch: prompt, // the raw task text, not the boilerplate-wrapped prompt
        });
        if (!corr.empty) {
          effectivePrompt = corr.preamble + "\n\n---\n\n" + effectivePrompt;
          caps.log("info", "corrections_injected", {
            cwd,
            taskFamily,
            count: corr.count,
            matchMode: corr.matchMode,
          });
        } else {
          caps.log("info", "corrections_empty", { cwd, matchMode: corr.matchMode });
        }
      } else {
        caps.log("info", "corrections_empty", { cwd, matchMode: "none", reason: "model_unpinned" });
      }

      caps.log("info", "agent_run_start", { runtime, cwd, resume: sessionId ? sessionId.slice(0, 8) : null, tools: tools || null, profile: workerProfile || null, preset: resolvedConfig.preset ?? null, capabilities: capabilitiesRaw || null });

      // ── THE GATE. Every spawn passes through admitSpawn and leaves with the
      //    envelope it will run inside: the argv deny-list (always set), the TOOLS
      //    subset for the MCP child, and a locked (null) bond. The audit line is
      //    written HERE, supervisor-side — the worker has no handle to it, which is
      //    what makes it usable as the substrate for a capability-escape proof. ──
      const escrow = new NullEscrow(caps.log);
      let envelope: SpawnEnvelope | undefined;
      if (workerEnvelopeEnabled()) {
        envelope = admitSpawn({
          set: capSet,
          tools,
          runtime,
          nodeId: nodeId ?? "agent-run",
          correlationId: correlationId ?? "",
          escrow,
          log: caps.log,
        });
      } else {
        caps.log("warn", "spawn_gate_disabled", {
          nodeId,
          correlationId,
          hint: "WORKER_ENVELOPE_V1 is off — this worker keeps every built-in (Bash included) unless it opted into ar-tools. Unset the flag to restore deny-by-default.",
        });
      }

      // Child registration + cooperative cancel (mirrors core:exec). Runner also
      // tree-kills on engine timeout via the recorded exec pid (PR0 / e7256b3e).
      const childHooks: AgentRunChildHooks = {
        correlationId,
        nodeId,
        recordChild: caps.run.recordChild,
        clearChild: caps.run.clearChild,
        signal: correlationId ? caps.run.signal(correlationId) : undefined,
      };

      let result: { text: string; sessionId: string | null; usage?: AgentRunUsage };

      /** One spawn attempt. Extracted so the schema path can call it repeatedly —
       *  the ONLY difference between the two paths is how many times this runs. */
      const spawnOnce = async (
        promptText: string,
        sess: string,
      ): Promise<{ text: string; sessionId: string | null; usage?: AgentRunUsage }> => {
        if (runtime === "grok") {
          return await runGrok({ prompt: promptText, cwd, sessionId: sess, model: effectiveModel, skipPerms, tools, envelope, childHooks });
        }
        if (runtime === "opencode") {
          return await runOpencode({ prompt: promptText, cwd, sessionId: sess, model: effectiveModel, skipPerms, childHooks });
        }
        if (runtime === "claude") {
          const r = await runClaude({ prompt: promptText, cwd, sessionId: sess, model: effectiveModel, skipPerms, tools, envelope, childHooks, profileEnv });
          if (r.is_error) throw claudeErrorFromResult(r);
          return { text: r.result ?? "", sessionId: r.session_id ?? null, usage: claudeResultToUsage(r, effectiveModel) };
        }
        throw new Error(`agent:run: unknown runtime "${runtime}" (supported: claude, grok, opencode)`);
      };

      // Bond lifecycle: locked before the spawn (in admitSpawn), released on a
      // clean return, refunded on ANY throw — including an engine timeout, which
      // surfaces here as a rejection from the tree-killed child. A spawn must never
      // leave a bond locked with no exit taken.
      //
      // NOTE on the schema path: retries happen INSIDE one bond. A node is one
      // admission and one bond regardless of how many attempts the schema loop
      // needs — the alternative (a bond per attempt) would make a validation retry
      // indistinguishable from a fresh spawn to the escrow ledger.
      try {
        if (structuredSchema) {
          // Instructor pattern: validate against the schema and, on failure, feed the
          // SPECIFIC validation errors back for another attempt. This exists because a
          // fail-closed parser (review:verdict) is a dead end in an autonomous loop —
          // it correctly refuses to guess at malformed output, but with no human to ask,
          // "unreadable" must be RECOVERABLE rather than terminal. Observed live: a grok
          // judge replied with prose starting "I", the verdict node refused it, and the
          // whole goal loop stopped with the work already done.
          let curSession = sessionId;
          let lastUsage: AgentRunUsage | undefined;
          const sg = await structuredGenerate(
            async ({ prompt: attemptPrompt }) => {
              // Resume the same session across attempts so the model can see its own
              // prior (rejected) answer alongside the errors — that context is most of
              // why the retry succeeds.
              const r = await spawnOnce(attemptPrompt, curSession);
              curSession = r.sessionId ?? curSession;
              lastUsage = r.usage;
              return r.text;
            },
            { schema: structuredSchema, prompt: effectivePrompt, maxRetries: schemaRetries },
          );
          structuredData = sg.data;
          structuredAttempts = sg.attempts;
          result = { text: JSON.stringify(sg.data), sessionId: curSession, usage: lastUsage };
        } else {
          result = await spawnOnce(effectivePrompt, sessionId);
        }
      } catch (err) {
        if (envelope) escrow.refund(envelope.bond);
        if (err instanceof StructuredOutputError) {
          // Honest Response: name the actual failure. "Model could not produce output
          // matching the schema after N attempts" is actionable; a bare parse error is not.
          throw new Error(
            `agent:run: schema validation failed after ${schemaRetries} attempt(s) — ${err.message}`,
          );
        }
        throw err;
      }
      if (envelope) escrow.release(envelope.bond, "rung2-no-preimage");

      caps.log("info", "agent_run_done", { runtime, session: result.sessionId ? result.sessionId.slice(0, 8) : null, replyLen: result.text.length });

      // Rich self-enrich: capture assembled-prompt hash + conventions after run.
      // Uses the exact effectivePrompt sent to the model (E2 — assembled scope).
      // fillOnly: false so this receipt wins over the generic auto-mint from toHandler.
      if (correlationId && nodeId) {
        const rStr = runtime as string;
        const effectiveRuntime: "claude" | "grok" | "opencode" | "dispatch" =
          rStr === "grok" ? "grok" : rStr === "opencode" ? "opencode" : rStr === "dispatch" ? "dispatch" : "claude";
        const richReceipt: InferenceReceipt = {
          v: 1, kind: "infer", nodeId, nodeType: "agent:run", at: Date.now(),
          completeness: result.usage ? "rich" : "thin",
          runtime: effectiveRuntime,
          sessionId: result.sessionId ?? null,
          promptSha256: sha256(effectivePrompt),
          promptScope: "assembled",
          replyChars: result.text.length,
        };
        if (result.usage) {
          richReceipt.usage = result.usage;
          if (result.usage.model) richReceipt.model = result.usage.model;
        }
        // ── Independence provenance (invariant #3) ──────────────────────────
        // `effectiveModel` is the pin that was DISPATCHED (explicit param, else the
        // profile's ANTHROPIC_MODEL), resolved above. It is config we wrote, which is
        // why familyOf keys on it rather than on usage.model — the latter is telemetry
        // from the very path being measured, and is absent whenever usage is. Both are
        // recorded: config as the key, telemetry beside it as corroboration (they have
        // agreed on the real runs checked so far, so a disagreement is worth noticing).
        //
        // routeHost/accountId come from the profile env for a borrowed route, and
        // from process env for a native leg. routeIdentityFromEnv returns only a host
        // and a domain-separated digest — the token is read and discarded in-frame,
        // never logged (the 2026-07-19 fleet-poisoning lesson) and never persisted.
        if (effectiveModel) richReceipt.modelConfigured = effectiveModel;
        if (workerProfile) richReceipt.workerProfile = workerProfile;
        if (mirrorAgent) richReceipt.mirrorAgent = mirrorAgent;
        const routeIdentity = routeIdentityFromEnv(profileEnv ?? process.env);
        if (routeIdentity.routeHost) richReceipt.routeHost = routeIdentity.routeHost;
        if (routeIdentity.accountId) richReceipt.accountId = routeIdentity.accountId;
        if (bundle && !bundle.empty) {
          if (bundle.resolvedPackageDir) richReceipt.conventionsPackage = bundle.resolvedPackageDir;
          richReceipt.conventionPaths = bundle.matched.map((m) => m.path);
        }
        caps.receipt.capture(correlationId, nodeId, richReceipt);
      }

      // `structured` is the validated object — read it as {{nodes.x.result.structured.field}}.
      // `reply` stays populated (the JSON as text) so every existing consumer is unaffected.
      // `mirrorAgent` is the traffic-mirror/compaction container key for this spawn.
      return {
        sessionId: result.sessionId ?? sessionId,
        reply: result.text,
        isError: false,
        usage: result.usage,
        ...(mirrorAgent ? { mirrorAgent } : {}),
        ...(structuredData ? { structured: structuredData, schemaAttempts: structuredAttempts } : {}),
      };
    },
  }),
];
